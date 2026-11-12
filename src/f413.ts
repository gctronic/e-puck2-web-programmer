// Tab 3: STM32F413 programmer firmware, written through the STM32 ROM DFU bootloader (WebUSB).

import { DfuseDevice, F413_LAYOUT, L452_LAYOUT } from "./dfu";
import { ProgrammerFirmware, downloadFirmware, loadManifest, versionText } from "./catalog";
import { FirmwareImage, coalesceSegments, formatSize, hex32, loadFirmware, totalSize } from "./firmware";
import { bindSourceSwitch, forceLocal, renderMeta, showListError } from "./sourceUi";

type Chip = ProgrammerFirmware["chip"];
const CHIP_NAME: Record<Chip, string> = {
  f413: "STM32F413 (robot ID < 5400)",
  l452: "STM32L452 (robot ID ≥ 5400)",
};
import { $, Logger, Progress, bindDropZone, errorMessage, escapeHtml, parseAddress, runExclusive } from "./ui";

export function initF413() {
  const root = $("#tab-f413");
  const log = new Logger($(".log", root));
  const progress = new Progress($(".progress", root));
  const fileInfo = $(".file-info", root);
  const binBaseRow = $(".bin-base-row", root);
  const binBase = $<HTMLInputElement>("#f413-base", root);
  const verify = $<HTMLInputElement>("#f413-verify", root);
  const leave = $<HTMLInputElement>("#f413-leave", root);
  const btn = $<HTMLButtonElement>(".btn-program", root);
  const clearBtn = $<HTMLButtonElement>(".btn-clear", root);

  const fwSelect = $<HTMLSelectElement>("#f413-fw", root);
  const fwMeta = $(".fw-meta", root);
  const chipHint = $(".fw-chip-hint", root);
  const variantInputs = [...root.querySelectorAll<HTMLInputElement>("input[name=dfu-variant]")];

  let file: File | null = null;
  let image: FirmwareImage | null = null;
  let programmer: ProgrammerFirmware[] = [];
  let listError = false;

  // The official firmware follows the robot version chosen in the DFU guide (F413 / L452).
  const chip = () => (variantInputs.find((i) => i.checked)?.value ?? "f413") as Chip;
  const forChip = () => programmer.filter((e) => e.chip === chip());
  const selected = () => forChip()[fwSelect.selectedIndex] ?? null;

  const updateButton = () => {
    btn.disabled = source() === "official" ? !selected() : !image;
  };
  const source = bindSourceSwitch(root, "f413", () => updateButton());

  function refreshOfficial() {
    if (listError) return;
    fwSelect.innerHTML = forChip()
      .map((e, i) => `<option>${escapeHtml(`${e.label} ${versionText(e)}`)}${i === 0 ? " — latest" : ""}</option>`)
      .join("");
    chipHint.textContent = `For ${CHIP_NAME[chip()]}, as selected in the DFU guide above.`;
    showMeta();
  }
  function showMeta() {
    const e = selected();
    renderMeta(fwMeta, e, e ? [e.file] : []);
    updateButton();
  }
  fwSelect.addEventListener("change", showMeta);
  variantInputs.forEach((i) => i.addEventListener("change", refreshOfficial));
  loadManifest()
    .then((m) => {
      programmer = m.programmer;
      refreshOfficial();
    })
    .catch((e) => {
      listError = true;
      showListError(fwMeta, errorMessage(e));
      forceLocal(root, "f413");
    });

  async function refreshImage() {
    image = null;
    updateButton();
    if (!file) return;
    try {
      image = await loadFirmware(file, parseAddress(binBase.value));
      binBaseRow.hidden = image.format !== "bin";
      const segs = image.segments
        .map((s) => `<li><code>${hex32(s.address)}</code> – ${formatSize(s.data.length)}</li>`)
        .join("");
      fileInfo.innerHTML =
        `<div class="file-name">${escapeHtml(file.name)} <span class="tag">${image.format.toUpperCase()}</span></div>` +
        `<div class="file-meta">${formatSize(totalSize(image.segments))} in ${image.segments.length} segment(s)</div>` +
        `<ul class="segments">${segs}</ul>`;
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
        let expected: Chip | null = null;
        if (source() === "official") {
          const entry = selected();
          if (!entry) return;
          expected = entry.chip;
          log.info(`Firmware: ${entry.label} ${versionText(entry)} for ${CHIP_NAME[entry.chip]}`);
          const f = await downloadFirmware(entry.file, (l, t) => progress.set("Downloading", t ? l / t : 0));
          img = await loadFirmware(f, entry.address ? parseAddress(entry.address) : 0x08000000);
        }
        if (!img) return;
        await program(img, log, progress, verify.checked, leave.checked, expected, chip());
      } catch (e) {
        progress.fail("Failed");
        const msg = errorMessage(e);
        log.error("✖ " + msg);
        if (/Access denied|Unable to claim|SecurityError/i.test(msg)) {
          log.warn(
            "The browser cannot access the device. On Windows install the WinUSB driver with Zadig; " +
              "on Linux add the udev rule shown in the help section.",
          );
        }
      }
    }),
  );
}

async function program(
  image: FirmwareImage,
  log: Logger,
  progress: Progress,
  verify: boolean,
  leave: boolean,
  expected: Chip | null,
  guideChip: Chip,
) {
  if (!("usb" in navigator)) throw new Error("WebUSB is not available in this browser");

  log.info("Select “STM32 BOOTLOADER” (DFU mode)…");
  const dfu = await DfuseDevice.request();
  dfu.log = (t) => log.dim(t);
  try {
    progress.set("Connecting", 0);
    // If the bootloader does not report its memory layout, assume the chip selected in the DFU guide.
    const assumed: Chip = expected ?? guideChip;
    await dfu.open(assumed === "l452" ? L452_LAYOUT : F413_LAYOUT);
    log.info(`Connected: ${dfu.description}`);
    const flashSize = dfu.layout.sectors.reduce((a, x) => a + x.size, 0);
    let detected: Chip | null = null;
    if (dfu.layoutReported) {
      detected = flashSize === 512 * 1024 ? "l452" : flashSize === 1536 * 1024 ? "f413" : null;
      log.info(`Flash ${formatSize(flashSize)}` + (detected ? ` → ${CHIP_NAME[detected]}` : ""));
    } else {
      log.warn(
        `The bootloader did not report its memory layout: assuming ${CHIP_NAME[assumed]}, as selected in the DFU guide.`,
      );
    }
    if (expected && detected && expected !== detected) {
      throw new Error(
        `This firmware is for ${CHIP_NAME[expected]} but the connected programmer is ${CHIP_NAME[detected]}. ` +
          "Select the right robot version in the DFU guide.",
      );
    }
    log.dim(`Transfer size ${dfu.transferSize} bytes`);
    await dfu.abortToIdle();

    // Fill small gaps between segments and pad to 8 bytes (the STM32L4 writes 64-bit double words).
    image = { ...image, segments: coalesceSegments(image.segments) };

    // Erase only the sectors covered by the image.
    const sectors = image.segments.flatMap((s) => dfu.sectorsFor(s.address, s.data.length));
    const unique = [...new Map(sectors.map((s) => [s.start, s])).values()].sort((a, b) => a.start - b.start);
    log.info(`Erasing ${unique.length} sector(s) (${formatSize(unique.reduce((a, s) => a + s.size, 0))})…`);
    progress.set("Erasing", 0);
    await dfu.erase(unique, (d, t) => progress.set("Erasing", d / t));

    // Write
    const total = totalSize(image.segments);
    let done = 0;
    const t0 = performance.now();
    for (const s of image.segments) {
      log.info(`Writing ${formatSize(s.data.length)} at ${hex32(s.address)}…`);
      await dfu.write(s.address, s.data, (w) => progress.set("Writing", (done + w) / total));
      done += s.data.length;
    }
    const secs = (performance.now() - t0) / 1000;
    log.ok(`Wrote ${formatSize(total)} in ${secs.toFixed(1)} s`);

    // Verify
    if (verify) {
      let checked = 0;
      for (const s of image.segments) {
        const rd = await dfu.read(s.address, s.data.length, (r) => progress.set("Verifying", (checked + r) / total));
        for (let i = 0; i < rd.length; i++) {
          if (rd[i] !== s.data[i]) throw new Error(`Verify failed at ${hex32(s.address + i)}`);
        }
        checked += s.data.length;
      }
      log.ok("Verify OK");
    }

    if (leave) {
      const start = image.segments[0].address;
      log.info(`Leaving DFU mode, starting firmware at ${hex32(start)}…`);
      await dfu.leave(start);
    } else {
      log.info("Device left in DFU mode. Unplug/replug the robot to run the new firmware.");
    }
    progress.done("Done");
    log.ok("✔ Programmer firmware updated successfully");
  } finally {
    await dfu.close();
  }
}
