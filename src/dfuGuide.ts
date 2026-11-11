// Step-by-step guide (photos + animated markers) to put the e-puck2 programmer in DFU mode.
// Robots with id < 5400 have an STM32F413 programmer, from id 5400 an STM32L452.

import { $ } from "./ui";

interface Marker {
  /** Position in percent of the image size. */
  x: number;
  y: number;
  /** Diameter in percent of the image width. */
  size?: number;
  label: string;
  /** Secondary markers are drawn dimmed and without pulse (e.g. a short already done). */
  secondary?: boolean;
}

interface Step {
  title: string;
  text: string;
  image: string;
  alt: string;
  markers: Marker[];
  detail?: { image: string; alt: string; label: string };
}

// Local copy of https://www.gctronic.com/doc/images/1/1d/e-puck2_top_leds_DFU_413.png (GCtronic wiki).
const WIKI_IMAGE = "dfu/f413-pinholes.png";

const GUIDES: Record<"f413" | "l452", Step[]> = {
  f413: [
    {
      title: "Find the two pin holes",
      text: "The two pin holes for DFU mode are near the USB connector of the robot (red box). The robot can stay switched off.",
      image: WIKI_IMAGE,
      alt: "Top of the e-puck2 near the USB connector, with the two DFU pin holes highlighted",
      markers: [{ x: 91, y: 75, size: 26, label: "Short" }],
    },
    {
      title: "Short them and plug the USB cable",
      text: "Keep the two pin holes shorted (e.g. with tweezers or a wire) while you plug the USB cable in. When the computer shows STM32 BOOTLOADER, the short can be removed.",
      image: WIKI_IMAGE,
      alt: "The two DFU pin holes to keep shorted while plugging the USB cable",
      markers: [{ x: 91, y: 75, size: 26, label: "Keep shorted" }],
    },
  ],
  l452: [
    {
      title: "Remove the LED ring",
      text: "Take off the transparent ring around the top of the robot to reach the pads on the board.",
      image: "dfu/l452-step1.jpg",
      alt: "e-puck2 board with the LED ring removed and placed beside it",
      markers: [{ x: 23, y: 60, size: 40, label: "LED ring" }],
    },
    {
      title: "Short the “boot programmer” pins",
      text: "Put a jumper or tweezers on the two “boot programmer” pins on the edge of the board, next to the red connector.",
      image: "dfu/l452-step2.jpg",
      alt: "Tweezers shorting the two boot programmer pins on the left edge of the board",
      markers: [{ x: 29, y: 57.5, size: 9, label: "Boot pins" }],
    },
    {
      title: "Short the second point",
      text: "Keeping the boot pins shorted, short the second point next to the rotary switch with another pair of tweezers (pads between T16 and R24, see the PCB detail).",
      image: "dfu/l452-step3.jpg",
      alt: "Second pair of tweezers shorting the pads near the rotary switch",
      markers: [
        { x: 15, y: 53.5, size: 7, label: "Boot pins", secondary: true },
        { x: 77, y: 50.5, size: 8, label: "Short" },
      ],
      detail: { image: "dfu/l452-short-detail.jpg", alt: "PCB layout detail of the short between T16 and R24", label: "PCB detail" },
    },
    {
      title: "Plug the USB cable",
      text: "With both shorts in place, plug the USB cable in and wait until the computer shows STM32 BOOTLOADER. Then remove the tweezers. The robot does not need to be switched on.",
      image: "dfu/l452-step4.jpg",
      alt: "USB cable plugged in while both points are kept shorted",
      markers: [
        { x: 13, y: 71, size: 14, label: "USB" },
        { x: 4.5, y: 44, size: 7, label: "Boot pins", secondary: true },
        { x: 84, y: 41, size: 8, label: "Short", secondary: true },
      ],
    },
  ],
};

export function initDfuGuide() {
  const root = $(".dfu-guide");
  const variantInputs = [...root.querySelectorAll<HTMLInputElement>("input[name=dfu-variant]")];
  const figure = $(".guide-figure", root);
  const img = $<HTMLImageElement>(".guide-image", root);
  const markersEl = $(".guide-markers", root);
  const title = $(".guide-title", root);
  const text = $(".guide-text", root);
  const counter = $(".guide-counter", root);
  const dots = $(".guide-dots", root);
  const prev = $<HTMLButtonElement>(".guide-prev", root);
  const next = $<HTMLButtonElement>(".guide-next", root);
  const detailBtn = $<HTMLButtonElement>(".guide-detail", root);

  let variant: "f413" | "l452" = "f413";
  let index = 0;
  let showDetail = false;

  try {
    const saved = localStorage.getItem("dfu-variant");
    if (saved === "f413" || saved === "l452") variant = saved;
  } catch {
    /* storage not available */
  }
  variantInputs.forEach((i) => (i.checked = i.value === variant));

  function render() {
    const steps = GUIDES[variant];
    const step = steps[index];
    const useDetail = showDetail && !!step.detail;

    // Restart the fade-in animation.
    figure.classList.remove("enter");
    void figure.offsetWidth;
    figure.classList.add("enter");

    img.src = useDetail ? step.detail!.image : step.image;
    img.alt = useDetail ? step.detail!.alt : step.alt;
    markersEl.innerHTML = "";
    if (!useDetail) {
      for (const m of step.markers) {
        const el = document.createElement("div");
        el.className = "marker" + (m.secondary ? " secondary" : "");
        el.style.left = `${m.x}%`;
        el.style.top = `${m.y}%`;
        el.style.width = `${m.size ?? 10}%`;
        el.innerHTML = `<span class="marker-label">${m.label}</span>`;
        markersEl.appendChild(el);
      }
    }

    title.textContent = step.title;
    text.textContent = step.text;
    counter.textContent = `Step ${index + 1} of ${steps.length}`;
    dots.innerHTML = "";
    steps.forEach((_, i) => {
      const d = document.createElement("button");
      d.className = "guide-dot" + (i === index ? " active" : "");
      d.setAttribute("aria-label", `Step ${i + 1}`);
      d.addEventListener("click", () => go(i));
      dots.appendChild(d);
    });
    prev.disabled = index === 0;
    next.disabled = index === steps.length - 1;
    detailBtn.hidden = !step.detail;
    detailBtn.textContent = useDetail ? "Back to photo" : step.detail?.label ?? "";
  }

  function go(i: number) {
    index = Math.max(0, Math.min(GUIDES[variant].length - 1, i));
    showDetail = false;
    render();
  }

  prev.addEventListener("click", () => go(index - 1));
  next.addEventListener("click", () => go(index + 1));
  detailBtn.addEventListener("click", () => {
    showDetail = !showDetail;
    render();
  });
  figure.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") go(index + 1);
    if (e.key === "ArrowLeft") go(index - 1);
  });
  for (const input of variantInputs) {
    input.addEventListener("change", () => {
      variant = input.value as "f413" | "l452";
      try {
        localStorage.setItem("dfu-variant", variant);
      } catch {
        /* ignore */
      }
      go(0);
    });
  }
  render();
}
