// Reliable ESP32 flash writing through the e-puck2 programmer bridge.
//
// Through the bridge a block occasionally reaches the ESP32 corrupted (the loader answers
// "status 1,5"), on average once every ~1500 blocks of 1 KB. With a single write of the 3 MB
// application one bad block makes the whole write fail, and the ROM loader cannot resume the
// compressed stream. So the images are written in independent parts (64 KB each, aligned to flash
// sectors), each with its own compressed stream and MD5 check; a part that fails is simply written
// again, after resynchronising with the loader or, if it does not answer, reconnecting.

import type { FlashOptions } from "esptool-js";

export interface Image {
  name: string;
  address: number;
  data: Uint8Array;
}

export interface Part extends Image {
  /** Index of the image this part belongs to. */
  image: number;
  /** Offset of the part inside its image. */
  offset: number;
}

/** Minimal loader interface used here (implemented by esptool-js ESPLoader). */
export interface WriterLoader {
  writeFlash(options: FlashOptions): Promise<void>;
  readReg(addr: number, timeout?: number): Promise<number>;
}

export const PART_SIZE = 0x10000;
const SECTOR = 0x1000;
/** A register every ESP32 loader (ROM or stub) can read: used to check it still answers. */
const PROBE_REG = 0x40001000;

/** Split images into parts of `partSize` bytes. Only sector-aligned images are split. */
export function splitImages(images: Image[], partSize = PART_SIZE): Part[] {
  const parts: Part[] = [];
  images.forEach((img, image) => {
    const canSplit = img.address % SECTOR === 0 && partSize % SECTOR === 0 && img.data.length > partSize;
    const step = canSplit ? partSize : img.data.length;
    for (let offset = 0; offset < img.data.length; offset += step) {
      parts.push({
        name: img.name,
        address: img.address + offset,
        data: img.data.subarray(offset, Math.min(offset + step, img.data.length)),
        image,
        offset,
      });
    }
  });
  return parts;
}

export interface WriteOptions {
  loader: WriterLoader;
  parts: Part[];
  /** writeFlash options shared by every part (fileArray and reportProgress are set here). */
  flash: Omit<FlashOptions, "fileArray" | "reportProgress" | "eraseAll">;
  /** Attempts per part (first write included). */
  maxAttempts?: number;
  /** Discard pending input from the serial port. */
  drain: () => Promise<void>;
  /** Reset the ESP32 and reconnect the loader (same loader object). */
  reconnect: () => Promise<void>;
  onProgress?: (written: number, total: number, part: Part) => void;
  onRetry?: (part: Part, attempt: number, error: string, action: "resync" | "reconnect") => void;
  /** Called when a part has been written (and verified, if requested). */
  onPartDone?: (part: Part, index: number, count: number, ms: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface WriteResult {
  retries: number;
  reconnects: number;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function writeParts(o: WriteOptions): Promise<WriteResult> {
  const maxAttempts = o.maxAttempts ?? 6;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const total = o.parts.reduce((a, p) => a + p.data.length, 0);
  let done = 0;
  let retries = 0;
  let reconnects = 0;

  for (const [index, part] of o.parts.entries()) {
    const t0 = Date.now();
    for (let attempt = 1; ; attempt++) {
      try {
        await o.loader.writeFlash({
          ...o.flash,
          fileArray: [{ data: part.data, address: part.address }],
          eraseAll: false,
          reportProgress: (_i, written, size) => o.onProgress?.(done + (written / size) * part.data.length, total, part),
        });
        break;
      } catch (e) {
        const msg = errorText(e);
        if (attempt >= maxAttempts) {
          throw new Error(`Could not write ${part.name} at 0x${part.address.toString(16)} after ${attempt} attempts: ${msg}`);
        }
        retries++;
        // First try to resynchronise with the loader; every second failure, or if the
        // loader does not answer, reset the ESP32 and reconnect.
        let action: "resync" | "reconnect" = attempt % 2 === 1 ? "resync" : "reconnect";
        if (action === "resync") {
          await sleep(200);
          await o.drain();
          try {
            await o.loader.readReg(PROBE_REG, 1000);
          } catch {
            action = "reconnect";
          }
        }
        o.onRetry?.(part, attempt, msg, action);
        if (action === "reconnect") {
          reconnects++;
          await o.reconnect();
        }
      }
    }
    done += part.data.length;
    o.onProgress?.(done, total, part);
    o.onPartDone?.(part, index, o.parts.length, Date.now() - t0);
  }
  return { retries, reconnects };
}
