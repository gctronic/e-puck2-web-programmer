// Small UI helpers shared by the three tabs.

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`Element not found: ${sel}`);
  return el;
};

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type LogLevel = "info" | "ok" | "warn" | "error" | "dim";

/** Log console bound to a container element. */
export class Logger {
  private partial: HTMLSpanElement | null = null;

  constructor(private el: HTMLElement) {}

  clear() {
    this.el.textContent = "";
    this.partial = null;
  }

  /** Append text without terminating the line (used for esptool progress dots). */
  write(text: string, level: LogLevel = "dim") {
    if (!this.partial) {
      this.partial = document.createElement("span");
      this.partial.className = `log-${level}`;
      this.el.appendChild(this.partial);
    }
    this.partial.textContent += text;
    this.scroll();
  }

  line(text: string, level: LogLevel = "info") {
    if (this.partial) {
      this.el.appendChild(document.createTextNode("\n"));
      this.partial = null;
    }
    const span = document.createElement("span");
    span.className = `log-${level}`;
    span.textContent = text + "\n";
    this.el.appendChild(span);
    this.scroll();
  }

  info = (t: string) => this.line(t, "info");
  ok = (t: string) => this.line(t, "ok");
  warn = (t: string) => this.line(t, "warn");
  error = (t: string) => this.line(t, "error");
  dim = (t: string) => this.line(t, "dim");

  private scroll() {
    this.el.scrollTop = this.el.scrollHeight;
  }
}

/** Progress bar with a label ("Erasing", "Writing", ...) and percentage. */
export class Progress {
  private bar: HTMLElement;
  private label: HTMLElement;
  private pct: HTMLElement;

  constructor(private root: HTMLElement) {
    this.bar = $(".progress-fill", root);
    this.label = $(".progress-label", root);
    this.pct = $(".progress-pct", root);
    this.reset();
  }

  reset() {
    this.root.dataset.state = "idle";
    this.set("Idle", 0);
  }

  set(label: string, fraction: number) {
    const f = Math.max(0, Math.min(1, fraction));
    this.label.textContent = label;
    this.bar.style.width = `${(f * 100).toFixed(1)}%`;
    this.pct.textContent = `${Math.floor(f * 100)}%`;
    if (this.root.dataset.state !== "error") this.root.dataset.state = "busy";
  }

  done(label = "Done") {
    this.set(label, 1);
    this.root.dataset.state = "done";
  }

  fail(label = "Failed") {
    this.label.textContent = label;
    this.root.dataset.state = "error";
  }
}

/** Parse "0x1000", "4096" or "1000h" style numbers. */
export function parseAddress(text: string): number {
  const t = text.trim().toLowerCase();
  let v: number;
  if (t.startsWith("0x")) v = parseInt(t.slice(2), 16);
  else if (t.endsWith("h")) v = parseInt(t.slice(0, -1), 16);
  else v = parseInt(t, 10);
  if (!Number.isFinite(v) || v < 0) throw new Error(`Invalid address "${text}"`);
  return v >>> 0;
}

/**
 * Wire a drop zone + hidden <input type=file>. The callback receives the dropped/selected files.
 */
export function bindDropZone(zone: HTMLElement, input: HTMLInputElement, onFiles: (files: File[]) => void) {
  zone.addEventListener("click", () => input.click());
  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener("change", () => {
    if (input.files && input.files.length) onFiles([...input.files]);
    input.value = "";
  });
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("drag");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("drag");
    const files = e.dataTransfer?.files;
    if (files && files.length) onFiles([...files]);
  });
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Serialises operations per tab and toggles the busy state of the given controls. */
export async function runExclusive(controls: HTMLElement[], fn: () => Promise<void>) {
  const prev = controls.map((c) => (c as HTMLButtonElement).disabled);
  controls.forEach((c) => ((c as HTMLButtonElement).disabled = true));
  document.body.classList.add("busy");
  try {
    await fn();
  } finally {
    controls.forEach((c, i) => ((c as HTMLButtonElement).disabled = prev[i]));
    document.body.classList.remove("busy");
  }
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
