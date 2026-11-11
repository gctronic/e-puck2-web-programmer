// ESP32 programming with tasmota-webserial-esptool (Jason2866), an actively maintained library
// independent from esptool-js (fork of Adafruit WebSerial ESPTool). Offered for comparison.
//
// It ships the same ESP32 flasher stub as esptool-js, which does not start through the e-puck2
// bridge; in that case this falls back to the ROM loader. In ROM mode the library neither attaches
// the SPI flash before a compressed write nor sets the flash size, so both are done here, like the
// verification (MD5). Images are written whole, with the library's own flow (no 64 KB parts).

import { md5 } from "./md5";
import { formatSize, hex32 } from "./firmware";
import { Logger, Progress, errorMessage, sleep } from "./ui";

const ROM_BAUD = 115200;
const ESP_SPI_SET_PARAMS = 0x0b;
const ESP_SPI_ATTACH = 0x0d;
const ESP_SPI_FLASH_MD5 = 0x13;
const ESP_FLASH_DEFL_BEGIN = 0x10;

export interface TasmotaOptions {
  filter: SerialPortFilter;
  baud: number;
  eraseAll: boolean;
  verify: boolean;
  trace: boolean;
  blockPause: number;
}

const le32 = (...values: number[]) =>
  values.flatMap((v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);

const text = (msg: string, args: unknown[]) =>
  [msg, ...args].map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(" ");

export async function flashWithTasmota(
  images: { name: string; address: number; data: Uint8Array }[],
  log: Logger,
  progress: Progress,
  opt: TasmotaOptions,
) {
  const { ESPLoader } = await import("tasmota-webserial-esptool");
  type Loader = InstanceType<typeof ESPLoader>;

  log.info("Select the “Serial Monitor” port of the e-puck2 programmer…");
  const port = await navigator.serial.requestPort({ filters: [opt.filter] });

  const logger = {
    log: (m: string, ...a: unknown[]) => log.dim(text(m, a)),
    error: (m: string, ...a: unknown[]) => log.warn(text(m, a)),
    debug: (m: string, ...a: unknown[]) => {
      if (opt.trace) log.dim(text(m, a));
    },
  };

  let esp: Loader | null = null;
  const open = async () => {
    await port.open({ baudRate: ROM_BAUD });
    esp = new ESPLoader(port, logger);
    esp.debug = opt.trace;
    await esp.initialize();
    return esp;
  };
  const close = async () => {
    try {
      await esp?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      await port.close();
    } catch {
      /* ignore */
    }
    esp = null;
  };

  try {
    progress.set("Connecting", 0);
    let loader: Loader = await open();
    log.info(`Connected to ${loader.chipName}`);

    try {
      loader = (await loader.runStub()) as unknown as Loader;
      log.info("Flasher stub running");
    } catch (e) {
      log.warn(`Flasher stub did not start (${errorMessage(e)}). Falling back to the ROM loader…`);
      await close();
      await sleep(300);
      loader = await open();
    }
    const isStub = loader.IS_STUB;
    if (opt.baud !== ROM_BAUD) await loader.setBaudrate(opt.baud);

    if (!isStub) {
      // The ROM does not enable the SPI flash by itself (needed before a compressed write).
      await loader.checkCommand(ESP_SPI_ATTACH, new Array(8).fill(0));
      // The ROM erases the whole area before answering FLASH_DEFL_BEGIN, but the library waits only
      // 3 s for it in ROM mode: allow the time esptool.py allows (30 s per MB, at least 10 s).
      const check = loader.checkCommand.bind(loader);
      loader.checkCommand = (opcode: number, buffer: number[], checksum?: number, timeout?: number) => {
        if (opcode === ESP_FLASH_DEFL_BEGIN) {
          const eraseBytes = buffer[0] | (buffer[1] << 8) | (buffer[2] << 16) | (buffer[3] << 24);
          timeout = Math.max(timeout ?? 0, 10000, (eraseBytes / 1e6) * 30000);
        }
        return check(opcode, buffer, checksum, timeout);
      };
    }
    // Tell the loader the real flash size (as esptool.py does), otherwise writes beyond 2 MB fail.
    const flashId = await loader.flashId();
    const sizeId = (flashId >> 16) & 0xff;
    const sizeBytes = sizeId >= 0x12 && sizeId <= 0x1a ? 2 ** sizeId : 0;
    if (sizeBytes) {
      await loader.checkCommand(ESP_SPI_SET_PARAMS, le32(0, sizeBytes, 0x10000, 0x1000, 0x100, 0xffff));
      log.dim(`Flash size: ${sizeBytes / (1024 * 1024)} MB`);
    } else {
      log.warn("Unknown flash size: writes beyond 2 MB may fail");
    }

    if (opt.blockPause > 0) {
      const defl = loader.flashDeflBlock.bind(loader);
      loader.flashDeflBlock = async (data: number[], seq: number, timeout?: number) => {
        await defl(data, seq, timeout);
        await sleep(opt.blockPause);
      };
    }

    if (opt.eraseAll) {
      if (isStub) {
        log.info("Erasing the entire flash…");
        progress.set("Erasing", 0);
        await (loader as unknown as { eraseFlash(): Promise<void> }).eraseFlash();
      } else {
        log.warn("Erasing the entire flash needs the flasher stub: skipped");
      }
    }

    const total = images.reduce((a, i) => a + i.data.length, 0);
    let done = 0;
    const t0 = performance.now();
    for (const img of images) {
      log.info(`Writing ${img.name} (${formatSize(img.data.length)}) at ${hex32(img.address)}…`);
      await loader.flashData(
        img.data.slice().buffer,
        (written: number) => progress.set(`Writing ${img.name}`, (done + written) / total),
        img.address,
        true,
      );
      if (opt.verify) {
        const [, data] = await loader.checkCommand(
          ESP_SPI_FLASH_MD5,
          le32(img.address, img.data.length, 0, 0),
          0,
          Math.max(8000, (img.data.length / 1e6) * 8000),
        );
        // The stub answers with 16 raw bytes, the ROM with 32 ASCII hex characters.
        const flashMd5 =
          data.length >= 32
            ? String.fromCharCode(...data.slice(0, 32)).toLowerCase()
            : data
                .slice(0, 16)
                .map((b: number) => b.toString(16).padStart(2, "0"))
                .join("");
        if (flashMd5 !== md5(img.data)) throw new Error(`MD5 of ${img.name} does not match the data in flash`);
        log.ok(`  ${img.name} verified (MD5)`);
      }
      done += img.data.length;
    }
    log.ok(`Wrote ${formatSize(total)} in ${((performance.now() - t0) / 1000).toFixed(0)} s`);

    log.info("Resetting the ESP32 (hard reset)…");
    await loader.hardReset(false);
  } finally {
    await close();
  }
}
