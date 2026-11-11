import "./style.css";
import { initEsp32 } from "./esp32";
import { initF407 } from "./f407";
import { initF413 } from "./f413";
import { initDfuGuide } from "./dfuGuide";

const TABS = ["f407", "esp32", "f413"] as const;
type Tab = (typeof TABS)[number];

function selectTab(tab: Tab, focus = false) {
  for (const t of TABS) {
    const btn = document.getElementById(`tabbtn-${t}`)!;
    const panel = document.getElementById(`tab-${t}`)!;
    const active = t === tab;
    btn.setAttribute("aria-selected", String(active));
    btn.tabIndex = active ? 0 : -1;
    panel.hidden = !active;
    if (active && focus) btn.focus();
  }
  // The serial port troubleshooting only concerns the STM32F407 and ESP32 tabs.
  document.getElementById("serial-help")!.hidden = tab === "f413";
  if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
}

function initTabs() {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>(".tab")];
  buttons.forEach((b, i) => {
    b.addEventListener("click", () => selectTab(b.dataset.tab as Tab));
    b.addEventListener("keydown", (e) => {
      let j = -1;
      if (e.key === "ArrowRight") j = (i + 1) % buttons.length;
      if (e.key === "ArrowLeft") j = (i - 1 + buttons.length) % buttons.length;
      if (j >= 0) {
        e.preventDefault();
        selectTab(buttons[j].dataset.tab as Tab, true);
      }
    });
  });
  const fromHash = location.hash.slice(1) as Tab;
  selectTab(TABS.includes(fromHash) ? fromHash : "f407");
  window.addEventListener("hashchange", () => {
    const h = location.hash.slice(1) as Tab;
    if (TABS.includes(h)) selectTab(h);
  });
}

function checkSupport() {
  const ok = "serial" in navigator && "usb" in navigator && window.isSecureContext;
  document.getElementById("unsupported")!.hidden = ok;
}

// Prevent the browser from opening files dropped outside a drop zone.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

// Warn before leaving while programming.
window.addEventListener("beforeunload", (e) => {
  if (document.body.classList.contains("busy")) e.preventDefault();
});

/** "Copy" button of every log: copies the log text to the clipboard. */
function initCopyButtons() {
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".btn-copy")) {
    const log = btn.closest(".col-output")!.querySelector<HTMLElement>(".log")!;
    btn.addEventListener("click", async () => {
      const text = log.textContent ?? "";
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        // Fallback for browsers/contexts without the async clipboard API.
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        ta.remove();
      }
      btn.textContent = ok ? "Copied" : "Copy failed";
      btn.classList.toggle("copied", ok);
      setTimeout(() => {
        btn.textContent = "Copy";
        btn.classList.remove("copied");
      }, 1500);
    });
  }
}

checkSupport();
initCopyButtons();
initTabs();
initF407();
initEsp32();
initF413();
initDfuGuide();
