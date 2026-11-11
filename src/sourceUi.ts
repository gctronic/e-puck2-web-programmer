// Shared UI for the "Official firmware / Your own file" choice of every tab.

import { firmwareUrl, versionText } from "./catalog";
import { $, escapeHtml } from "./ui";

export type Source = "official" | "local";

/** Wires the source switch of a tab; returns a getter for the current choice. */
export function bindSourceSwitch(root: HTMLElement, prefix: string, onChange: () => void): () => Source {
  const inputs = [...root.querySelectorAll<HTMLInputElement>(`input[name=${prefix}-src]`)];
  const official = $(".src-official", root);
  const local = $(".src-local", root);
  const get = () => (inputs.find((i) => i.checked)?.value ?? "official") as Source;
  const show = () => {
    official.hidden = get() !== "official";
    local.hidden = get() !== "local";
  };
  inputs.forEach((i) =>
    i.addEventListener("change", () => {
      show();
      onChange();
    }),
  );
  show(); // initial state only: the caller updates its own UI after this returns
  return get;
}

/** Switches a tab to "Your own file" (used when the firmware list cannot be loaded). */
export function forceLocal(root: HTMLElement, prefix: string) {
  const local = root.querySelector<HTMLInputElement>(`input[name=${prefix}-src][value=local]`);
  if (local && !local.checked) {
    local.checked = true;
    local.dispatchEvent(new Event("change"));
  }
}

/** Version, commit and download links of an official firmware entry. */
export function renderMeta(el: HTMLElement, entry: { version: string; commit?: string; notes?: string } | null, files: string[]) {
  if (!entry) {
    el.innerHTML = "";
    return;
  }
  const links = files
    .map((f) => {
      const name = f.split("/").pop()!;
      return `<a href="${escapeHtml(firmwareUrl(f))}" download="${escapeHtml(name)}">${escapeHtml(name)}</a>`;
    })
    .join(", ");
  el.innerHTML =
    `<div><span class="fw-version">${escapeHtml(versionText(entry))}</span></div>` +
    (entry.notes ? `<div class="fw-notes">${escapeHtml(entry.notes)}</div>` : "") +
    `<div class="fw-files">Files: ${links}</div>`;
}

export function showListError(el: HTMLElement, msg: string) {
  el.innerHTML = `<div class="file-error">${escapeHtml(msg)}. Use “Your own file”.</div>`;
}
