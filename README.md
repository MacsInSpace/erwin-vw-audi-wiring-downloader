# erwin-downloader

Playwright-based downloader for VW Group erWin wiring/fitting PDFs.

- Logs in to erWin https://volkswagen.erwin-store.com/
- Looks up VINs
- Captures chapter list from `getwdnavigationtree`
- Downloads documents via `printWiringDiagram`
- Falls back to `getwddoccontent` for specific error cases (e.g. 9114E / too-large print cases)

## Requirements

- Node.js 18+
- macOS / Linux / Windows (tested mainly on macOS)
- Active erWin account WITH credit to download

## Install

```bash
npm install
npx playwright install chromium
```

Optional browser choices:

- Use installed Chrome:
  ```bash
  export ERWIN_USE_GOOGLE_CHROME=1
  ```
- Use specific Chromium browser (example: Brave on macOS):
  ```bash
  export ERWIN_BROWSER_EXECUTABLE="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  ```

## Configure credentials

```bash
export ERWIN_USERNAME="memyselandEye"
export ERWIN_PASSWORD="Pa55w0rd1!"
```

## Configure VINs

Edit the `VINS` array in `erwin.js`.

Minimal entry:

```js
{ vin: 'WVWZZZCDZ1234567' }
```

Optional override:

```js
{ vin: 'WVWZZZCDZ1234567', brand: 'audi' }
```

Brand is auto-inferred from VIN WMI when possible (`volkswagen`, `audi`, `skoda`, `seat`, `cupra`).

## Run

```bash
node erwin.js
```

Output goes to:

```text
./erwin_pdfs/<auto_label>/
```

Each VIN folder includes:

- Downloaded PDFs
- `_chapters.json`
- `<parentDocId>_subsections_index.json` for split oversized chapters (when applicable)

## Common environment variables

- `HEADLESS=1` - run headless
- `ERWIN_MANUAL_LOGIN=1` - complete login manually in opened browser, then press Enter in terminal
- `ERWIN_RELOGIN_COOLDOWN_MS=15000` - cooldown before hard auth re-login
- `ERWIN_SKIP_DOCUMENT_IDS="6766244 1234567"` - skip specific chapter IDs
- `ERWIN_PRINT_NO_DOCCONTENT_FALLBACK=1` - disable fallback PDF rendering path
- `ERWIN_PDF_SCALE=1`
- `ERWIN_PDF_SCALE_API=0.82`

Brand host overrides (if your region uses different hostnames):

- `ERWIN_HOST_VOLKSWAGEN`
- `ERWIN_HOST_AUDI`
- `ERWIN_HOST_SKODA`
- `ERWIN_HOST_SEAT`
- `ERWIN_HOST_CUPRA`

## Behavior notes

- `printWiringDiagram` is preferred for native print formatting.
- If erWin returns 9114E or print-too-large scenarios, script may retry and/or use `getwddoccontent` fallback.
- Very large chapters can still have minor formatting differences in fallback-rendered PDFs.
- erWin may rate-limit or temporarily block accounts if many VIN lookups happen quickly.

## Troubleshooting

- Use `HEADLESS=0` for visual debugging.
- If login fails repeatedly, try manual login mode:
  ```bash
  ERWIN_MANUAL_LOGIN=1 HEADLESS=0 node erwin.js
  ```
- If a chapter is consistently problematic, skip it via `ERWIN_SKIP_DOCUMENT_IDS`.

