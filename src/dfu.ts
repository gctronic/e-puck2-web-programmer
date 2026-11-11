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

// STM32F413 internal flash, used if the interface name cannot be read.
const F413_DEFAULT = "@Internal Flash  /0x08000000/04*016Kg,01*064Kg,11*128Kg";

export interface DfuStatus {
  status: number;
  pollTimeout: number;
  state: number;
}

export class DfuseDevice {
  transferSize = 2048;
  layout: MemoryLayout = parseMemoryDescriptor(F413_DEFAULT);
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

  async open() {
    const d = this.device;
    await d.open();
    if (d.configuration === null) await d.selectConfiguration(1);

    // Find the DFU interface/alternate setting for the internal flash.
    let chosen: { intf: number; alt: number; name: string | undefined } | null = null;
    for (const iface of d.configuration!.interfaces) {
      for (const alt of iface.alternates) {
        if (alt.interfaceClass !== 0xfe || alt.interfaceSubclass !== 0x01) continue;
        const name = alt.interfaceName ?? undefined;
        if (!chosen) chosen = { intf: iface.interfaceNumber, alt: alt.alternateSetting, name };
        if (name && /internal flash/i.test(name)) {
          chosen = { intf: iface.interfaceNumber, alt: alt.alternateSetting, name };
        }
      }
    }
    if (!chosen) throw new Error("The selected device has no DFU interface");
    this.intf = chosen.intf;
    await d.claimInterface(chosen.intf);
    await d.selectAlternateInterface(chosen.intf, chosen.alt);

    if (chosen.name && chosen.name.startsWith("@")) {
      this.layout = parseMemoryDescriptor(chosen.name);
      this.log(`Memory: ${chosen.name.trim()}`);
    } else {
      this.log("Memory layout not reported, using STM32F413 default");
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

  /** Read wTransferSize from the DFU functional descriptor in the configuration descriptor. */
  private async readTransferSize(): Promise<number | null> {
    try {
      const head = await this.device.controlTransferIn(
        { requestType: "standard", recipient: "device", request: 6, value: 0x0200, index: 0 },
        9,
      );
      const total = head.data!.getUint16(2, true);
      const full = await this.device.controlTransferIn(
        { requestType: "standard", recipient: "device", request: 6, value: 0x0200, index: 0 },
        total,
      );
      const dv = full.data!;
      for (let p = 0; p + 1 < dv.byteLength; ) {
        const len = dv.getUint8(p);
        const type = dv.getUint8(p + 1);
        if (len === 0) break;
        if (type === 0x21 && len >= 7) return dv.getUint16(p + 5, true);
        p += len;
      }
    } catch {
      /* fall back to default */
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
    await this.abort();
    let s = await this.getStatus();
    if (s.state === State.dfuERROR) {
      await this.clearStatus();
      s = await this.getStatus();
    }
    if (s.state !== State.dfuIDLE) throw new Error(`Device not idle (state ${s.state})`);
  }

  /** Poll GETSTATUS while the device is busy; throws on DFU error. */
  private async pollUntilIdle(expected: number): Promise<DfuStatus> {
    let s = await this.getStatus();
    while (s.state === State.dfuDNBUSY || s.state === State.dfuMANIFEST) {
      await sleep(Math.max(s.pollTimeout, 1));
      s = await this.getStatus();
    }
    if (s.status !== 0) {
      throw new Error(`DFU error: ${STATUS_TEXT[s.status] ?? "status " + s.status}`);
    }
    if (s.state !== expected) throw new Error(`Unexpected DFU state ${s.state} (expected ${expected})`);
    return s;
  }

  private async dfuseCommand(cmd: number, address?: number) {
    const payload = new Uint8Array(address === undefined ? 1 : 5);
    payload[0] = cmd;
    if (address !== undefined) new DataView(payload.buffer).setUint32(1, address >>> 0, true);
    await this.out(DFU_DNLOAD, 0, payload);
    await this.pollUntilIdle(State.dfuDNLOAD_IDLE);
  }

  setAddress(address: number) {
    return this.dfuseCommand(CMD_SET_ADDRESS, address);
  }

  eraseSector(address: number) {
    return this.dfuseCommand(CMD_ERASE, address);
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
      await this.setAddress(address + off);
      await this.out(DFU_DNLOAD, 2, chunk);
      await this.pollUntilIdle(State.dfuDNLOAD_IDLE);
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
