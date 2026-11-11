// Validates public/firmware/manifest.json and the files it references.
// Runs before every build (npm run build) and on its own with: npm run check-firmware
// Exits with an error, stopping the build/deploy, if something is wrong.

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "firmware");
const errors = [];
const lines = [];

function fail(where, msg) {
  errors.push(`${where}: ${msg}`);
}

function readFile(where, rel) {
  if (typeof rel !== "string" || !rel) {
    fail(where, `"file" is missing`);
    return null;
  }
  if (rel.startsWith("/") || rel.includes("..")) {
    fail(where, `"file" must be a path relative to public/firmware/ (got "${rel}")`);
    return null;
  }
  const path = join(root, rel);
  try {
    if (!statSync(path).isFile()) throw new Error();
  } catch {
    fail(where, `file not found: public/firmware/${rel}`);
    return null;
  }
  const data = readFileSync(path);
  if (data.length === 0) fail(where, `file is empty: ${rel}`);
  return data;
}

function checkCommon(where, e) {
  for (const key of ["label", "version"]) {
    if (typeof e[key] !== "string" || !e[key].trim()) fail(where, `"${key}" is missing`);
  }
  if (e.commit !== undefined && typeof e.commit !== "string") fail(where, `"commit" must be a string`);
}

const isAddress = (v) => typeof v === "string" && /^0x[0-9a-f]+$/i.test(v);
const isElf = (d) => d && d.length > 4 && d[0] === 0x7f && d[1] === 0x45 && d[2] === 0x4c && d[3] === 0x46;

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
} catch (e) {
  console.error(`✖ public/firmware/manifest.json: ${e.message}`);
  process.exit(1);
}

for (const section of ["main", "radio", "programmer"]) {
  if (!Array.isArray(manifest[section]) || manifest[section].length === 0) {
    fail(section, "must be a non-empty list (the first entry is the latest firmware)");
    manifest[section] = [];
  }
}

manifest.main.forEach((e, i) => {
  const where = `main[${i}]`;
  checkCommon(where, e);
  const data = readFile(where, e.file);
  const lower = (e.file || "").toLowerCase();
  if (data && lower.endsWith(".elf") && !isElf(data)) fail(where, "not a valid ELF file");
  if (data && !/\.(elf|bin|hex)$/.test(lower)) fail(where, "main firmware must be .elf, .bin or .hex");
  if (lower.endsWith(".bin") && !isAddress(e.address)) fail(where, `.bin files need "address" (e.g. "0x08000000")`);
  lines.push(`main        ${e.version.padEnd(10)} ${e.file}`);
});

const hardwareSeen = new Set();
manifest.radio.forEach((e, i) => {
  const where = `radio[${i}]`;
  checkCommon(where, e);
  if (!["2.0-2.1", "2.2"].includes(e.hardware)) fail(where, `"hardware" must be "2.0-2.1" or "2.2"`);
  hardwareSeen.add(e.hardware);
  if (!Array.isArray(e.images) || e.images.length === 0) {
    fail(where, `"images" must list the .bin files with their offsets`);
    return;
  }
  e.images.forEach((img, j) => {
    const w = `${where}.images[${j}]`;
    if (!isAddress(img.offset)) fail(w, `"offset" must be a hex address like "0x1000"`);
    const data = readFile(w, img.file);
    if (data && img.offset === "0x1000" && data[0] !== 0xe9) fail(w, "bootloader at 0x1000 must be an ESP32 image (first byte 0xE9)");
    if (data && img.offset === "0x10000" && data[0] !== 0xe9) fail(w, "application at 0x10000 must be an ESP32 image (first byte 0xE9)");
  });
  lines.push(`radio ${e.hardware.padEnd(7)} ${e.version.padEnd(10)} ${e.images.length} images`);
});
for (const hw of ["2.0-2.1", "2.2"]) {
  if (!hardwareSeen.has(hw)) fail("radio", `no firmware for hardware "${hw}"`);
}

const chipSeen = new Set();
manifest.programmer.forEach((e, i) => {
  const where = `programmer[${i}]`;
  checkCommon(where, e);
  if (!["f413", "l452"].includes(e.chip)) fail(where, `"chip" must be "f413" or "l452"`);
  chipSeen.add(e.chip);
  const data = readFile(where, e.file);
  const lower = (e.file || "").toLowerCase();
  if (data && !/\.(bin|hex|dfu|elf)$/.test(lower)) fail(where, "programmer firmware must be .bin, .hex, .dfu or .elf");
  if (lower.endsWith(".bin") && !isAddress(e.address)) fail(where, `.bin files need "address" (e.g. "0x08000000")`);
  lines.push(`programmer  ${e.chip.padEnd(10)} ${e.version.padEnd(10)} ${e.file}`);
});
for (const chip of ["f413", "l452"]) {
  if (!chipSeen.has(chip)) fail("programmer", `no firmware for chip "${chip}"`);
}

if (errors.length) {
  console.error("✖ Firmware manifest has errors:");
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log("✔ Firmware manifest OK");
for (const l of lines) console.log("  " + l);
