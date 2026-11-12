# e-puck2 Web Programmer

Browser tool to program the three processors of the e-puck2 robot, one tab each:

| Tab | Processor | Transport | Replaces |
|---|---|---|---|
| Main processor | STM32F407 | Web Serial → GDB server (Black Magic Probe) on the STM32F413 | `program_stm32f407.sh` (arm-none-eabi-gdb) |
| Radio module | ESP32 | Web Serial → "Serial Monitor" port, [esptool-js](https://github.com/espressif/esptool-js) | `program_esp32.sh` (esptool.py) |
| Programmer | STM32F413 (robot ID < 5400) / STM32L452 (ID ≥ 5400) | WebUSB → STM32 ROM DFU bootloader (DfuSe) | dfu-util / DfuSe / STM32CubeProgrammer |

Requires a Chromium-based desktop browser (Chrome, Edge, Opera…) and the page served over
`https://` or `http://localhost` (Web Serial and WebUSB are only available in secure contexts).

## Development

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/ (relative paths, can be hosted anywhere over HTTPS)
```

esptool-js comes from npm (`esptool-js`, pinned to an exact version in `package.json`). The ESP32 tab
replaces a few esptool-js internals to use the ESP32 ROM loader through the e-puck2 bridge (see
`src/esp32.ts`), so check the ESP32 tab on a robot before upgrading it.

## Publishing on GitHub Pages

`.github/workflows/deploy.yml` builds and publishes the site on every push to `main`
(or manually from the *Actions* tab). The build stops, and nothing is published, if the firmware manifest
is not valid.

One-time setup:

1. Push the contents of this folder as the root of the `e-puck2-web-programmer` repository
   (`node_modules/` and `dist/` are ignored).
2. In the repository, *Settings → Pages → Build and deployment → Source*: select **GitHub Actions**.
3. Push to `main` (or run the workflow from the *Actions* tab): the site is published at
   `https://<user>.github.io/e-puck2-web-programmer/`.

If the app is ever moved into a subfolder of a larger repository, move `.github/workflows/deploy.yml` to the
root `.github/workflows/` and set `APP_DIR` in it to that subfolder.

The site uses relative paths, so it works under any repository name or on a custom domain.
GitHub Pages serves it over HTTPS, as Web Serial and WebUSB require.

## Official firmwares

Every tab offers **Official firmware** (default) or **Your own file**. The official firmwares are
published with the page, in `public/firmware/`, and described by `public/firmware/manifest.json`.
The page reads the manifest at runtime, so no code change is needed to publish a new release.

```
public/firmware/
├── manifest.json
├── main/         e-puck2_main-processor_<date>_<commit>.elf
├── radio/        esp32-firmware_<date>_<commit>_2.1/   (e-puck 2.0 / 2.1)
│                 esp32-firmware_<date>_<commit>_2.2/   (e-puck 2.2, ESP32 with PSRAM)
│                     bootloader.bin, partition-table.bin, ESP32_E-Puck_2.bin
└── programmer/   e-puck2_programmer_F413_<date>_<commit>.bin   (robot ID < 5400)
                  e-puck2_programmer_L452_<date>_<commit>.hex   (robot ID ≥ 5400)
```

### Publishing a new firmware

1. Copy the new file(s) into the right folder under `public/firmware/` (for the radio module, a new
   folder with the three `.bin` files).
2. In `manifest.json`, add a new entry **at the top** of the matching list (`main`, `radio` or
   `programmer`): the first entry for each robot version / chip is the one selected by default and
   marked “latest”. Older entries can stay (they remain selectable) or be removed together with their files.
3. Run `npm run check-firmware` (it also runs automatically before `npm run build`): it checks that
   every file exists and the entries are valid, and stops the build if not.
4. Commit and push: GitHub Pages publishes the new version.

Entry fields:

| List | Fields |
|---|---|
| `main` | `label`, `version`, `commit` (optional), `file` (`.elf`, or `.bin` + `address`, or `.hex`), `notes` (optional) |
| `radio` | `label`, `hardware` (`"2.2"` or `"2.0-2.1"`), `version`, `commit`, `images`: list of `{ name, offset, file }` |
| `programmer` | `label`, `chip` (`"f413"` or `"l452"`), `version`, `commit`, `file` (`.bin` + `address`, `.hex`, `.dfu` or `.elf`) |

Example of a new main processor release:

```json
"main": [
  { "label": "Factory firmware", "version": "01.06.26", "commit": "abc1234",
    "file": "main/e-puck2_main-processor_01.06.26_abc1234.elf" },
  { "label": "Factory firmware", "version": "05.02.26", "commit": "3f17433",
    "file": "main/e-puck2_main-processor_05.02.26_3f17433.elf" }
]
```

Safety checks in the page: for the radio module the robot version (2.0/2.1 or 2.2) must be chosen
explicitly before programming; for the programmer the official firmware follows the robot version selected
in the DFU guide, and programming is refused if the chip found in DFU mode (F413 or L452) does not match.

## Supported files

- **STM32F407**: `.elf` (sections loaded at their LMA, like gdb `load`), `.bin` (load address configurable), `.hex`.
- **ESP32**: separate images (bootloader `0x1000`, partition table `0x8000`, application `0x10000`, editable,
  rows can be added) or one merged image (default offset `0x0`). Baud rate selectable (230400 default,
  115200, 460800, 921600 or custom); the connection always starts at 115200 and then switches.
  The ROM loader is used (the esptool-js stub does not start through the programmer's serial bridge,
  which appears to run at a fixed ~230400 baud), with a configurable pause after each 1 KB block (default 10 ms)
  to make corrupted blocks rarer. Images are written in independent 64 KB parts (`src/espWriter.ts`), each
  with its own compressed stream and MD5 check: a part that fails (a block occasionally arrives corrupted through
  the bridge, “status 1,5”) is written again after resynchronising or reconnecting, up to 6 attempts.
  Other flashing tools were tried and set aside: see [ESP32 flashing tools: test results](#esp32-flashing-tools-test-results).
  These settings are under *Advanced options*, locked by default (unlocking enables editing, locking restores the defaults).
- **STM32F413 / STM32L452**: `.bin` (default `0x08000000`), `.dfu` (DfuSe), `.hex`, `.elf`. Only the sectors covered by the
  image are erased. The tab includes an animated guide to enter DFU mode for both programmer versions; the L452
  photos in `public/dfu/` are resized copies of the original photos of the L452 DFU procedure, the F413 one
  (`f413-pinholes.png`) comes from the GCtronic wiki.

## ESP32 flashing tools: test results

Through the e-puck2 programmer bridge a block now and then reaches the ESP32 corrupted (“status 1,5”,
roughly once every ~1500 blocks of 1 KB), so a tool that writes the 3 MB application in one go fails as soon
as one block is hit. Four tools were compared on a robot (e-puck 2.2, official radio firmware 06.02.26):

| Tool | 230400 baud | 115200 baud |
| --- | --- | --- |
| **esptool-js · ROM loader, 64 KB parts, MD5, retries** (kept) | Works: 148–176 s, 2–3 parts written again | Works |
| esptool-js · legacy stub (esptool v3 generation), 64 KB parts | Fails: the stub starts, but reopening the port at the new baud resets the ESP32 and the stub upload then fails (“Invalid head of packet (0x0)”) | Works, but less clean: 147 s, 6 parts written again; once the stub stopped answering (“status 201,0”) and the reconnect fell back to the ROM loader |
| esp-web-flasher 5.1.5 (Nabu Casa) · legacy stub, whole images | Fails: “Timed out waiting for packet header” right after the baud change | Stub runs, but the write hung at 34% of the application with no error; the page had to be reloaded |
| tasmota-webserial-esptool 9.4.2 · its stub, else ROM loader, whole images | Stub does not start (same stub as esptool-js), ROM loader: “Timed out waiting for packet header” while writing the application | Stub does not start, ROM loader: worked once, 114 s, MD5 ok, but with no retry a single corrupted block makes it fail |

Kept: esptool-js with the ROM loader and independent 64 KB parts (`src/esp32.ts`, `src/espWriter.ts`), the only
one that recovers from a corrupted block. The others are left in the code, disabled:

- the tool choice (`#esp-tool` select) is commented out in `index.html`, and the page always uses `"rom"`;
- the legacy stub stays in `src/esp32.ts` (`runLegacyStub`, `src/stubs/esp32-legacy.json`), reachable only from that select;
- `src/espWebFlasher.ts` and `src/espTasmota.ts` are not imported (imports and dispatch commented out in `src/esp32.ts`),
  so they are not in the build; they are still type-checked, which is why `esp-web-flasher` and
  `tasmota-webserial-esptool` remain in `package.json`.

To compare again, uncomment the select in `index.html` and the imports and dispatch in `src/esp32.ts`. To drop
them for good, delete the two files, the legacy stub, and the two dependencies.

Other web flashers checked: ESP Web Tools / web.esphome.io use esptool-js; flashesp.com and espboards.dev do not
publish their code.

## Source layout

- `src/gdb.ts` – GDB remote serial protocol client (qSupported, monitor, vAttach, memory map, vFlash*, qCRC).
- `src/f407.ts` – STM32F407 tab.
- `src/esp32.ts` – ESP32 tab (esptool-js), `src/md5.ts` for flash verification.
- `src/dfu.ts` – WebUSB DfuSe implementation; `src/f413.ts` – programmer tab; `src/dfuGuide.ts` – DFU mode guide.
- `src/firmware.ts` – ELF / Intel HEX / DfuSe / binary loaders.
- `src/catalog.ts` – official firmware list (`public/firmware/manifest.json`) and downloads; `src/sourceUi.ts` – “Official firmware / Your own file” choice.
- `scripts/check-firmware.mjs` – validates the firmware manifest (runs before every build).

## Drivers

- Windows, STM32F413 DFU: install the **WinUSB** driver for `STM32 BOOTLOADER` (0483:df11) with Zadig.
- Windows, serial ports (1d50:6018, GDB Server and Serial Monitor): keep the built-in serial driver (`usbser`,
  *Ports (COM & LPT)*); Web Serial only sees COM ports. If Zadig switched one to WinUSB, uninstall that device
  in Device Manager with *Attempt to remove the driver for this device* ticked, then reconnect the robot.
  If the driver is still in use, list it with `pnputil /enum-drivers` and remove it with
  `pnputil /delete-driver oemNN.inf /uninstall /force`.

### ESP32 reset through the programmer

The programmer firmware drives the ESP32 from the control lines of the Serial Monitor port: EN = not RTS,
and GPIO0 goes low (download mode) once DTR and RTS are both set, staying low until DTR is cleared. The page
therefore uses its own reset sequences (`EpuckClassicReset`, `EpuckHardReset` in `src/esp32.ts`) that change
one line at a time, like esptool.py: (DTR,RTS) = (0,1) → (1,1) → (1,0) → (0,0). The esptool-js default sets
both lines in one call, which on Windows (usbser.sys sends an RTS change only with the next DTR change) restarts
the ESP32 in normal mode: “Failed to connect with the device”.
- Linux: user in the `dialout` group for the serial ports; udev rule for 0483:df11, e.g.
  `SUBSYSTEMS=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="df11", MODE="0666"`.
