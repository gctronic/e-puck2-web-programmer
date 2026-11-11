// Tab 2: ESP32 radio module, programmed with esptool-js through the
// "Serial Monitor" port of the e-puck2 programmer.
// Equivalent of program_esp32.sh:
//   esptool.py --chip esp32 --baud 115200 --before default_reset --after hard_reset
//     write_flash -z --flash_mode dio --flash_freq 40m --flash_size detect
//     0x1000 bootloader.bin 0x10000 ESP32_E-Puck_2.bin 0x8000 partitions_singleapp.bin

import {
  ESPLoader,
  FlashFreqValues,
  FlashModeValues,
  FlashSizeValues,
  IEspLoaderTerminal,
  Transport,
} from "esptool-js";
import { RadioFirmware, downloadAll, loadManifest, versionText } from "./catalog";
import { formatSize, hex32 } from "./firmware";
import { bindSourceSwitch, forceLocal, renderMeta, showListError } from "./sourceUi";
import { md5 } from "./md5";
import { PART_SIZE, splitImages, writeParts } from "./espWriter";
// Other tools compared on the robot (see README, "ESP32 flashing tools: test results"); to compare
// them again, uncomment these imports, the dispatch in flash() and the #esp-tool select in index.html.
// import { flashWithEspWebFlasher } from "./espWebFlasher";
// import { flashWithTasmota } from "./espTasmota";
import legacyStub from "./stubs/esp32-legacy.json";

/** Flashing tool. Only "rom" is offered (the #esp-tool select is commented out in index.html). */
export type EspTool = "rom" | "legacy-stub" | "esp-web-flasher" | "tasmota";
import { $, Logger, Progress, bindDropZone, errorMessage, escapeHtml, parseAddress, runExclusive, sleep } from "./ui";

const PROGRAMMER_FILTER = { usbVendorId: 0x1d50, usbProductId: 0x6018 };
const ROM_BAUD = 115200;

interface ImageRow {
  label: string;
  offset: string;
  file: File | null;
}

const DEFAULT_ROWS: ImageRow[] = [
  { label: "Bootloader", offset: "0x1000", file: null },
  { label: "Partition table", offset: "0x8000", file: null },
  { label: "Application", offset: "0x10000", file: null },
];

/** Guess the role of a .bin file from its name (e-puck2 / ESP-IDF naming). */
function classify(name: string): number {
  const n = name.toLowerCase();
  if (n.includes("bootloader")) return 0;
  if (n.includes("partition")) return 1;
  return 2;
}

export function initEsp32() {
  const root = $("#tab-esp32");
  const log = new Logger($(".log", root));
  const progress = new Progress($(".progress", root));
  const btn = $<HTMLButtonElement>(".btn-program", root);
  const clearBtn = $<HTMLButtonElement>(".btn-clear", root);
  const rowsEl = $(".image-rows", root);
  const addBtn = $<HTMLButtonElement>(".btn-add-row", root);
  const modeInputs = [...root.querySelectorAll<HTMLInputElement>("input[name=esp-mode]")];
  const separatePane = $(".mode-separate", root);
  const mergedPane = $(".mode-merged", root);
  const mergedInfo = $(".merged-info", root);
  const mergedOffset = $<HTMLInputElement>("#esp-merged-offset", root);
  const baudSel = $<HTMLSelectElement>("#esp-baud", root);
  const baudCustom = $<HTMLInputElement>("#esp-baud-custom", root);
  const flashMode = $<HTMLSelectElement>("#esp-flash-mode", root);
  const flashFreq = $<HTMLSelectElement>("#esp-flash-freq", root);
  const flashSize = $<HTMLSelectElement>("#esp-flash-size", root);
  const eraseAll = $<HTMLInputElement>("#esp-erase-all", root);
  const verify = $<HTMLInputElement>("#esp-verify", root);
  const toolSel = root.querySelector<HTMLSelectElement>("#esp-tool"); // commented out in index.html
  const trace = $<HTMLInputElement>("#esp-trace", root);
  const blockPause = $<HTMLInputElement>("#esp-block-pause", root);
  const advanced = $<HTMLFieldSetElement>("#esp-advanced", root);
  const advancedEdit = $<HTMLInputElement>("#esp-advanced-edit", root);

  // Advanced options are locked (greyed out) by default; unlocking enables editing,
  // locking again restores the defaults written in the HTML.
  advancedEdit.addEventListener("change", () => {
    const edit = advancedEdit.checked;
    advanced.disabled = !edit;
    advanced.classList.toggle("locked", !edit);
    if (!edit) {
      for (const el of advanced.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")) {
        if (el === advancedEdit) continue;
        if (el instanceof HTMLSelectElement) {
          for (const o of el.options) o.selected = o.defaultSelected;
        } else if (el.type === "checkbox") {
          el.checked = el.defaultChecked;
        } else {
          el.value = el.defaultValue;
        }
        el.dispatchEvent(new Event("change"));
      }
    }
  });

  let rows: ImageRow[] = DEFAULT_ROWS.map((r) => ({ ...r }));
  let mergedFile: File | null = null;

  const mode = () => (modeInputs.find((i) => i.checked)?.value ?? "separate") as "separate" | "merged";

  // ---- Official firmware: the robot version (2.0/2.1 or 2.2 with PSRAM) must be chosen explicitly.
  const hwInputs = [...root.querySelectorAll<HTMLInputElement>("input[name=esp-hw]")];
  const fwSelect = $<HTMLSelectElement>("#esp-fw", root);
  const fwMeta = $(".fw-meta", root);
  let radio: RadioFirmware[] = [];
  let listError = false;
  const hardware = () => hwInputs.find((i) => i.checked)?.value as RadioFirmware["hardware"] | undefined;
  const forHardware = () => radio.filter((e) => e.hardware === hardware());
  const selected = () => forHardware()[fwSelect.selectedIndex] ?? null;

  function refreshOfficial() {
    if (listError) return;
    const list = forHardware();
    fwSelect.disabled = !hardware();
    fwSelect.innerHTML = hardware()
      ? list.map((e, i) => `<option>${escapeHtml(`${e.label} ${versionText(e)}`)}${i === 0 ? " — latest" : ""}</option>`).join("")
      : `<option>Choose the robot version first</option>`;
    showMeta();
  }
  function showMeta() {
    const e = selected();
    renderMeta(fwMeta, e, e ? e.images.map((i) => i.file) : []);
    updateButton();
  }
  hwInputs.forEach((i) => i.addEventListener("change", refreshOfficial));
  fwSelect.addEventListener("change", showMeta);

  const source = bindSourceSwitch(root, "esp", () => updateButton());

  function updateButton() {
    if (source() === "official") btn.disabled = !selected();
    else btn.disabled = mode() === "merged" ? !mergedFile : !rows.some((r) => r.file);
  }

  loadManifest()
    .then((m) => {
      radio = m.radio;
      refreshOfficial();
    })
    .catch((e) => {
      listError = true;
      showListError(fwMeta, errorMessage(e));
      forceLocal(root, "esp");
    });

  function renderRows() {
    rowsEl.innerHTML = "";
    rows.forEach((row, i) => {
      const tr = document.createElement("div");
      tr.className = "image-row";
      tr.innerHTML = `
        <input class="row-label" type="text" value="${escapeHtml(row.label)}" aria-label="Image name">
        <label class="row-file ${row.file ? "has-file" : ""}">
          <input type="file" accept=".bin" hidden>
          <span>${row.file ? escapeHtml(row.file.name) + ` <em>${formatSize(row.file.size)}</em>` : "Choose .bin…"}</span>
        </label>
        <input class="row-offset mono" type="text" value="${escapeHtml(row.offset)}" aria-label="Flash offset" spellcheck="false">
        <button class="icon-btn row-remove" title="Remove" aria-label="Remove image">✕</button>`;
      const labelIn = $<HTMLInputElement>(".row-label", tr);
      const fileIn = $<HTMLInputElement>("input[type=file]", tr);
      const offIn = $<HTMLInputElement>(".row-offset", tr);
      labelIn.addEventListener("input", () => (row.label = labelIn.value));
      offIn.addEventListener("input", () => {
        row.offset = offIn.value;
        try {
          parseAddress(offIn.value);
          offIn.classList.remove("invalid");
        } catch {
          offIn.classList.add("invalid");
        }
      });
      fileIn.addEventListener("change", () => {
        row.file = fileIn.files?.[0] ?? null;
        renderRows();
      });
      // Drop a file on a row to assign it to that row (several files: auto-assign by name).
      tr.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.stopPropagation();
        tr.classList.add("drag");
      });
      tr.addEventListener("dragleave", (e) => {
        if (!tr.contains(e.relatedTarget as Node)) tr.classList.remove("drag");
      });
      tr.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        tr.classList.remove("drag");
        const files = [...(e.dataTransfer?.files ?? [])];
        if (files.length === 1) {
          row.file = files[0];
          renderRows();
        } else if (files.length > 1) assignByName(files);
      });
      $(".row-remove", tr).addEventListener("click", () => {
        if (row.file) row.file = null;
        else rows.splice(i, 1);
        renderRows();
      });
      rowsEl.appendChild(tr);
    });
    updateButton();
  }

  addBtn.addEventListener("click", () => {
    rows.push({ label: "Image", offset: "0x0", file: null });
    renderRows();
  });

  function assignByName(files: File[]) {
    for (const f of files) {
      const idx = classify(f.name);
      const def = DEFAULT_ROWS[idx];
      let row = rows.find((r) => r.label === def.label);
      if (!row) {
        row = { ...def };
        rows.push(row);
      }
      row.file = f;
    }
    renderRows();
  }

  bindDropZone($(".dropzone-separate", root), $<HTMLInputElement>("#esp-multi-input", root), assignByName);

  // Dropping on the table (outside a row) also auto-assigns by file name.
  const table = $(".image-table", root);
  table.addEventListener("dragover", (e) => {
    e.preventDefault();
    table.classList.add("drag");
  });
  table.addEventListener("dragleave", (e) => {
    if (!table.contains(e.relatedTarget as Node)) table.classList.remove("drag");
  });
  table.addEventListener("drop", (e) => {
    e.preventDefault();
    table.classList.remove("drag");
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) assignByName(files);
  });

  bindDropZone($(".dropzone-merged", root), $<HTMLInputElement>("#esp-merged-input", root), (files) => {
    mergedFile = files[0];
    mergedInfo.innerHTML = `<div class="file-name">${escapeHtml(mergedFile.name)}</div><div class="file-meta">${formatSize(mergedFile.size)}</div>`;
    updateButton();
  });

  for (const m of modeInputs) {
    m.addEventListener("change", () => {
      separatePane.hidden = mode() !== "separate";
      mergedPane.hidden = mode() !== "merged";
      updateButton();
    });
  }

  baudSel.addEventListener("change", () => {
    baudCustom.hidden = baudSel.value !== "custom";
    if (!baudCustom.hidden) baudCustom.focus();
  });

  clearBtn.addEventListener("click", () => log.clear());
  renderRows();

  btn.addEventListener("click", () =>
    runExclusive([btn, addBtn], async () => {
      log.clear();
      progress.reset();
      try {
        const baud = baudSel.value === "custom" ? parseInt(baudCustom.value, 10) : parseInt(baudSel.value, 10);
        if (!Number.isFinite(baud) || baud < 9600) throw new Error("Invalid baud rate");

        let images: { name: string; address: number; data: Uint8Array }[];
        if (source() === "official") {
          const entry = selected();
          if (!entry) return;
          log.info(`Firmware: ${entry.label} ${versionText(entry)} for e-puck ${entry.hardware.replace("-", " / ")}`);
          const files = await downloadAll(
            entry.images.map((i) => i.file),
            (f) => progress.set("Downloading", f),
          );
          images = [];
          for (let i = 0; i < files.length; i++) {
            images.push({
              name: files[i].name,
              address: parseAddress(entry.images[i].offset),
              data: new Uint8Array(await files[i].arrayBuffer()),
            });
          }
        } else if (mode() === "merged") {
          images = [
            { name: mergedFile!.name, address: parseAddress(mergedOffset.value), data: new Uint8Array(await mergedFile!.arrayBuffer()) },
          ];
        } else {
          images = [];
          for (const r of rows.filter((r) => r.file)) {
            images.push({ name: r.file!.name, address: parseAddress(r.offset), data: new Uint8Array(await r.file!.arrayBuffer()) });
          }
          if (rows.some((r) => !r.file)) log.warn("Some image rows have no file and will be skipped");
        }
        images.sort((a, b) => a.address - b.address);
        for (let i = 1; i < images.length; i++) {
          if (images[i - 1].address + images[i - 1].data.length > images[i].address) {
            throw new Error(`Images "${images[i - 1].name}" and "${images[i].name}" overlap`);
          }
        }

        await flash(images, log, progress, {
          baud,
          flashMode: flashMode.value as FlashModeValues,
          flashFreq: flashFreq.value as FlashFreqValues,
          flashSize: flashSize.value as FlashSizeValues,
          eraseAll: eraseAll.checked,
          verify: verify.checked,
          tool: (toolSel?.value ?? "rom") as EspTool,
          trace: trace.checked,
          blockPause: Math.max(0, parseInt(blockPause.value, 10) || 0),
        });
      } catch (e) {
        progress.fail("Failed");
        log.error("✖ " + errorMessage(e));
      }
    }),
  );
}

interface FlashSettings {
  baud: number;
  flashMode: FlashModeValues;
  flashFreq: FlashFreqValues;
  flashSize: FlashSizeValues;
  eraseAll: boolean;
  verify: boolean;
  tool: EspTool;
  trace: boolean;
  /** Pause after each flash block, in ms. */
  blockPause: number;
}

const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Upload and start the older ESP32 flasher stub (esptool v3 generation, taken from esp-web-flasher)
 * with esptool-js. The stub bundled with esptool-js does not start through the e-puck2 bridge
 * (its "OHAI" greeting arrives garbled), while esptool.py with this older stub works.
 */
async function runLegacyStub(loader: ESPLoader) {
  const block = loader.ESP_RAM_BLOCK;
  for (const [b64, start] of [
    [legacyStub.text, legacyStub.text_start],
    [legacyStub.data, legacyStub.data_start],
  ] as [string, number][]) {
    const data = fromBase64(b64);
    const blocks = Math.ceil(data.length / block);
    await loader.memBegin(data.length, blocks, block, start);
    for (let seq = 0; seq < blocks; seq++) await loader.memBlock(data.slice(seq * block, (seq + 1) * block), seq);
  }
  await loader.memFinish(legacyStub.entry);
  const greeting = String.fromCharCode(...(await loader.transport.read(3000)));
  if (greeting !== "OHAI") throw new Error(`unexpected answer "${greeting}"`);
  loader.IS_STUB = true;
  loader.FLASH_WRITE_SIZE = 0x4000;
}

/**
 * Same as ESPLoader.main(), adapted to the e-puck2 serial bridge. Returns the flash size to use
 * (e.g. "8MB"), or the requested value if it cannot be determined.
 */
async function connectLoader(
  loader: ESPLoader,
  transport: Transport,
  log: Logger,
  useLegacyStub: boolean,
  baud: number,
  flashSize: FlashSizeValues,
): Promise<FlashSizeValues> {
  await loader.detectChip("default_reset");
  const chip = loader.chip;
  if (!/^ESP32$/.test(chip.CHIP_NAME)) log.warn(`Expected an ESP32, found ${chip.CHIP_NAME}`);

  if (!loader.secureDownloadMode) {
    loader.info("Chip is " + (await chip.getChipDescription(loader)));
    loader.info("Features: " + (await chip.getChipFeatures(loader)));
    loader.info("MAC: " + (await chip.readMac(loader)));
    if (chip.CHIP_NAME === "ESP32") {
      // Diagnostic: the ROM auto-detects the line speed and stores the UART divider.
      // ESP32 modules on the e-puck2 use a 40 MHz crystal.
      const div = (await loader.readReg(0x3ff40014)) & 0xfffff;
      if (div > 0) {
        const lineBaud = Math.round(40e6 / div);
        log.dim(`ROM measured the serial line at ≈${lineBaud} baud (UART divider ${div})`);
        // The e-puck2 programmer bridge appears to drive the ESP32 UART at its own rate,
        // regardless of the rate requested by the host.
        if (Math.abs(lineBaud - ROM_BAUD) / ROM_BAUD > 0.1 && baud !== ROM_BAUD) {
          if (Math.abs(lineBaud - baud) / baud > 0.1) {
            log.warn(
              `The programmer's serial bridge runs at ≈${lineBaud} baud, not at the requested ${ROM_BAUD}. ` +
                `Switching the ESP32 to ${baud} baud will probably fail: keep 115200 or use a rate close to ${lineBaud}.`,
            );
          }
        }
      }
    }
  }

  if (useLegacyStub) {
    try {
      await runLegacyStub(loader);
      log.info("Legacy flasher stub running (esptool v3 generation)");
    } catch (e) {
      log.warn(`Legacy flasher stub did not start (${errorMessage(e)}). Falling back to the ROM loader…`);
      try {
        await transport.disconnect();
      } catch {
        /* ignore */
      }
      await sleep(200);
      loader.IS_STUB = false;
      await loader.connect("default_reset", 7, false);
      log.info("Connected to the ROM loader (no stub)");
    }
  } else {
    log.info("Using the ROM loader (no stub)");
  }

  if (baud !== ROM_BAUD) await loader.changeBaud();

  if (!loader.IS_STUB) {
    // The ROM loader does not enable the SPI flash by itself (esptool.py --no-stub does the same).
    // The ESP32 ROM expects 8 bytes (hspi_arg + is_legacy), esptool-js only sends the 4-byte stub form.
    log.dim("Enabling default SPI flash mode…");
    await loader.checkCommand("configure SPI flash pins", loader.ESP_SPI_ATTACH, new Uint8Array(8));
    // The ROM accepts 1 KB flash blocks (esptool.py ESP32ROM.FLASH_WRITE_SIZE); esptool-js
    // always uses the stub size (16 KB), which the ROM rejects with status 1,5.
    loader.FLASH_WRITE_SIZE = 0x400;
    // The ROM answers SPI_FLASH_MD5 with 32 ASCII hex characters (the stub with 16 raw bytes);
    // esptool-js hex-encodes both, so decode the ROM form back, like esptool.py does.
    const md5sum = loader.flashMd5sum.bind(loader);
    loader.flashMd5sum = async (addr: number, size: number) => {
      const res = await md5sum(addr, size);
      if (loader.IS_STUB || res.length !== 64) return res;
      const ascii = res.replace(/../g, (h) => String.fromCharCode(parseInt(h, 16)));
      return /^[0-9a-f]{32}$/i.test(ascii) ? ascii.toLowerCase() : res;
    };
  }

  const flashId = await loader.readFlashId();
  loader.info("Flash ID: " + flashId.toString(16));
  if (flashId === 0xffffff || flashId === 0) throw new Error("Cannot communicate with the flash chip");

  // The loader assumes a 2 MB flash and the ROM refuses to erase beyond it (status 1,6), so tell
  // it the real size like esptool.py flash_set_parameters(): SPI_SET_PARAMS with
  // id, total size, 64 KB block, 4 KB sector, 256 B page, status mask 0xFFFF.
  let sizeBytes = 0;
  const chosen = /^(\d+)MB$/.exec(flashSize);
  if (chosen) sizeBytes = parseInt(chosen[1], 10) * 1024 * 1024;
  else {
    const sizeId = (flashId >> 16) & 0xff; // e.g. 0x17 -> 8 MB
    if (sizeId >= 0x12 && sizeId <= 0x1a) sizeBytes = 2 ** sizeId;
  }
  if (!sizeBytes) {
    log.warn("Unknown flash size: the loader may refuse to write beyond 2 MB");
    return flashSize;
  }
  const params = new Uint8Array(24);
  const dv = new DataView(params.buffer);
  [0, sizeBytes, 0x10000, 0x1000, 0x100, 0xffff].forEach((v, i) => dv.setUint32(i * 4, v, true));
  await loader.checkCommand("set SPI params", 0x0b, params);
  const size = `${sizeBytes / (1024 * 1024)}MB` as FlashSizeValues;
  log.dim(`Flash size: ${sizeBytes / (1024 * 1024)} MB`);
  return size;
}

async function flash(
  images: { name: string; address: number; data: Uint8Array }[],
  log: Logger,
  progress: Progress,
  opt: FlashSettings,
) {
  if (!("serial" in navigator)) throw new Error("Web Serial is not available in this browser");

  // if (opt.tool === "tasmota") {
  //   log.info("Tool: tasmota-webserial-esptool 9.4.2 (Jason2866)");
  //   await flashWithTasmota(images, log, progress, {
  //     filter: PROGRAMMER_FILTER,
  //     baud: opt.baud,
  //     eraseAll: opt.eraseAll,
  //     verify: opt.verify,
  //     trace: opt.trace,
  //     blockPause: opt.blockPause,
  //   });
  //   progress.done("Done");
  //   log.ok("✔ ESP32 programmed successfully");
  //   return;
  // }
  //
  // if (opt.tool === "esp-web-flasher") {
  //   log.info("Tool: esp-web-flasher 5.1.5 (Nabu Casa), legacy flasher stub");
  //   await flashWithEspWebFlasher(images, log, progress, {
  //     filter: PROGRAMMER_FILTER,
  //     baud: opt.baud,
  //     eraseAll: opt.eraseAll,
  //     verify: opt.verify,
  //     trace: opt.trace,
  //     blockPause: opt.blockPause,
  //   });
  //   progress.done("Done");
  //   log.ok("✔ ESP32 programmed successfully");
  //   return;
  // }

  log.info(
    opt.tool === "legacy-stub"
      ? "Tool: esptool-js with the legacy flasher stub (esptool v3 generation)"
      : "Tool: esptool-js with the ESP32 ROM loader",
  );

  log.info("Select the “Serial Monitor” port of the e-puck2 programmer…");
  const port = await navigator.serial.requestPort({ filters: [PROGRAMMER_FILTER] });
  const transport = new Transport(port, false);

  // While the parts are written, esptool-js per-part messages are summarised by this page
  // (unless the serial trace is on).
  let quiet = false;
  const QUIET = /^(Writing at 0x|Compressed |Took |Wrote |File  md5|Flash md5|Hash of data verified|Configuring flash size|Auto-detected Flash size|Detected flash size|Flash params set|Leaving\.\.\.)/;
  const terminal: IEspLoaderTerminal = {
    clean: () => log.clear(),
    writeLine: (d) => {
      if (!opt.trace && (d.startsWith("Writing at 0x") || (quiet && QUIET.test(d)))) return;
      log.dim(d);
    },
    write: (d) => {
      if (!quiet || opt.trace) log.write(d);
    },
  };

  const loader = new ESPLoader({
    transport,
    baudrate: opt.baud,
    romBaudrate: ROM_BAUD,
    terminal,
    debugLogging: false,
  });

  // Through the e-puck2 programmer bridge, sending the next block as soon as the previous one
  // is acknowledged makes the ROM loader receive a corrupted block (status 1,5) after a while.
  // A short pause after each block avoids it (with the serial trace on, the trace itself slowed
  // the host down enough).
  if (opt.blockPause > 0) {
    const pause = opt.blockPause;
    const deflBlock = loader.flashDeflBlock.bind(loader);
    const plainBlock = loader.flashBlock.bind(loader);
    loader.flashDeflBlock = async (data: Uint8Array, seq: number, timeout: number) => {
      await deflBlock(data, seq, timeout);
      await sleep(pause);
    };
    loader.flashBlock = async (data: Uint8Array, seq: number, timeout: number) => {
      await plainBlock(data, seq, timeout);
      await sleep(pause);
    };
  }

  if (opt.trace) {
    transport.tracing = true;
    transport.trace = (m: string) => log.dim("TRACE " + m);
  }

  try {
    progress.set("Connecting", 0);
    const connect = () => connectLoader(loader, transport, log, opt.tool === "legacy-stub", opt.baud, opt.flashSize);
    let flashSize = await connect();

    if (opt.eraseAll) {
      if (loader.IS_STUB) {
        log.info("Erasing the entire flash…");
        progress.set("Erasing", 0);
        await loader.eraseFlash();
      } else {
        log.warn("Erasing the entire flash needs the flasher stub: skipped, only the image areas are erased");
      }
    }

    const parts = splitImages(images);
    for (const img of images) {
      const n = parts.filter((p) => p.name === img.name && p.address >= img.address && p.address < img.address + img.data.length).length;
      log.info(
        `  ${hex32(img.address)}  ${img.name} (${formatSize(img.data.length)})` +
          (n > 1 ? ` in ${n} parts of ${formatSize(PART_SIZE)}` : ""),
      );
    }
    if (!opt.verify) log.warn("Verification is off: corrupted parts may go unnoticed");

    const t0 = performance.now();
    quiet = true;
    const result = await writeParts({
      loader,
      parts,
      flash: {
        flashMode: opt.flashMode,
        flashFreq: opt.flashFreq,
        flashSize,
        compress: true,
        calculateMD5Hash: opt.verify ? md5 : undefined,
      },
      drain: () => transport.drainInput(),
      reconnect: async () => {
        quiet = false;
        log.info("Reconnecting to the ESP32…");
        try {
          await transport.disconnect();
        } catch {
          /* ignore */
        }
        await sleep(300);
        flashSize = await connect();
        quiet = true;
      },
      onProgress: (written, total, part) => progress.set(`Writing ${part.name}`, written / total),
      onPartDone: (part, index, count, ms) =>
        log.dim(
          `  ✓ ${String(index + 1).padStart(String(count).length)}/${count}  ${hex32(part.address)}  ` +
            `${part.name} ${formatSize(part.data.length)} in ${(ms / 1000).toFixed(1)} s` +
            (opt.verify ? ", MD5 ok" : ""),
        ),
      onRetry: (part, attempt, error, action) =>
        log.warn(
          `${hex32(part.address)}: ${error} — writing this part again` +
            (action === "reconnect" ? " after reconnecting" : "") +
            ` (retry ${attempt})`,
        ),
    });
    quiet = false;
    const secs = (performance.now() - t0) / 1000;
    const totalBytes = images.reduce((a, i) => a + i.data.length, 0);
    log.ok(
      `Wrote ${formatSize(totalBytes)} in ${secs.toFixed(0)} s` +
        (opt.verify ? ", every part verified (MD5)" : "") +
        (result.retries ? ` — ${result.retries} part(s) written again` : ""),
    );

    log.info("Resetting the ESP32 (hard reset)…");
    await loader.after("hard_reset");
    progress.done("Done");
    log.ok("✔ ESP32 programmed successfully");
  } finally {
    try {
      await transport.disconnect();
    } catch {
      /* ignore */
    }
  }
}
