// Tab 1: STM32F407 main processor, programmed through the GDB server
// (Black Magic Probe) exposed by the STM32F413 programmer.

import { MainFirmware, downloadFirmware, loadManifest, versionText } from "./catalog";
import { FirmwareImage, Segment, formatSize, hex32, loadFirmware, totalSize } from "./firmware";
import { bindSourceSwitch, forceLocal, renderMeta, showListError } from "./sourceUi";
import { FlashRegion, GdbClient, gdbCrc32 } from "./gdb";
import { $, Logger, Progress, bindDropZone, errorMessage, escapeHtml, parseAddress, runExclusive } from "./ui";

const PROGRAMMER_FILTER = { usbVendorId: 0x1d50, usbProductId: 0x6018 };
// Used when the probe does not provide a memory map.
const F407_FLASH_FALLBACK: FlashRegion[] = [
  { start: 0x08000000, length: 0x10000, blockSize: 0x4000 },
  { start: 0x08010000, length: 0x10000, blockSize: 0x10000 },
  { start: 0x08020000, length: 0xe0000, blockSize: 0x20000 },
];

export function initF407() {
  const root = $("#tab-f407");
  const log = new Logger($(".log", root));
  const progress = new Progress($(".progress", root));
  const fileInfo = $(".file-info", root);
  const binBaseRow = $(".bin-base-row", root);
  const binBase = $<HTMLInputElement>("#f407-base", root);
  const verify = $<HTMLInputElement>("#f407-verify", root);
  const reset = $<HTMLInputElement>("#f407-reset", root);
  const trace = $<HTMLInputElement>("#f407-trace", root);
  const btn = $<HTMLButtonElement>(".btn-program", root);
  const clearBtn = $<HTMLButtonElement>(".btn-clear", root);

  const fwSelect = $<HTMLSelectElement>("#f407-fw", root);
  const fwMeta = $(".fw-meta", root);

  let file: File | null = null;
  let image: FirmwareImage | null = null;
  let official: MainFirmware[] = [];

  const updateButton = () => {
    btn.disabled = source() === "official" ? official.length === 0 : !image;
  };
  const source = bindSourceSwitch(root, "f407", () => updateButton());

  const selected = () => official[fwSelect.selectedIndex] ?? null;
  const showMeta = () => renderMeta(fwMeta, selected(), selected() ? [selected()!.file] : []);
  fwSelect.addEventListener("change", showMeta);
  loadManifest()
    .then((m) => {
      official = m.main;
      fwSelect.innerHTML = official
        .map((e, i) => `<option>${escapeHtml(`${e.label} ${versionText(e)}`)}${i === 0 ? " — latest" : ""}</option>`)
        .join("");
      showMeta();
      updateButton();
    })
    .catch((e) => {
      showListError(fwMeta, errorMessage(e));
      forceLocal(root, "f407");
    });

  async function refreshImage() {
    image = null;
    updateButton();
    if (!file) {
      fileInfo.innerHTML = "";
      binBaseRow.hidden = true;
      return;
    }
    try {
      const base = parseAddress(binBase.value);
      image = await loadFirmware(file, base);
      binBaseRow.hidden = image.format !== "bin";
      const segs = image.segments
        .map((s) => `<li><code>${hex32(s.address)}</code> – ${formatSize(s.data.length)}</li>`)
        .join("");
      fileInfo.innerHTML =
        `<div class="file-name">${escapeHtml(file.name)} <span class="tag">${image.format.toUpperCase()}</span></div>` +
        `<div class="file-meta">${formatSize(totalSize(image.segments))} in ${image.segments.length} segment(s)` +
        (image.entry !== undefined ? `, entry ${hex32(image.entry)}` : "") +
        `</div><ul class="segments">${segs}</ul>`;
      updateButton();
    } catch (e) {
      fileInfo.innerHTML = `<div class="file-error">${escapeHtml(errorMessage(e))}</div>`;
    }
  }

  bindDropZone($(".dropzone", root), $<HTMLInputElement>("input[type=file]", root), (files) => {
    file = files[0];
    void refreshImage();
  });
  binBase.addEventListener("change", () => void refreshImage());
  clearBtn.addEventListener("click", () => log.clear());

  btn.addEventListener("click", () =>
    runExclusive([btn], async () => {
      log.clear();
      progress.reset();
      try {
        let img = image;
        if (source() === "official") {
          const entry = selected();
          if (!entry) return;
          log.info(`Firmware: ${entry.label} ${versionText(entry)}`);
          const f = await downloadFirmware(entry.file, (l, t) => progress.set("Downloading", t ? l / t : 0));
          img = await loadFirmware(f, entry.address ? parseAddress(entry.address) : 0x08000000);
        }
        if (!img) return;
        await program(img, log, progress, {
          verify: verify.checked,
          reset: reset.checked,
          trace: trace.checked,
        });
      } catch (e) {
        progress.fail("Failed");
        log.error("✖ " + errorMessage(e));
      }
    }),
  );
}

interface Options {
  verify: boolean;
  reset: boolean;
  trace: boolean;
}

/** Erase ranges aligned to the flash block layout (as gdb does). */
function eraseRanges(segments: Segment[], regions: FlashRegion[]): { start: number; length: number }[] {
  const blocks = new Set<number>();
  const blockEnd = new Map<number, number>();
  for (const s of segments) {
    const end = s.address + s.data.length;
    for (const r of regions) {
      const rEnd = r.start + r.length;
      if (end <= r.start || s.address >= rEnd) continue;
      const from = Math.max(s.address, r.start);
      const to = Math.min(end, rEnd);
      let b = r.start + Math.floor((from - r.start) / r.blockSize) * r.blockSize;
      for (; b < to; b += r.blockSize) {
        blocks.add(b);
        blockEnd.set(b, b + r.blockSize);
      }
    }
  }
  const sorted = [...blocks].sort((a, b) => a - b);
  const ranges: { start: number; length: number }[] = [];
  for (const b of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && last.start + last.length === b) last.length += blockEnd.get(b)! - b;
    else ranges.push({ start: b, length: blockEnd.get(b)! - b });
  }
  return ranges;
}

/** Contiguous flash spans: the memory map splits the flash in regions with different block sizes. */
function flashSpans(regions: FlashRegion[]): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  for (const r of [...regions].sort((a, b) => a.start - b.start)) {
    const last = spans[spans.length - 1];
    if (last && last.end === r.start) last.end = r.start + r.length;
    else spans.push({ start: r.start, end: r.start + r.length });
  }
  return spans;
}

/** "full" if the segment lies entirely in flash, "none" if entirely outside, "partial" otherwise. */
export function flashCoverage(s: Segment, regions: FlashRegion[]): "full" | "none" | "partial" {
  const end = s.address + s.data.length;
  for (const sp of flashSpans(regions)) {
    if (s.address >= sp.start && end <= sp.end) return "full";
    if (s.address < sp.end && end > sp.start) return "partial";
  }
  return "none";
}

async function program(image: FirmwareImage, log: Logger, progress: Progress, opt: Options) {
  if (!("serial" in navigator)) throw new Error("Web Serial is not available in this browser");

  log.info("Select the “GDB Server” port of the e-puck2 programmer…");
  const port = await navigator.serial.requestPort({ filters: [PROGRAMMER_FILTER] });
  const gdb = new GdbClient(port);
  gdb.onConsole = (t) => t.split("\n").forEach((l) => l.trim() && log.dim("  " + l.replace(/\r/g, "")));
  if (opt.trace) gdb.onTrace = (t) => log.dim(t);

  await gdb.open();
  try {
    progress.set("Connecting", 0);
    await gdb.handshake();
    log.info(`Connected to GDB server (packet size ${gdb.packetSize} bytes)`);

    log.info("Scanning SWD bus (monitor swdp_scan)…");
    const scan = await gdb.monitor("swdp_scan");
    if (/fail/i.test(scan)) {
      throw new Error("No target found on the SWD bus. Is the robot switched on?");
    }
    if (!/^\s*1\s/m.test(scan)) log.warn("Target 1 not listed by swdp_scan, trying to attach anyway…");

    log.info("Attaching to target 1…");
    await gdb.attach(1);

    let regions = await gdb.memoryMap();
    if (!regions || regions.length === 0) {
      log.warn("Probe did not report a memory map, using the STM32F407 default layout");
      regions = F407_FLASH_FALLBACK;
    }

    const flashSegs: Segment[] = [];
    for (const s of image.segments) {
      const cov = flashCoverage(s, regions);
      if (cov === "full") flashSegs.push(s);
      else if (cov === "partial") {
        throw new Error(`Segment at ${hex32(s.address)} (${formatSize(s.data.length)}) does not fit in the flash memory`);
      } else log.warn(`Skipping segment at ${hex32(s.address)} (not in flash)`);
    }
    if (flashSegs.length === 0) throw new Error("The firmware contains no data for the flash memory");

    // Erase
    const ranges = eraseRanges(flashSegs, regions);
    const eraseTotal = ranges.reduce((a, r) => a + r.length, 0);
    let erased = 0;
    for (const r of ranges) {
      log.info(`Erasing ${hex32(r.start)} – ${hex32(r.start + r.length - 1)} (${formatSize(r.length)})…`);
      progress.set("Erasing", erased / eraseTotal);
      await gdb.flashErase(r.start, r.length);
      erased += r.length;
      progress.set("Erasing", erased / eraseTotal);
    }

    // Write
    const total = totalSize(flashSegs);
    let done = 0;
    const t0 = performance.now();
    for (const s of flashSegs) {
      log.info(`Writing ${formatSize(s.data.length)} at ${hex32(s.address)}…`);
      await gdb.flashWrite(s.address, s.data, (w) => progress.set("Writing", (done + w) / total));
      done += s.data.length;
    }
    await gdb.flashDone();
    const secs = (performance.now() - t0) / 1000;
    log.ok(`Wrote ${formatSize(total)} in ${secs.toFixed(1)} s (${formatSize(total / secs)}/s)`);

    // Verify
    if (opt.verify) {
      progress.set("Verifying", 0);
      let checked = 0;
      for (const s of flashSegs) {
        const remote = await gdb.crc(s.address, s.data.length);
        if (remote === null) {
          log.warn("Probe does not support qCRC, verifying by reading memory back…");
          for (let off = 0; off < s.data.length; off += 256) {
            const n = Math.min(256, s.data.length - off);
            const rd = await gdb.readMemory(s.address + off, n);
            for (let i = 0; i < n; i++) {
              if (rd[i] !== s.data[off + i]) throw new Error(`Verify failed at ${hex32(s.address + off + i)}`);
            }
            progress.set("Verifying", (checked + off + n) / total);
          }
        } else if (remote !== gdbCrc32(s.data)) {
          throw new Error(`Verify failed: CRC mismatch in segment ${hex32(s.address)}`);
        }
        checked += s.data.length;
        progress.set("Verifying", checked / total);
      }
      log.ok("Verify OK");
    }

    if (opt.reset) {
      log.info("Resetting the STM32F407…");
      await gdb.killAndReset();
    } else {
      await gdb.detach();
    }
    progress.done("Done");
    log.ok("✔ STM32F407 programmed successfully");
  } finally {
    await gdb.close();
  }
}
