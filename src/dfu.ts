// WebUSB implementation of the ST DfuSe protocol (DFU 1.1 + ST extensions),
// as used by the STM32 system-memory bootloader (equivalent to dfu-util -a 0 -s 0x08000000:leave).

import { hex32 } from "./firmware";
import { sleep } from "./ui";

const DFU_DNLOAD = 1;
const DFU_UPLOAD = 2;
const DFU_GETSTATUS = 3;
const DFU_CLRSTATUS = 4;
const DFU_ABORT = 6;

const enum State {
  appIDLE = 0,
  appDETACH = 1,
  dfuIDLE = 2,
  dfuDNLOAD_SYNC = 3,
  dfuDNBUSY = 4,
  dfuDNLOAD_IDLE = 5,
  dfuMANIFEST_SYNC = 6,
  dfuMANIFEST = 7,
  dfuMANIFEST_WAIT_RESET = 8,
  dfuUPLOAD_IDLE = 9,
  dfuERROR = 10,
}

const STATUS_TEXT: Record<number, string> = {
  0x01: "errTARGET (file not for this device)",
  0x02: "errFILE",
  0x03: "errWRITE (cannot write memory)",
  0x04: "errERASE (memory erase failed)",
  0x05: "errCHECK_ERASED",
  0x06: "errPROG (program memory failed)",
  0x07: "errVERIFY",
  0x08: "errADDRESS (address out of range)",
  0x09: "errNOTDONE",
  0x0a: "errFIRMWARE",
  0x0b: "errVENDOR (read protection active?)",
  0x0c: "errUSBR",
  0x0d: "errPOR",
  0x0e: "errUNKNOWN",
  0x0f: "errSTALLEDPKT",
};

const CMD_SET_ADDRESS = 0x21;
const CMD_ERASE = 0x41;

export const STM32_DFU_FILTER = { vendorId: 0x0483, productId: 0xdf11 };

export interface Sector {
  start: number;
  size: number;
  readable: boolean;
  erasable: boolean;
  writable: boolean;
}

export interface MemoryLayout {
  name: string;
  sectors: Sector[];
}

/** Parse a DfuSe memory descriptor, e.g. "@Internal Flash  /0x08000000/04*016Kg,01*064Kg,11*128Kg". */
export function parseMemoryDescriptor(desc: string): MemoryLayout {
  const parts = desc.split("/");
  const name = parts[0].replace(/^@/, "").trim();
  const sectors: Sector[] = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    let addr = parseInt(parts[i], 16);
    for (const spec of parts[i + 1].split(",")) {
      const m = /^\s*(\d+)\*(\d+)\s*([BKM ]?)([a-g])/.exec(spec);
      if (!m) continue;
      const count = parseInt(m[1], 10);
      const mult = m[3] === "K" ? 1024 : m[3] === "M" ? 1024 * 1024 : 1;
      const size = parseInt(m[2], 10) * mult;
      const attr = m[4].charCodeAt(0) - 0x60; // a=1 ... g=7
      for (let k = 0; k < count; k++) {
        sectors.push({ start: addr, size, readable: !!(attr & 1), erasable: !!(attr & 2), writable: !!(attr & 4) });
        addr += size;
      }
    }
  }
  return { name, sectors };
}

// Internal flash layouts reported by the ST ROM DFU bootloader, used if the interface name cannot be read.
export const F413_LAYOUT = "@Internal Flash  /0x08000000/04*016Kg,01*064Kg,11*128Kg";
export const L452_LAYOUT = "@Internal Flash  /0x08000000/0256*0002Kg";

export interface DfuStatus {
  status: number;
  pollTimeout: number;
  state: number;
}

export class DfuseDevice {
  transferSize = 2048;
  layout: MemoryLayout = parseMemoryDescriptor(F413_LAYOUT);
  /** True if the memory layout was read from the device (DfuSe interface name). */
  layoutReported = false;
  private intf = 0;
  log: (t: string) => void = () => {};

  constructor(public device: USBDevice) {}

  static async request(): Promise<DfuseDevice> {
    const dev = await navigator.usb.requestDevice({ filters: [STM32_DFU_FILTER] });
    return new DfuseDevice(dev);
  }

  get description(): string {
    const d = this.device;
    return `${d.productName ?? "DFU device"} (${d.manufacturerName ?? "?"}) ${hex4(d.vendorId)}:${hex4(d.productId)}` +
      (d.serialNumber ? `, S/N ${d.serialNumber}` : "");
  }

  /** Open the DFU interface. `fallbackLayout` is used if the device does not report its memory layout. */
  async open(fallbackLayout = F413_LAYOUT) {
    const d = this.device;
    await d.open();
    if (d.configuration === null) await d.selectConfiguration(1);

    // DFU interfaces / alternate settings. Their names (DfuSe memory descriptors) are not always
    // filled in by the browser (e.g. Chrome on Windows): read them from the USB descriptors then.
    const alts: { intf: number; alt: number; name: string | undefined }[] = [];
    for (const iface of d.configuration!.interfaces) {
      for (const alt of iface.alternates) {
        if (alt.interfaceClass !== 0xfe || alt.interfaceSubclass !== 0x01) continue;
        alts.push({ intf: iface.interfaceNumber, alt: alt.alternateSetting, name: alt.interfaceName ?? undefined });
      }
    }
    if (alts.length === 0) throw new Error("The selected device has no DFU interface");
    if (alts.some((a) => !a.name)) {
      const names = await this.readInterfaceNames();
      for (const a of alts) a.name ??= names.get(`${a.intf}/${a.alt}`);
    }
    const chosen = alts.find((a) => a.name && /internal flash/i.test(a.name)) ?? alts[0];
    this.intf = chosen.intf;
    await d.claimInterface(chosen.intf);
    await d.selectAlternateInterface(chosen.intf, chosen.alt);

    if (chosen.name && chosen.name.startsWith("@")) {
      this.layout = parseMemoryDescriptor(chosen.name);
      this.layoutReported = true;
      this.log(`Memory: ${chosen.name.trim()}`);
    } else {
      this.layout = parseMemoryDescriptor(fallbackLayout);
      this.layoutReported = false;
    }

    const ts = await this.readTransferSize();
    if (ts) this.transferSize = ts;
  }

  async close() {
    try {
      await this.device.releaseInterface(this.intf);
    } catch {
      /* ignore */
    }
    try {
      await this.device.close();
    } catch {
      /* ignore */
    }
  }

  /** The whole configuration descriptor (with interface and functional descriptors), or null. */
  private async readConfigDescriptor(): Promise<DataView | null> {
    try {
      const get = (length: number) =>
        this.device.controlTransferIn(
          { requestType: "standard", recipient: "device", request: 6, value: 0x0200, index: 0 },
          length,
        );
      const head = await get(9);
      return (await get(head.data!.getUint16(2, true))).data ?? null;
    } catch {
      return null;
    }
  }

  /** Iterate the descriptors of the configuration descriptor: [offset, length, type]. */
  private *descriptors(dv: DataView): Generator<[number, number, number]> {
    for (let p = 0; p + 1 < dv.byteLength; ) {
      const len = dv.getUint8(p);
      if (len === 0) return;
      yield [p, len, dv.getUint8(p + 1)];
      p += len;
    }
  }

  /** Names of the interface alternate settings, keyed "interface/alternate", read from string descriptors. */
  private async readInterfaceNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const dv = await this.readConfigDescriptor();
    if (!dv) return names;
    for (const [p, len, type] of this.descriptors(dv)) {
      if (type !== 0x04 || len < 9) continue; // interface descriptor
      const index = dv.getUint8(p + 8); // iInterface
      if (!index) continue;
      try {
        const r = await this.device.controlTransferIn(
          { requestType: "standard", recipient: "device", request: 6, value: 0x0300 | index, index: 0x0409 },
          255,
        );
        const sd = r.data;
        if (!sd || sd.byteLength < 2) continue;
        let name = "";
        for (let i = 2; i + 1 < Math.min(sd.getUint8(0), sd.byteLength); i += 2) {
          name += String.fromCharCode(sd.getUint16(i, true));
        }
        names.set(`${dv.getUint8(p + 2)}/${dv.getUint8(p + 3)}`, name);
      } catch {
        /* skip this one */
      }
    }
    return names;
  }

  /** Read wTransferSize from the DFU functional descriptor in the configuration descriptor. */
  private async readTransferSize(): Promise<number | null> {
    const dv = await this.readConfigDescriptor();
    if (!dv) return null;
    for (const [p, len, type] of this.descriptors(dv)) {
      if (type === 0x21 && len >= 7) return dv.getUint16(p + 5, true);
    }
    return null;
  }

  private async out(request: number, value: number, data?: BufferSource) {
    const r = await this.device.controlTransferOut(
      { requestType: "class", recipient: "interface", request, value, index: this.intf },
      data,
    );
    if (r.status !== "ok") throw new Error(`USB control OUT failed (${r.status})`);
    return r.bytesWritten;
  }

  private async in(request: number, value: number, length: number): Promise<DataView> {
    const r = await this.device.controlTransferIn(
      { requestType: "class", recipient: "interface", request, value, index: this.intf },
      length,
    );
    if (r.status !== "ok" || !r.data) throw new Error(`USB control IN failed (${r.status})`);
    return r.data;
  }

  async getStatus(): Promise<DfuStatus> {
    const d = await this.in(DFU_GETSTATUS, 0, 6);
    return {
      status: d.getUint8(0),
      pollTimeout: d.getUint8(1) | (d.getUint8(2) << 8) | (d.getUint8(3) << 16),
      state: d.getUint8(4),
    };
  }

  clearStatus() {
    return this.out(DFU_CLRSTATUS, 0);
  }

  abort() {
    return this.out(DFU_ABORT, 0);
  }

  /** Bring the device to dfuIDLE, clearing any error state. */
  async abortToIdle() {
    try {
      await this.abort();
    } catch {
      /* ABORT stalls in dfuERROR: CLRSTATUS below handles that state */
    }
    let s = await this.getStatusPatient();
    if (s.state === State.dfuERROR) {
      await this.clearStatus();
      s = await this.getStatusPatient();
    }
    if (s.state !== State.dfuIDLE) throw new Error(`Device not idle (state ${s.state})`);
  }

  /**
   * GETSTATUS, tolerating a few stalls. The STM32L4 bootloader sometimes asks to be polled again
   * (bwPollTimeout) before a page erase or write has finished, and stalls GETSTATUS meanwhile.
   */
  private async getStatusPatient(): Promise<DfuStatus> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.getStatus();
      } catch (e) {
        if (attempt >= 5) throw e;
        await sleep(50 * attempt);
      }
    }
  }

  /** Poll GETSTATUS while the device is busy; throws on DFU error. */
  private async pollUntilIdle(expected: number, minBusy = 0): Promise<DfuStatus> {
    let s = await this.getStatusPatient();
    while (s.state === State.dfuDNBUSY || s.state === State.dfuMANIFEST) {
      await sleep(Math.max(s.pollTimeout, minBusy, 1));
      s = await this.getStatusPatient();
    }
    if (s.status !== 0) {
      throw new Error(`DFU error: ${STATUS_TEXT[s.status] ?? "status " + s.status}`);
    }
    if (s.state !== expected) throw new Error(`Unexpected DFU state ${s.state} (expected ${expected})`);
    return s;
  }

  /**
   * Run a DfuSe operation; if it fails (stall, DFU error), bring the device back to idle and try again.
   * Erasing or writing the same block twice is harmless.
   */
  private async retrying<T>(what: string, op: () => Promise<T>, attempts = 4): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await op();
      } catch (e) {
        if (attempt >= attempts) throw e;
        this.log(`${what}: ${e instanceof Error ? e.message : String(e)} — retrying (${attempt})`);
        await sleep(100 * attempt);
        await this.abortToIdle();
      }
    }
  }

  private async dfuseCommand(cmd: number, address?: number, minBusy = 0) {
    const payload = new Uint8Array(address === undefined ? 1 : 5);
    payload[0] = cmd;
    if (address !== undefined) new DataView(payload.buffer).setUint32(1, address >>> 0, true);
    await this.out(DFU_DNLOAD, 0, payload);
    await this.pollUntilIdle(State.dfuDNLOAD_IDLE, minBusy);
  }

  setAddress(address: number) {
    return this.dfuseCommand(CMD_SET_ADDRESS, address);
  }

  eraseSector(address: number) {
    // A 2 KB page of the STM32L4 takes up to ~25 ms to erase: never poll sooner than that.
    return this.retrying(`Erase ${hex32(address)}`, () => this.dfuseCommand(CMD_ERASE, address, 25));
  }

  massErase() {
    return this.dfuseCommand(CMD_ERASE);
  }

  /** Sectors overlapping [address, address+length). */
  sectorsFor(address: number, length: number): Sector[] {
    const end = address + length;
    const list = this.layout.sectors.filter((s) => s.start < end && s.start + s.size > address);
    let covered = address;
    for (const s of list) {
      if (s.start > covered) break;
      covered = s.start + s.size;
    }
    if (covered < end) throw new Error(`Address range ${hex32(address)}–${hex32(end - 1)} is outside the device flash`);
    return list;
  }

  async erase(sectors: Sector[], onProgress?: (done: number, total: number) => void) {
    let i = 0;
    for (const s of sectors) {
      if (!s.erasable) throw new Error(`Sector ${hex32(s.start)} is not erasable`);
      await this.eraseSector(s.start);
      onProgress?.(++i, sectors.length);
    }
  }

  async write(address: number, data: Uint8Array, onProgress?: (written: number) => void) {
    const xfer = this.transferSize;
    for (let off = 0; off < data.length; off += xfer) {
      const chunk = data.subarray(off, Math.min(off + xfer, data.length));
      await this.retrying(`Write ${hex32(address + off)}`, async () => {
        await this.setAddress(address + off);
        await this.out(DFU_DNLOAD, 2, chunk);
        // Writing 2 KB takes ~20 ms on the STM32L4: never poll sooner than that.
        await this.pollUntilIdle(State.dfuDNLOAD_IDLE, 25);
      });
      onProgress?.(off + chunk.length);
    }
  }

  async read(address: number, length: number, onProgress?: (read: number) => void): Promise<Uint8Array> {
    const xfer = this.transferSize;
    const out = new Uint8Array(length);
    await this.abortToIdle();
    await this.setAddress(address);
    await this.abortToIdle();
    for (let block = 0, off = 0; off < length; block++, off += xfer) {
      const n = Math.min(xfer, length - off);
      const d = await this.in(DFU_UPLOAD, block + 2, n);
      out.set(new Uint8Array(d.buffer, d.byteOffset, d.byteLength), off);
      onProgress?.(off + n);
    }
    await this.abortToIdle();
    return out;
  }

  /** Jump to the application at `address` (dfu-util ":leave"). */
  async leave(address: number) {
    await this.abortToIdle();
    await this.setAddress(address);
    await this.out(DFU_DNLOAD, 0, new Uint8Array(0));
    try {
      // This GETSTATUS triggers the manifestation: the device resets and usually disappears.
      await this.getStatus();
    } catch {
      /* expected: device disconnected */
    }
  }
}

const hex4 = (n: number) => n.toString(16).padStart(4, "0");
