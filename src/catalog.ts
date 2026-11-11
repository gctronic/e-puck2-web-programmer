// Official firmwares published with the page, described by public/firmware/manifest.json.
// To add a new release: copy the files under public/firmware/ and add an entry at the top
// of the matching list in manifest.json (see README.md). The page reads the manifest at runtime.

import { formatSize } from "./firmware";

export interface MainFirmware {
  label: string;
  version: string;
  commit?: string;
  file: string;
  /** Load address, only for .bin files. */
  address?: string;
  notes?: string;
}

export interface RadioFirmware {
  label: string;
  /** e-puck2 hardware revision: "2.2" (ESP32 with PSRAM) or "2.0-2.1". */
  hardware: "2.2" | "2.0-2.1";
  version: string;
  commit?: string;
  images: { name: string; offset: string; file: string }[];
  notes?: string;
}

export interface ProgrammerFirmware {
  label: string;
  /** "f413" for robots with ID < 5400, "l452" from ID 5400. */
  chip: "f413" | "l452";
  version: string;
  commit?: string;
  file: string;
  address?: string;
  notes?: string;
}

export interface Manifest {
  main: MainFirmware[];
  radio: RadioFirmware[];
  programmer: ProgrammerFirmware[];
}

const BASE = "firmware/";
let manifestPromise: Promise<Manifest> | null = null;

export function loadManifest(): Promise<Manifest> {
  manifestPromise ??= fetch(BASE + "manifest.json", { cache: "no-cache" }).then(async (r) => {
    if (!r.ok) throw new Error(`Cannot load the firmware list (HTTP ${r.status})`);
    return (await r.json()) as Manifest;
  });
  return manifestPromise;
}

export function firmwareUrl(file: string): string {
  return BASE + file;
}

export function versionText(e: { version: string; commit?: string }): string {
  return e.version + (e.commit ? ` (${e.commit})` : "");
}

const cache = new Map<string, File>();

/** Download a firmware file (cached for the session), reporting the progress in bytes. */
export async function downloadFirmware(
  file: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<File> {
  const hit = cache.get(file);
  if (hit) return hit;
  const r = await fetch(firmwareUrl(file), { cache: "no-cache" });
  if (!r.ok || !r.body) throw new Error(`Cannot download ${file} (HTTP ${r.status})`);
  const total = Number(r.headers.get("content-length")) || 0;
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }
  const name = file.split("/").pop() ?? file;
  const f = new File(chunks as BlobPart[], name);
  cache.set(file, f);
  return f;
}

/** Download several files with one combined progress callback. */
export async function downloadAll(
  files: string[],
  onProgress?: (fraction: number, text: string) => void,
): Promise<File[]> {
  const out: File[] = [];
  for (let i = 0; i < files.length; i++) {
    out.push(
      await downloadFirmware(files[i], (loaded, total) => {
        const part = total ? loaded / total : 0;
        onProgress?.((i + part) / files.length, `${files[i].split("/").pop()} ${formatSize(loaded)}`);
      }),
    );
  }
  onProgress?.(1, "");
  return out;
}
