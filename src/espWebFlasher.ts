// ESP32 programming with esp-web-flasher (Nabu Casa, deprecated in 2022 in favour of esptool-js).
// It is offered for comparison: it uploads an older flasher stub (esptool v3 generation), like the
// esptool.py of program_esp32.sh, and writes each image as a whole with 16 KB blocks.
// esp-web-flasher does not set the flash size nor verify the result, so both are added here.

import { md5 } from "./md5";
import { formatSize, hex32 } from "./firmware";
import { Logger, Progress, sleep } from "./ui";

const ROM_BAUD = 115200;
const ESP_SPI_SET_PARAMS = 0x0b;
const ESP_SPI_FLASH_MD5 = 0x13;

export interface WebFlasherOptions {
  filter: SerialPortFilter;
  baud: number;
  eraseAll: boolean;
  verify: boolean;
  trace: boolean;
  blockPause: number;
}

const le32 = (...values: number[]) =>
  values.flatMap((v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);

const text = (args: unknown[]) =>
  args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(" ");

export async function flashWithEspWebFlasher(
  images: { name: string; address: number; data: Uint8Array }[],
  log: Logger,
  progress: Progress,
  opt: WebFlasherOptions,
) {
  const { ESPLoader } = await import("esp-web-flasher");

  log.info("Select the “Serial Monitor” port of the e-puck2 programmer…");
  const port = await navigator.serial.requestPort({ filters: [opt.filter] });
  await port.open({ baudRate: ROM_BAUD });

  const logger = {
    log: (...a: unknown[]) => log.dim(text(a)),
    error: (...a: unknown[]) => log.error(text(a)),
    debug: (...a: unknown[]) => {
      if (opt.trace) log.dim(text(a));
    },
  };
  const esp = new ESPLoader(port, logger);
  esp.debug = opt.trace;

  try {
    progress.set("Connecting", 0);
    await esp.initialize();
    log.info(`Connected to ${esp.chipName}`);

    const stub = await esp.runStub();
    if (opt.baud !== ROM_BAUD) await stub.setBaudrate(opt.baud);

    // Tell the stub the real flash size (as esptool.py does), otherwise writes beyond 2 MB fail.
    const flashId = await stub.flashId();
    const sizeId = (flashId >> 16) & 0xff;
    const sizeBytes = sizeId >= 0x12 && sizeId <= 0x1a ? 2 ** sizeId : 0;
    if (sizeBytes) {
      await stub.checkCommand(ESP_SPI_SET_PARAMS, le32(0, sizeBytes, 0x10000, 0x1000, 0x100, 0xffff));
      log.dim(`Flash size: ${sizeBytes / (1024 * 1024)} MB`);
    } else {
      log.warn("Unknown flash size: writes beyond 2 MB may fail");
    }

    if (opt.blockPause > 0) {
      const defl = stub.flashDeflBlock.bind(stub);
      stub.flashDeflBlock = async (data: number[], seq: number, timeout?: number) => {
        await defl(data, seq, timeout);
        await sleep(opt.blockPause);
      };
    }

    if (opt.eraseAll) {
      log.info("Erasing the entire flash…");
      progress.set("Erasing", 0);
      await stub.eraseFlash();
    }

    const total = images.reduce((a, i) => a + i.data.length, 0);
    let done = 0;
    const t0 = performance.now();
    for (const img of images) {
      log.info(`Writing ${img.name} (${formatSize(img.data.length)}) at ${hex32(img.address)}…`);
      const buffer = img.data.slice().buffer;
      await stub.flashData(
        buffer,
        (written: number) => progress.set(`Writing ${img.name}`, (done + written) / total),
        img.address,
        true,
      );
      if (opt.verify) {
        const [, data] = await stub.checkCommand(
          ESP_SPI_FLASH_MD5,
          le32(img.address, img.data.length, 0, 0),
          0,
          Math.max(8000, (img.data.length / 1e6) * 8000),
        );
        const flashMd5 = data
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
    await stub.hardReset(false);
  } finally {
    try {
      await esp.disconnect();
    } catch {
      /* ignore */
    }
    try {
      await port.close();
    } catch {
      /* ignore */
    }
  }
}
