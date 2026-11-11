// Firmware file loaders: ELF, Intel HEX, DfuSe (.dfu) and raw binary.
// Every loader returns a list of contiguous memory segments.

export interface Segment {
  address: number;
  data: Uint8Array;
}

export interface FirmwareImage {
  name: string;
  format: "elf" | "hex" | "dfu" | "bin";
  segments: Segment[];
  /** Entry point (ELF only). */
  entry?: number;
}

export const hex32 = (n: number) => "0x" + (n >>> 0).toString(16).toUpperCase().padStart(8, "0");

export function formatSize(n: number): string {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

export function totalSize(segments: Segment[]): number {
  return segments.reduce((s, x) => s + x.data.length, 0);
}

/** Sort segments and join those that are exactly contiguous. */
export function mergeSegments(segments: Segment[]): Segment[] {
  const sorted = segments.filter((s) => s.data.length > 0).sort((a, b) => a.address - b.address);
  const out: Segment[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && last.address + last.data.length > s.address) {
      throw new Error(`Overlapping segments at ${hex32(s.address)}`);
    }
    if (last && last.address + last.data.length === s.address) {
      const joined = new Uint8Array(last.data.length + s.data.length);
      joined.set(last.data, 0);
      joined.set(s.data, last.data.length);
      last.data = joined;
    } else {
      out.push({ address: s.address, data: s.data });
    }
  }
  return out;
}

/**
 * Join segments separated by small gaps (filled with `fill`, the erased-flash value) and pad
 * each resulting segment to a multiple of `align` bytes. Used for DFU, where e.g. the STM32L4
 * programs the flash in 8-byte double words.
 */
export function coalesceSegments(segments: Segment[], maxGap = 256, align = 8, fill = 0xff): Segment[] {
  const sorted = mergeSegments(segments);
  const groups: Segment[][] = [];
  for (const s of sorted) {
    const g = groups[groups.length - 1];
    const last = g?.[g.length - 1];
    if (last && s.address - (last.address + last.data.length) <= maxGap) g.push(s);
    else groups.push([s]);
  }
  return groups.map((g) => {
    const start = g[0].address;
    const end = g[g.length - 1].address + g[g.length - 1].data.length;
    const len = Math.ceil((end - start) / align) * align;
    const data = new Uint8Array(len).fill(fill);
    for (const s of g) data.set(s.data, s.address - start);
    return { address: start, data };
  });
}

// ---------------------------------------------------------------- ELF

export function parseElf(buf: Uint8Array): { segments: Segment[]; entry: number } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, false) !== 0x7f454c46) throw new Error("Not an ELF file");
  if (buf[4] !== 1) throw new Error("Only 32-bit ELF files are supported");
  if (buf[5] !== 1) throw new Error("Only little-endian ELF files are supported");

  const entry = dv.getUint32(0x18, true);
  const phoff = dv.getUint32(0x1c, true);
  const shoff = dv.getUint32(0x20, true);
  const phentsize = dv.getUint16(0x2a, true);
  const phnum = dv.getUint16(0x2c, true);
  const shentsize = dv.getUint16(0x2e, true);
  const shnum = dv.getUint16(0x30, true);

  interface Ph { type: number; offset: number; vaddr: number; paddr: number; filesz: number; memsz: number }
  const phs: Ph[] = [];
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    phs.push({
      type: dv.getUint32(o, true),
      offset: dv.getUint32(o + 4, true),
      vaddr: dv.getUint32(o + 8, true),
      paddr: dv.getUint32(o + 12, true),
      filesz: dv.getUint32(o + 16, true),
      memsz: dv.getUint32(o + 20, true),
    });
  }
  const loads = phs.filter((p) => p.type === 1 /* PT_LOAD */ && p.filesz > 0);

  const segments: Segment[] = [];
  const SHF_ALLOC = 0x2;
  const SHT_NOBITS = 8;

  // Like gdb "load": every allocated section with contents, placed at its LMA.
  if (shoff && shnum) {
    for (let i = 0; i < shnum; i++) {
      const o = shoff + i * shentsize;
      const type = dv.getUint32(o + 4, true);
      const flags = dv.getUint32(o + 8, true);
      const addr = dv.getUint32(o + 12, true);
      const offset = dv.getUint32(o + 16, true);
      const size = dv.getUint32(o + 20, true);
      if (!(flags & SHF_ALLOC) || type === SHT_NOBITS || size === 0) continue;
      const ph = loads.find((p) => offset >= p.offset && offset + size <= p.offset + p.filesz);
      if (!ph) continue; // not part of a loadable segment
      const lma = ph.paddr + (offset - ph.offset);
      segments.push({ address: lma >>> 0, data: buf.slice(offset, offset + size) });
    }
  }
  // Fallback for stripped files without section headers.
  if (segments.length === 0) {
    for (const p of loads) {
      segments.push({ address: p.paddr >>> 0, data: buf.slice(p.offset, p.offset + p.filesz) });
    }
  }
  if (segments.length === 0) throw new Error("ELF file contains no loadable data");
  return { segments: mergeSegments(segments), entry };
}

// ---------------------------------------------------------------- Intel HEX

export function parseIntelHex(text: string): Segment[] {
  const bytes = new Map<number, number>();
  let base = 0;
  const lines = text.split(/\r\n|\r|\n/); // CRLF, LF or CR-only line endings
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].trim();
    if (!line) continue;
    if (line[0] !== ":") throw new Error(`HEX line ${ln + 1}: missing ':'`);
    const rec = new Uint8Array((line.length - 1) / 2);
    for (let i = 0; i < rec.length; i++) rec[i] = parseInt(line.substr(1 + i * 2, 2), 16);
    const len = rec[0];
    const sum = rec.reduce((a, b) => (a + b) & 0xff, 0);
    if (sum !== 0) throw new Error(`HEX line ${ln + 1}: bad checksum`);
    const off = (rec[1] << 8) | rec[2];
    const type = rec[3];
    const data = rec.subarray(4, 4 + len);
    if (type === 0) {
      for (let i = 0; i < len; i++) bytes.set((base + off + i) >>> 0, data[i]);
    } else if (type === 1) {
      break;
    } else if (type === 2) {
      base = ((data[0] << 8) | data[1]) << 4;
    } else if (type === 4) {
      base = (((data[0] << 8) | data[1]) << 16) >>> 0;
    }
  }
  const addrs = [...bytes.keys()].sort((a, b) => a - b);
  const segments: Segment[] = [];
  let start = -1;
  let cur: number[] = [];
  let prev = -2;
  for (const a of addrs) {
    if (a !== prev + 1) {
      if (cur.length) segments.push({ address: start, data: Uint8Array.from(cur) });
      start = a;
      cur = [];
    }
    cur.push(bytes.get(a)!);
    prev = a;
  }
  if (cur.length) segments.push({ address: start, data: Uint8Array.from(cur) });
  if (segments.length === 0) throw new Error("HEX file contains no data");
  return segments;
}

// ---------------------------------------------------------------- DfuSe

export function parseDfuSe(buf: Uint8Array): Segment[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sig = new TextDecoder().decode(buf.subarray(0, 5));
  if (sig !== "DfuSe") throw new Error("Not a DfuSe file");
  const targets = buf[10];
  let p = 11;
  const segments: Segment[] = [];
  for (let t = 0; t < targets; t++) {
    const tsig = new TextDecoder().decode(buf.subarray(p, p + 6));
    if (tsig !== "Target") throw new Error("Invalid DfuSe target prefix");
    const nElements = dv.getUint32(p + 270, true);
    p += 274;
    for (let e = 0; e < nElements; e++) {
      const addr = dv.getUint32(p, true);
      const size = dv.getUint32(p + 4, true);
      segments.push({ address: addr, data: buf.slice(p + 8, p + 8 + size) });
      p += 8 + size;
    }
  }
  return mergeSegments(segments);
}

// ---------------------------------------------------------------- generic

export async function loadFirmware(file: File, binBase: number): Promise<FirmwareImage> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const name = file.name;
  const lower = name.toLowerCase();
  if (buf.length >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    const { segments, entry } = parseElf(buf);
    return { name, format: "elf", segments, entry };
  }
  if (buf.length >= 5 && new TextDecoder().decode(buf.subarray(0, 5)) === "DfuSe") {
    return { name, format: "dfu", segments: parseDfuSe(buf) };
  }
  if (lower.endsWith(".hex") || lower.endsWith(".ihex") || buf[0] === 0x3a /* ':' */) {
    return { name, format: "hex", segments: parseIntelHex(new TextDecoder().decode(buf)) };
  }
  return { name, format: "bin", segments: [{ address: binBase >>> 0, data: buf }] };
}
