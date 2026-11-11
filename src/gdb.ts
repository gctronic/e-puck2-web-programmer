// Minimal GDB Remote Serial Protocol client over Web Serial, for the
// Black Magic Probe based firmware running on the e-puck2 STM32F413 programmer.
//
// It reproduces what program_stm32f407.sh does with arm-none-eabi-gdb:
//   target extended-remote <port>; monitor swdp_scan; attach 1; load; quit

import { sleep } from "./ui";

export class TimeoutError extends Error {}

/** Byte stream on top of a Web Serial port with timed reads. */
class SerialStream {
  private chunks: Uint8Array[] = [];
  private offset = 0;
  private waiter: (() => void) | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private loop: Promise<void> | null = null;
  private closed = false;

  constructor(public port: SerialPort) {}

  async open() {
    await this.port.open({ baudRate: 115200, bufferSize: 16384 });
    this.reader = this.port.readable!.getReader();
    this.writer = this.port.writable!.getWriter();
    this.loop = this.readLoop();
  }

  private async readLoop() {
    try {
      while (this.reader) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && value.length) {
          this.chunks.push(value);
          this.waiter?.();
        }
      }
    } catch {
      /* port closed or device lost */
    } finally {
      this.closed = true;
      this.waiter?.();
    }
  }

  async write(data: Uint8Array) {
    await this.writer!.write(data);
  }

  flushInput() {
    this.chunks = [];
    this.offset = 0;
  }

  async readByte(timeoutMs: number): Promise<number> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      if (this.chunks.length) {
        const c = this.chunks[0];
        const b = c[this.offset++];
        if (this.offset >= c.length) {
          this.chunks.shift();
          this.offset = 0;
        }
        return b;
      }
      if (this.closed) throw new Error("Serial port closed");
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new TimeoutError("Timeout waiting for the probe");
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          this.waiter = null;
          resolve();
        }, remaining);
        this.waiter = () => {
          clearTimeout(t);
          this.waiter = null;
          resolve();
        };
      });
    }
  }

  async close() {
    const r = this.reader;
    this.reader = null;
    try {
      await r?.cancel();
    } catch {
      /* ignore */
    }
    r?.releaseLock();
    try {
      this.writer?.releaseLock();
    } catch {
      /* ignore */
    }
    this.writer = null;
    await this.loop;
    try {
      await this.port.close();
    } catch {
      /* ignore */
    }
  }
}

const enc = new TextEncoder();

function toHex(s: string): string {
  return [...enc.encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(h: string): string {
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.substr(i * 2, 2), 16);
  return new TextDecoder().decode(bytes);
}

/** Escape binary data for X / vFlashWrite packets. */
function escapeBinary(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (const b of data) {
    if (b === 0x23 || b === 0x24 || b === 0x7d || b === 0x2a) out.push(0x7d, b ^ 0x20);
    else out.push(b);
  }
  return Uint8Array.from(out);
}

export interface FlashRegion {
  start: number;
  length: number;
  blockSize: number;
}

/** CRC used by gdb's qCRC packet (CRC-32/MPEG-2 style, MSB first, no final xor). */
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let j = 0; j < 8; j++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function gdbCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of data) crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ b) & 0xff]) >>> 0;
  return crc >>> 0;
}

export class GdbClient {
  private s: SerialStream;
  private noAck = false;
  packetSize = 0x400;
  /** Called with text printed by monitor commands. */
  onConsole: (text: string) => void = () => {};
  /** Called with protocol traces when debugging. */
  onTrace: ((text: string) => void) | null = null;

  constructor(port: SerialPort) {
    this.s = new SerialStream(port);
  }

  async open() {
    await this.s.open();
    await sleep(50);
    this.s.flushInput();
    // An initial '+' like gdb does, then make sure the probe answers.
    await this.s.write(enc.encode("+"));
  }

  close() {
    return this.s.close();
  }

  private async writePacket(payload: Uint8Array) {
    let sum = 0;
    for (const b of payload) sum = (sum + b) & 0xff;
    const pkt = new Uint8Array(payload.length + 4);
    pkt[0] = 0x24; // $
    pkt.set(payload, 1);
    pkt[payload.length + 1] = 0x23; // #
    pkt.set(enc.encode(sum.toString(16).padStart(2, "0")), payload.length + 2);

    for (let attempt = 0; attempt < 3; attempt++) {
      await this.s.write(pkt);
      if (this.noAck) return;
      // Wait for '+' (accept) or '-' (resend).
      for (;;) {
        const b = await this.s.readByte(2000);
        if (b === 0x2b) return;
        if (b === 0x2d) break;
      }
    }
    throw new Error("Probe rejected the packet (NAK)");
  }

  private async readPacket(timeoutMs: number): Promise<string> {
    for (;;) {
      // Skip until start of packet.
      let b: number;
      do b = await this.s.readByte(timeoutMs);
      while (b !== 0x24);
      const body: number[] = [];
      let sum = 0;
      for (;;) {
        b = await this.s.readByte(2000);
        if (b === 0x23) break;
        body.push(b);
        sum = (sum + b) & 0xff;
      }
      const c1 = await this.s.readByte(2000);
      const c2 = await this.s.readByte(2000);
      const expected = parseInt(String.fromCharCode(c1, c2), 16);
      if (expected !== sum && !this.noAck) {
        await this.s.write(enc.encode("-"));
        continue;
      }
      if (!this.noAck) await this.s.write(enc.encode("+"));
      // Expand run-length encoding ('*').
      const out: number[] = [];
      for (let i = 0; i < body.length; i++) {
        if (body[i] === 0x2a && out.length) {
          const n = body[++i] - 29;
          const last = out[out.length - 1];
          for (let k = 0; k < n; k++) out.push(last);
        } else out.push(body[i]);
      }
      const text = new TextDecoder("latin1").decode(Uint8Array.from(out));
      this.onTrace?.(`<- ${text.length > 120 ? text.slice(0, 120) + "…" : text}`);
      return text;
    }
  }

  async command(cmd: string | Uint8Array, timeoutMs = 3000): Promise<string> {
    const payload = typeof cmd === "string" ? enc.encode(cmd) : cmd;
    if (this.onTrace) {
      const t = typeof cmd === "string" ? cmd : new TextDecoder("latin1").decode(cmd.subarray(0, 40));
      this.onTrace(`-> ${t.length > 120 ? t.slice(0, 120) + "…" : t}`);
    }
    await this.writePacket(payload);
    return this.readPacket(timeoutMs);
  }

  /** qSupported handshake; also verifies that this port really is the GDB server. */
  async handshake() {
    let reply: string;
    try {
      reply = await this.command("qSupported:multiprocess+;swbreak+;hwbreak+;qRelocInsn+", 1500);
    } catch (e) {
      if (e instanceof TimeoutError) {
        throw new Error(
          "No answer from the GDB server. Make sure you selected the GDB Server port (the first of the two e-puck2 ports).",
        );
      }
      throw e;
    }
    const m = /PacketSize=([0-9a-fA-F]+)/.exec(reply);
    if (m) this.packetSize = parseInt(m[1], 16);
    if (reply.includes("QStartNoAckMode+")) {
      const r = await this.command("QStartNoAckMode");
      if (r === "OK") this.noAck = true;
    }
    return reply;
  }

  /** Run a "monitor" command; console output is forwarded to onConsole. */
  async monitor(cmd: string, timeoutMs = 10000): Promise<string> {
    let out = "";
    let reply = await this.command("qRcmd," + toHex(cmd), timeoutMs);
    for (;;) {
      if (reply.length > 1 && reply[0] === "O" && reply !== "OK") {
        const text = fromHex(reply.slice(1));
        out += text;
        this.onConsole(text);
        reply = await this.readPacket(timeoutMs);
        continue;
      }
      if (reply === "OK") return out;
      if (reply === "") throw new Error(`Monitor command "${cmd}" not supported`);
      throw new Error(`Monitor command "${cmd}" failed (${reply})`);
    }
  }

  async attach(pid = 1): Promise<string> {
    const r = await this.command(`vAttach;${pid.toString(16)}`, 5000);
    if (r.startsWith("E") || r === "") throw new Error(`Attach failed (${r || "unsupported"})`);
    return r;
  }

  async memoryMap(): Promise<FlashRegion[] | null> {
    let xml = "";
    let offset = 0;
    for (;;) {
      const r = await this.command(`qXfer:memory-map:read::${offset.toString(16)},${(0x3f0).toString(16)}`);
      if (r === "" || r.startsWith("E")) return null;
      xml += r.slice(1);
      offset += r.length - 1;
      if (r[0] === "l") break;
    }
    const regions: FlashRegion[] = [];
    const re = /<memory\s+type="flash"\s+start="(0x[0-9a-fA-F]+)"\s+length="(0x[0-9a-fA-F]+)"\s*>\s*<property\s+name="blocksize"\s*>(0x[0-9a-fA-F]+)<\/property>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) {
      regions.push({ start: parseInt(m[1], 16), length: parseInt(m[2], 16), blockSize: parseInt(m[3], 16) });
    }
    return regions;
  }

  async flashErase(address: number, length: number) {
    const r = await this.command(`vFlashErase:${address.toString(16)},${length.toString(16)}`, 60000);
    if (r !== "OK") throw new Error(`Flash erase failed at 0x${address.toString(16)} (${r})`);
  }

  /** Largest raw chunk that, once escaped, fits in a vFlashWrite packet. */
  private chunkFor(data: Uint8Array, start: number, address: number): number {
    const header = `vFlashWrite:${address.toString(16)}:`.length;
    const budget = this.packetSize - header - 8;
    let size = 0;
    let n = 0;
    while (n + start < data.length) {
      const b = data[start + n];
      const cost = b === 0x23 || b === 0x24 || b === 0x7d || b === 0x2a ? 2 : 1;
      if (size + cost > budget) break;
      size += cost;
      n++;
    }
    return n;
  }

  async flashWrite(address: number, data: Uint8Array, onProgress?: (written: number) => void) {
    let off = 0;
    while (off < data.length) {
      const addr = address + off;
      const n = this.chunkFor(data, off, addr);
      const head = enc.encode(`vFlashWrite:${addr.toString(16)}:`);
      const body = escapeBinary(data.subarray(off, off + n));
      const pkt = new Uint8Array(head.length + body.length);
      pkt.set(head, 0);
      pkt.set(body, head.length);
      const r = await this.command(pkt, 10000);
      if (r !== "OK") throw new Error(`Flash write failed at 0x${addr.toString(16)} (${r})`);
      off += n;
      onProgress?.(off);
    }
  }

  async flashDone() {
    const r = await this.command("vFlashDone", 30000);
    if (r !== "OK") throw new Error(`Flash finalisation failed (${r})`);
  }

  /** Returns the CRC computed by the probe, or null when qCRC is not supported. */
  async crc(address: number, length: number): Promise<number | null> {
    const r = await this.command(`qCRC:${address.toString(16)},${length.toString(16)}`, 120000);
    if (!r.startsWith("C")) return null;
    return parseInt(r.slice(1), 16) >>> 0;
  }

  async readMemory(address: number, length: number): Promise<Uint8Array> {
    const r = await this.command(`m${address.toString(16)},${length.toString(16)}`, 5000);
    if (r.startsWith("E") || r.length !== length * 2) throw new Error(`Memory read failed at 0x${address.toString(16)}`);
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = parseInt(r.substr(i * 2, 2), 16);
    return out;
  }

  /** Kill: the Black Magic Probe resets the target and detaches (no reply expected). */
  async killAndReset() {
    await this.writePacket(enc.encode("k"));
    await sleep(200);
  }

  async detach() {
    try {
      await this.command("D", 2000);
    } catch {
      /* ignore */
    }
  }
}
