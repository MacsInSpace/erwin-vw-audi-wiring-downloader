#!/usr/bin/env node
// erwin_print.js — Erwin wiring / locations → PDF (Playwright)
//
// Setup: cd erwin_package && npm install && npx playwright install chromium
// Optional browsers:
//   ERWIN_USE_GOOGLE_CHROME=1  → needs Google Chrome at default path, or: npx playwright install chrome
//   ERWIN_BROWSER_EXECUTABLE=/path/to/browser  → e.g. Brave on macOS:
//     /Applications/Brave Browser.app/Contents/MacOS/Brave Browser
//
// Credentials:
// export ERWIN_USERNAME=memyselandEye
// export ERWIN_PASSWORD=Pa55w0rd1!
// Automated login matches erwin_download_9.js: showHome.do → username/#username → password → submit click, then showLogin.do if needed.
// If automated login is blocked: ERWIN_MANUAL_LOGIN=1  (you sign in in the opened window, then press Enter in the terminal)
//
// Usage: node erwin.js
//
// Chapters: after each VIN, `_chapters.json` is written next to the PDFs (wiring + locations lists).
// PDFs: simple loop over chapter docIds via printWiringDiagram URL.

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

/** Each entry may set `brand`; run folder label is always auto-derived from Erwin after VIN lookup. */
const VINS = [
  { vin: 'WVWZZZCD123456783' },
  { vin: 'WVWZZZCD123456781' },
  { vin: 'WVGZZZA1123456786' },
  { vin: 'WVWZZZ3C123456783' },
  { vin: 'WVWZZZ3H123456784' },
  { vin: 'WVGZZZC1234567839' },
  { vin: 'WUAZZZS1234567871' },
];


/** Default shop: volkswagen | audi | skoda | seat | cupra */
const DEFAULT_BRAND = 'volkswagen';

const DOWNLOAD = 'both';   // 'wiring' | 'locations' | 'both'
const OUT_DIR  = './erwin_pdfs';
/** Set HEADLESS=1 in the environment for unattended runs (default: visible browser). */
const HEADLESS = ['1', 'true', 'yes'].includes(String(process.env.HEADLESS || '').toLowerCase());
/** Global UI settle pause used by login/navigation helpers (ms). */
const UI_SETTLE_MS = Math.max(0, parseInt(process.env.ERWIN_UI_SETTLE_MS || '300', 10) || 300);

/** Extra pause before first login submit (ms). */
const LOGIN_SUBMIT_DELAY_MS = Math.max(0, parseInt(process.env.ERWIN_LOGIN_SUBMIT_DELAY_MS || '700', 10) || 700);
/** After session retry, wait before opening login again (ms). */
const RELOGIN_COOLDOWN_MS = Math.max(5000, parseInt(process.env.ERWIN_RELOGIN_COOLDOWN_MS || '15000', 10) || 15000);

/** You complete login in the browser; script continues after Enter in terminal (best when bots block automation). */
const MANUAL_LOGIN = ['1', 'true', 'yes'].includes(String(process.env.ERWIN_MANUAL_LOGIN || '').toLowerCase());

/** Use installed Google Chrome (`channel: 'chrome'`) instead of Playwright’s Chromium — often passes stricter sites. */
const USE_GOOGLE_CHROME = ['1', 'true', 'yes'].includes(String(process.env.ERWIN_USE_GOOGLE_CHROME || '').toLowerCase());

/** Full path to a Chromium-based binary (Chrome, Brave, Edge). Overrides ERWIN_USE_GOOGLE_CHROME when set. */
const BROWSER_EXECUTABLE = String(
  process.env.ERWIN_BROWSER_EXECUTABLE || process.env.ERWIN_CHROME_EXECUTABLE || ''
).trim();

/** ms between keystrokes for login fields (0 = immediate .fill()). */
const LOGIN_TYPE_DELAY_MS = Math.max(0, parseInt(process.env.ERWIN_LOGIN_TYPE_DELAY_MS || '0', 10) || 0);

/** Last resort: set to 1 only if Erwin lockout message is a false positive on your locale (rare). */
const SKIP_LOGIN_LOCKOUT_CHECK = ['1', 'true', 'yes'].includes(
  String(process.env.ERWIN_SKIP_LOGIN_LOCKOUT_CHECK || '').toLowerCase()
);
/** When printWiringDiagram returns 9114E (server fault; manual URL can fail too), skip getwddoccontent PDF fallback. */
const PRINT_NO_DOCCONTENT_FALLBACK = ['1', 'true', 'yes'].includes(
  String(process.env.ERWIN_PRINT_NO_DOCCONTENT_FALLBACK || '').toLowerCase()
);
/** Comma/space-separated chapter `id`s to skip (e.g. `6766244` if Erwin lists a chapter you do not use). */
const SKIP_DOCUMENT_IDS = new Set(
  String(process.env.ERWIN_SKIP_DOCUMENT_IDS || '')
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(Boolean)
);
/** PDF content scale (0.1 - 2). */
const PDF_SCALE = Math.min(2, Math.max(0.1, parseFloat(process.env.ERWIN_PDF_SCALE || '1') || 1));

// ═══════════════════════════════════════════════════════════════

const USERNAME = process.env.ERWIN_USERNAME || '';
const PASSWORD = process.env.ERWIN_PASSWORD || '';
const DISCLAIMER_NAV_TIMEOUT_MS = Math.max(200, parseInt(process.env.ERWIN_DISCLAIMER_NAV_TIMEOUT_MS || '1800', 10) || 1800);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const BRAND_HOSTNAME = {
  volkswagen: process.env.ERWIN_HOST_VOLKSWAGEN || 'volkswagen',
  audi: process.env.ERWIN_HOST_AUDI || 'audi',
  skoda: process.env.ERWIN_HOST_SKODA || 'skoda',
  seat: process.env.ERWIN_HOST_SEAT || 'seat',
  cupra: process.env.ERWIN_HOST_CUPRA || (process.env.ERWIN_HOST_SEAT || 'seat'),
};
function normalizeBrand(input) {
  const b = String(input || '').trim().toLowerCase();
  if (b === 'vw') return 'volkswagen';
  return b;
}
const baseUrl = brand => {
  const key = normalizeBrand(brand);
  const host = BRAND_HOSTNAME[key] || key;
  return `https://${host}.erwin-store.com`;
};

/**
 * VIN WMI (chars 1-3) inference:
 * - Volkswagen commonly uses WVW/WVG/WV1 (plus non-DE plants like 3VW/9BW).
 * - Audi commonly uses WAU/WA1/WUA/WU1/TRU.
 * - Skoda commonly uses TMB.
 * - SEAT/CUPRA commonly uses VSS.
 * Source background: WMI = first 3 VIN chars (ISO 3780 / NHTSA VIN docs).
 */
function inferBrandFromVin(vin) {
  const v = String(vin || '').toUpperCase();
  const wmi = v.slice(0, 3);
  if (['WAU', 'WA1', 'WUA', 'WU1', 'TRU'].includes(wmi)) return 'audi';
  if (['TMB'].includes(wmi)) return 'skoda';
  if (['VSS'].includes(wmi)) return 'seat';
  if (['WVW', 'WVG', 'WV1', '3VW', '9BW'].includes(wmi)) return 'volkswagen';
  return null;
}

function normalizeRunLabel(raw, fallback = 'vehicle') {
  const clean = String(raw || '')
    .trim()
    .replace(/[^\w\s,.()\-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 80);
  return clean || fallback;
}

/** Best-effort extraction of vehicle/model text shown after VIN lookup. */
async function detectVehicleLabelOnPage(page, vin) {
  try {
    const picked = await page.evaluate((vinArg) => {
      const vinNorm = String(vinArg || '').toUpperCase();
      const squash = s => String(s || '').replace(/\s+/g, ' ').trim();
      const bad = /^(vin|search|workshop information|current flow diagrams|stromlaufpl[aä]ne)$/i;
      const looksUseful = s => {
        const t = squash(s);
        if (!t || t.length < 4 || bad.test(t)) return false;
        if (vinNorm && t.toUpperCase() === vinNorm) return false;
        return /[A-Za-z]/.test(t);
      };

      const selectors = [
        '#vehicleDescription',
        '.vehicleDescription',
        '.vehicleData',
        '.vehicleDetails',
        '[id*="vehicle" i]',
        '[class*="vehicle" i]',
        'h1', 'h2', 'h3',
      ];
      for (const sel of selectors) {
        for (const el of Array.from(document.querySelectorAll(sel)).slice(0, 20)) {
          const t = squash(el.textContent || '');
          if (looksUseful(t)) return t;
        }
      }

      const lines = squash(document.body?.innerText || '').split(/\n+/).map(squash).filter(Boolean);
      const vinIdx = vinNorm ? lines.findIndex(l => l.toUpperCase().includes(vinNorm)) : -1;
      if (vinIdx >= 0) {
        for (let i = Math.max(0, vinIdx - 3); i <= Math.min(lines.length - 1, vinIdx + 3); i++) {
          if (i === vinIdx) continue;
          if (looksUseful(lines[i])) return lines[i];
        }
      }
      const title = squash(document.title || '');
      if (looksUseful(title) && !/erwin|elsa/i.test(title)) return title;
      return '';
    }, vin);
    return String(picked || '').trim();
  } catch {
    return '';
  }
}

function launchBase() {
  return {
    headless: HEADLESS,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-popup-blocking',
      '--no-default-browser-check',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  };
}

/** Prefer explicit executable (Brave, etc.), then Chrome channel, then bundled Chromium. */
function launchOptions() {
  const base = launchBase();
  if (BROWSER_EXECUTABLE) return { ...base, executablePath: BROWSER_EXECUTABLE };
  if (USE_GOOGLE_CHROME) return { ...base, channel: 'chrome' };
  return base;
}

/** Reduces obvious `navigator.webdriver` flags (sites may still use other signals). */
async function attachStealth(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
}

async function newErwinContext(browser) {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    ignoreHTTPSErrors: true,
    locale: process.env.ERWIN_LOCALE || 'en-GB',
    ...(process.env.ERWIN_TIMEZONE ? { timezoneId: process.env.ERWIN_TIMEZONE } : {}),
    userAgent:
      process.env.ERWIN_USER_AGENT ||
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    javaScriptEnabled: true,
    hasTouch: false,
    isMobile: false,
  });
  await attachStealth(context);
  return context;
}

async function waitEnterInTerminal(message) {
  if (!process.stdin.isTTY) {
    console.error('[AUTH] No TTY — cannot wait for Enter. Run in a terminal with ERWIN_MANUAL_LOGIN=1, or omit it.');
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => {
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

async function typeLikeHuman(locator, text) {
  if (!text) return;
  if (LOGIN_TYPE_DELAY_MS <= 0) {
    await locator.fill(text);
    return;
  }
  await locator.click({ delay: 50 });
  await locator.pressSequentially(text, { delay: LOGIN_TYPE_DELAY_MS });
}

/** 17-char VIN pattern (no I/O/Q) — used to catch ERWIN_USERNAME mis-set to a VIN. */
function looksLikeVin(s) {
  return typeof s === 'string' && /^[A-HJ-NPR-Z0-9]{17}$/i.test(s.trim());
}

function requireCredentials() {
  if (!USERNAME) {
    console.error(`
[erwin_print] Set ERWIN_USERNAME to your erWin portal login name (also used as userId in API calls).
`);
    process.exit(1);
  }
  if (!MANUAL_LOGIN && !PASSWORD) {
    console.error(`
[erwin_print] Set ERWIN_PASSWORD for automated login, or use ERWIN_MANUAL_LOGIN=1 and sign in yourself in the browser.

  export ERWIN_USERNAME='your_erwin_login'
  export ERWIN_PASSWORD='your_erwin_password'
`);
    process.exit(1);
  }
  if (looksLikeVin(USERNAME)) {
    console.error(`
[erwin_print] ERWIN_USERNAME looks like a 17-character VIN.

  That variable must be your erWin portal login name, not a vehicle VIN.
  VINs belong only in the VINS array inside this script.
`);
    process.exit(1);
  }
  const u = USERNAME.trim().toUpperCase();
  if (VINS.some(({ vin }) => vin.toUpperCase() === u)) {
    console.error(`
[erwin_print] ERWIN_USERNAME matches a VIN listed in VINS[].

  Use your portal account name in ERWIN_USERNAME, not a vehicle VIN.
`);
    process.exit(1);
  }
}

async function tryClick(page, selectors, timeout = 2500) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout })) {
        await el.click();
        return true;
      }
    } catch { /* try next */ }
  }
  return false;
}

async function tryFillFirst(page, value, selectors) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1200 })) {
        await el.fill(value);
        return true;
      }
    } catch { /* try next */ }
  }
  return false;
}

async function dismissCookieBanners(page) {
  for (const sel of [
    'button:has-text("Agree and continue")',
    'button:has-text("Agree")',
    'button:has-text("Accept")',
    'button:has-text("Akzeptieren")',
    'a:has-text("Agree and continue")',
    '#onetrust-accept-btn-handler',
    '.cookie-accept',
  ]) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await btn.click();
      await sleep(UI_SETTLE_MS);
      return;
    }
  }
}

function disclaimerFrames(page) {
  return page.frames().filter((f) => {
    try {
      const u = f.url();
      return u && !u.startsWith('about:') && !u.startsWith('blob:');
    } catch {
      return false;
    }
  });
}

/**
 * Legal / consent gates: showDisclaimer.do (portal) and showVehicleSearchAgreeToDisclaimer.do (VIN search).
 * Same click patterns; cookie overlays often block the control.
 */
async function acceptDisclaimerUntilClear(page) {
  const stillOn = () =>
    /showDisclaimer/i.test(page.url()) ||
    /showVehicleSearchAgreeToDisclaimer/i.test(page.url());

  for (let attempt = 0; attempt < 10 && stillOn(); attempt++) {
    const u = page.url();
    const label = /showVehicleSearchAgreeToDisclaimer/i.test(u)
      ? 'vehicle-search disclaimer'
      : 'portal disclaimer';
    console.log(`[DISCLAIMER] ${label} — clearing (attempt ${attempt + 1})…`);
    await dismissCookieBanners(page);
    await sleep(400);

    let clicked = false;

    for (const frame of disclaimerFrames(page)) {
      const cb = frame.locator('input[type="checkbox"]').first();
      if (await cb.isVisible({ timeout: 500 }).catch(() => false)) {
        const checked = await cb.isChecked().catch(() => true);
        if (!checked) {
          await cb.check({ force: true }).catch(() => {});
          await sleep(250);
        }
      }

      const rolePatterns = [
        /^OK$/i, /Continue/i, /Accept/i, /Agree/i, /Proceed/i, /Start/i,
        /Weiter/i, /Zustimmen/i, /Bestätigen/i, /Akzeptieren/i, /Einverstanden/i,
        /confirm/i, /bestätige/i, /understood/i, /verstanden/i,
      ];
      for (const name of rolePatterns) {
        for (const role of ['button', 'link']) {
          const loc = frame.getByRole(role, { name }).first();
          if (await loc.isVisible({ timeout: 400 }).catch(() => false)) {
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: DISCLAIMER_NAV_TIMEOUT_MS }).catch(() => {}),
              loc.click({ timeout: 3000, force: true }).catch(() => {}),
            ]);
            console.log(`[DISCLAIMER] ✓ ${role} (${name})`);
            clicked = true;
            await sleep(Math.max(200, UI_SETTLE_MS));
            break;
          }
        }
        if (clicked) break;
      }
      if (clicked) break;

      const selectors = [
        'input[type="submit"][value*="accept" i]',
        'input[type="submit"][value*="agree" i]',
        'input[type="submit"][value*="continue" i]',
        'input[type="submit"][value*="weiter" i]',
        'input[type="submit"][value*="ok" i]',
        'input[type="button"][value*="weiter" i]',
        'input[type="button"][value*="accept" i]',
        'button:has-text("OK")',
        'button:has-text("Continue")',
        'button:has-text("Accept")',
        'button:has-text("Agree")',
        'a:has-text("Continue")',
        'form[action*="disclaimer" i] input[type="submit"]',
        'form[action*="VehicleSearch" i] input[type="submit"]',
        'form[action*="AgreeTo" i] input[type="submit"]',
        'input[type="submit"]',
      ];
      for (const sel of selectors) {
        const loc = frame.locator(sel).first();
        if (await loc.isVisible({ timeout: 600 }).catch(() => false)) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: DISCLAIMER_NAV_TIMEOUT_MS }).catch(() => {}),
            loc.click({ timeout: 3000, force: true }).catch(() => {}),
          ]);
          console.log(`[DISCLAIMER] ✓ ${sel}`);
          clicked = true;
          await sleep(Math.max(200, UI_SETTLE_MS));
          break;
        }
      }
      if (clicked) break;
    }

    if (!clicked) {
      await page.keyboard.press('Enter').catch(() => {});
      await sleep(Math.max(150, UI_SETTLE_MS));
    }

    if (!stillOn()) return;
  }

  if (stillOn()) {
    const shot = path.join(OUT_DIR, '_disclaimer_stuck.png');
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(OUT_DIR, '_disclaimer_stuck.html'), await page.content(), 'utf8');
    throw new Error(
      `Stuck on a disclaimer/consent page after automated clicks (showDisclaimer.do or showVehicleSearchAgreeToDisclaimer.do). ` +
        `Check cookie overlay or UI language. Saved ${shot} and _disclaimer_stuck.html — send the button HTML if needed.`
    );
  }
}

/**
 * Vehicle search can redirect to showVehicleSearchAgreeToDisclaimer.do after the first paint;
 * run cookie + disclaimer passes until the real VIN field exists or we time out this phase.
 */
async function settleVehicleSearchDisclaimerAndGates(page) {
  const vinLoc = page
    .locator('input[name="vin"], input#vin, input[placeholder*="VIN" i]')
    .or(page.getByRole('textbox', { name: /^VIN$/i }))
    .first();

  for (let i = 0; i < 18; i++) {
    await dismissCookieBanners(page);
    await acceptDisclaimerUntilClear(page);
    if (await vinLoc.isVisible({ timeout: 700 }).catch(() => false)) return;
    await sleep(250);
  }
}

/**
 * Post-login banners only — never use generic input[type=submit] here: on showLogin.do
 * that is often the same Log in button and would submit the login form a second time.
 */
async function postLoginSteps(page) {
  await acceptDisclaimerUntilClear(page);
  await sleep(UI_SETTLE_MS);
  for (const sel of [
    'button:has-text("Accept")',
    'button:has-text("Agree")',
    'button:has-text("Agree and continue")',
    'button:has-text("Continue")',
    'button:has-text("Weiter")',
    'a:has-text("Continue")',
  ]) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.click();
      await sleep(Math.max(200, UI_SETTLE_MS));
      break;
    }
  }
}

async function assertNotLoginLockout(page) {
  if (SKIP_LOGIN_LOCKOUT_CHECK) return;
  const body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  // Do not use bare "too many times" — it matches unrelated erWin copy (release notes, etc.) and blocks login falsely.
  const locked =
    /submitted this form too many times/i.test(body) ||
    /form is still blocked/i.test(body) ||
    /locked form/i.test(body);
  if (locked) {
    throw new Error(
      'Erwin temporarily locked the login form (too many submissions). Wait 15–60 minutes without retrying, ' +
      'then run again once. To reduce repeats: fix credentials first, use ERWIN_LOGIN_SUBMIT_DELAY_MS=5000, ' +
      'and avoid re-running the script in a tight loop. If you are sure this is a false alarm, ERWIN_SKIP_LOGIN_LOCKOUT_CHECK=1 (rare).'
    );
  }
}

/**
 * Same flow as erwin_download_9.js (proven on erWin): home → username/#username → password → submit click.
 */
async function loginViaShowHomeLikeDownload9(page) {
  const userFilled = await tryFillFirst(page, USERNAME, [
    'input[name="username"]',
    '#username',
    'input[name="loginName"]',
    'input[type="text"]',
  ]);
  const passFilled = await tryFillFirst(page, PASSWORD, [
    'input[name="password"]',
    '#password',
    'input[type="password"]',
  ]);
  if (!userFilled || !passFilled) return;
  await sleep(LOGIN_SUBMIT_DELAY_MS);
  await Promise.all([
    // Erwin sometimes completes login without full navigation; keep this wait short.
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 1200 }).catch(() => {}),
    page.locator('button[type="submit"], input[type="submit"], button:has-text("Log in")').first().click(),
  ]);
  await page.waitForFunction(
    () => !document.querySelector('input[type="password"]'),
    { timeout: 2000 }
  ).catch(() => {});
  await sleep(UI_SETTLE_MS);
}

/** Dedicated login page (loginName) — fallback if showHome flow did not leave the login form. */
async function loginViaShowLoginDo(page, brand) {
  const BASE = baseUrl(brand);
  await page.goto(`${BASE}/erwin/showLogin.do`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(UI_SETTLE_MS);
  await dismissCookieBanners(page);
  await acceptDisclaimerUntilClear(page);
  await assertNotLoginLockout(page);

  const userLoc = page.locator('input[name="loginName"], input#loginName, input[name="username"]').first();
  await userLoc.waitFor({ state: 'visible', timeout: 15000 });
  await userLoc.evaluate(el => {
    el.value = '';
    el.defaultValue = '';
    el.setAttribute('autocomplete', 'username');
  });
  await typeLikeHuman(userLoc, USERNAME);

  const passLoc = page.locator('input[type="password"], input[name="password"], input[name="PASSWORD"]').first();
  await passLoc.waitFor({ state: 'visible', timeout: 10000 });
  await passLoc.fill('');
  await typeLikeHuman(passLoc, PASSWORD);

  await sleep(LOGIN_SUBMIT_DELAY_MS);

  const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 6000 }).catch(() => {});
  const clickedLogin = await tryClick(
    page,
    [
      'button:has-text("Log in")',
      'button:has-text("Login")',
      'input[type="submit"][value*="Log" i]',
      'input[type="submit"][name*="login" i]',
    ],
    2500
  );
  if (!clickedLogin) await passLoc.press('Enter');
  await navPromise;
  await sleep(UI_SETTLE_MS);
}

async function login(browser, brand) {
  const BASE = baseUrl(brand);
  console.log(`[AUTH] Logging in (${brand})${MANUAL_LOGIN ? ' (manual — you drive the browser)' : ''}...`);
  const context = await newErwinContext(browser);
  const page = await context.newPage();

  if (MANUAL_LOGIN) {
    await page.goto(`${BASE}/erwin/showLogin.do`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(UI_SETTLE_MS);
    await dismissCookieBanners(page);
    await acceptDisclaimerUntilClear(page);
    await assertNotLoginLockout(page);
    console.log(
      '\n  Opened the login page in the automated browser.\n' +
      '  Sign in yourself (same as when you use Chrome normally).\n' +
      '  When you see the erWin home / logged-in state, return here and press Enter.\n'
    );
    await waitEnterInTerminal('  Press Enter here after you are logged in… ');
    await sleep(UI_SETTLE_MS);
    await dismissCookieBanners(page);
    await assertNotLoginLockout(page);
    if (page.url().includes('showLogin')) {
      const shot = path.join(OUT_DIR, '_login_manual_still_on_login.png');
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      throw new Error(
        'Still on showLogin after manual step — finish logging in in the browser, then press Enter here again (or re-run). ' +
        `Screenshot: ${shot}`
      );
    }
    await postLoginSteps(page);
    console.log('[AUTH] ✓ Continuing with your manual session');
    await page.close();
    return context;
  }

  // Automated login: match erwin_download_9.js (showHome.do + username/#username + submit), then showLogin.do if needed.
  await page.goto(`${BASE}/erwin/showHome.do`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(UI_SETTLE_MS);
  await dismissCookieBanners(page);
  await acceptDisclaimerUntilClear(page);
  await assertNotLoginLockout(page);

  const pwdOnHome = await page.locator('input[type="password"]').first().isVisible({ timeout: 2500 }).catch(() => false);
  if (pwdOnHome) {
    console.log('[AUTH] Using home-page login (same as erwin_download_9.js)…');
    await loginViaShowHomeLikeDownload9(page);
  } else {
    console.log('[AUTH] No password field on home — skipping fill (may already be signed in).');
  }

  await assertNotLoginLockout(page);

  let url = page.url();
  let pwdOpen = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
  if (url.includes('showLogin') || pwdOpen) {
    console.log('[AUTH] Retrying on showLogin.do (loginName field)…');
    await loginViaShowLoginDo(page, brand);
    await assertNotLoginLockout(page);
    url = page.url();
    pwdOpen = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
  }

  const stillOnLogin = url.includes('showLogin');
  const pwdStillThere = pwdOpen;

  if (!stillOnLogin && !pwdStillThere)
    await postLoginSteps(page);

  const url2 = page.url();
  const pwdFinal = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
  if (url2.includes('showLogin') || pwdFinal) {
    await assertNotLoginLockout(page);
    const shot = path.join(OUT_DIR, '_login_failed.png');
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    const hint = await page.locator('[class*="error"], .alert, .message, .msg').first().innerText({ timeout: 2000 }).catch(() => '');
    throw new Error(
      `Login failed — check ERWIN_USERNAME / ERWIN_PASSWORD. Screenshot: ${shot}` +
        (hint ? ` — ${hint.trim().slice(0, 120)}` : '')
    );
  }

  console.log('[AUTH] ✓ Logged in');
  await page.close();
  return context;
}

/** Capture session params from the wiring navigation XHR */
function attachNavTreeCapture(page, brand, onSession, onTree) {
  const BASE = baseUrl(brand);
  const handlerReq = req => {
    if (!req.url().includes('getwdnavigationtree')) return;
    const u = new URL(req.url());
    const ref = req.headers()['referer'] || '';
    let encodedCode = null;
    try { encodedCode = new URL(ref).searchParams.get('encodedCode'); } catch { /* ignore */ }
    onSession({
      jobId: u.searchParams.get('jobId'),
      globalJobId: u.searchParams.get('globalJobId'),
      uuid: req.headers()['uuid'] || req.headers()['UUID'],
      encodedCode,
      referer: ref || `${BASE}/erwin/rp/CSP/Retail/ELSAPRO/Show`,
    });
  };
  const handlerRes = async res => {
    if (!res.url().includes('getwdnavigationtree') || res.status() !== 200) return;
    try {
      const data = await res.json();
      if (data && (Array.isArray(data.wiringDiagrams) || Array.isArray(data.componentLocations)))
        onTree(data);
    } catch { /* ignore */ }
  };
  page.on('request', handlerReq);
  page.on('response', handlerRes);
  return () => {
    page.off('request', handlerReq);
    page.off('response', handlerRes);
  };
}

async function submitVinSearch(page) {
  const submitted =
    (await tryClick(page, [
      'input[type="submit"]',
      'button[type="submit"]',
      'button:has-text("Search")',
      'button:has-text("Go")',
      'input[value*="Search"]',
    ], 2000)) ||
    (await tryClick(page, ['a:has-text("Search")', 'a:has-text("Go")'], 1500));

  const waitForVinSubmit = async () => {
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 2500 }).catch(() => {}),
      page.waitForResponse(r => /performVehicleSearch\.do/i.test(r.url()), { timeout: 2500 }).catch(() => {}),
      sleep(900),
    ]);
  };

  if (!submitted) {
    await page.keyboard.press('Enter');
    await waitForVinSubmit();
  } else {
    await waitForVinSubmit();
  }
}

async function openWiringNavigation(page, brand) {
  const BASE = baseUrl(brand);
  const workshop = await tryClick(page, [
    'text=Workshop information',
    'a:has-text("Workshop information")',
    'li:has-text("Workshop information")',
    'span:has-text("Workshop information")',
    'text=Workshop Information',
  ], 8000);

  await sleep(workshop ? 600 : 200);

  const diagrams = await tryClick(page, [
    'text=Current Flow Diagrams',
    'a:has-text("Current Flow Diagrams")',
    'li:has-text("Current Flow Diagrams")',
    'span:has-text("Current Flow Diagrams")',
    'text=Current circuit diagrams',
    'a:has-text("Current circuit diagrams")',
    'text=Stromlaufpläne',
    'a:has-text("Stromlaufpläne")',
  ], 8000);

  if (!diagrams) {
    console.log('  [NAV] Menu not found — opening WD module directly...');
    await page.goto(`${BASE}/erwin/rp/elsaweb/ctr/nv/viewModule?moduleKey=WD`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await sleep(600);
    await dismissCookieBanners(page);
    await acceptDisclaimerUntilClear(page);
  }
}

async function getDocList(context, vin, brand) {
  const BASE = baseUrl(brand);
  console.log(`  Searching VIN and opening ELSAPro (${vin})...`);
  const page = await context.newPage();

  let navTree = null;
  let sessionParams = null;

  const detach = attachNavTreeCapture(page, brand, sp => { sessionParams = sp; }, tree => { navTree = tree; });

  // Register before any navigation — tree XHR can fire during ELSAPro / WD load.
  const treePromise = page.waitForResponse(
    r => r.url().includes('getwdnavigationtree') && r.status() === 200,
    { timeout: 90000 }
  ).catch(() => null);

  try {
    await page.goto(`${BASE}/erwin/showVehicleSearch.do`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(250);
    await settleVehicleSearchDisclaimerAndGates(page);

    const u = page.url();
    if (u.includes('showLogin'))
      throw new Error('Not logged in — opened vehicle search but got login page. Session or cookies missing.');

    // Only real VIN fields — never input[type=text] (that was matching loginName when the VIN field had no name).
    const vinLoc = page
      .locator('input[name="vin"], input#vin, input[placeholder*="VIN" i]')
      .or(page.getByRole('textbox', { name: /^VIN$/i }))
      .first();
    await vinLoc.waitFor({ state: 'visible', timeout: 12000 });
    await vinLoc.evaluate(el => {
      el.value = '';
      el.defaultValue = '';
    });
    await vinLoc.fill(vin);

    await submitVinSearch(page);
    await sleep(700);
    const vehicleLabel = await detectVehicleLabelOnPage(page, vin);

    await page.goto(`${BASE}/erwin/rp/CSP/Retail/ELSAPRO/Show`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
    await dismissCookieBanners(page);
    await acceptDisclaimerUntilClear(page);

    await openWiringNavigation(page, brand);

    const waited = await treePromise;
    if (waited && !navTree) {
      try { navTree = await waited.json(); } catch { /* ignore */ }
    }

    for (let i = 0; i < 60 && (!navTree || !sessionParams?.jobId); i++) await sleep(500);

    if (!navTree || !sessionParams?.jobId)
      throw new Error('Could not capture navigation tree (getwdnavigationtree). Try HEADLESS=false and check menus.');

    const wiringDocs =
      DOWNLOAD !== 'locations' ? (navTree.wiringDiagrams || []).map(d => ({ ...d, _source: 'wiring' })) : [];
    const locationDocs =
      DOWNLOAD !== 'wiring' ? (navTree.componentLocations || []).map(d => ({ ...d, _source: 'location' })) : [];
    const docs = [...wiringDocs, ...locationDocs];

    console.log(`  ✓ ${docs.length} documents (${(navTree.wiringDiagrams || []).length} wiring, ${(navTree.componentLocations || []).length} locations)`);

    return { docs, sessionParams, elsaPage: page, navTree, vehicleLabel };
  } catch (e) {
    await page.close().catch(() => {});
    throw e;
  } finally {
    detach();
  }
}

/** Erwin returns doc HTML; API expects POST (same as batch SVG downloader). */
async function fetchDocContentJson(context, doc, sessionParams, brand) {
  const BASE = baseUrl(brand);
  const { jobId, globalJobId, uuid, referer } = sessionParams;
  const url = `${BASE}/erwin/rp/navigation/api/getwddoccontent` +
    `?documentId=${encodeURIComponent(doc.id)}&userId=${encodeURIComponent(USERNAME)}&jobId=${encodeURIComponent(jobId)}` +
    `&cacheBuster=${Date.now()}&globalJobId=${encodeURIComponent(globalJobId || '')}`;

  const headers = {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/x-www-form-urlencoded',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    Referer: referer || `${BASE}/erwin/rp/CSP/Retail/ELSAPRO/Show`,
  };
  if (uuid) headers.uuid = uuid;

  const res = await context.request.post(url, { headers });
  const text = await res.text();
  if (!res.ok())
    throw new Error(`getwddoccontent HTTP ${res.status()}: ${text.slice(0, 120)}`);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('getwddoccontent returned non-JSON');
  }
  return data;
}

function docHtmlToPrintable(html, brand) {
  const BASE = baseUrl(brand);
  let out = html
    .replace(/src="\/erwin\//g, `src="${BASE}/erwin/`)
    .replace(/src='\/erwin\//g, `src='${BASE}/erwin/`)
    .replace(/href="\/erwin\//g, `href="${BASE}/erwin/`)
    .replace(/href='\/erwin\//g, `href='${BASE}/erwin/`)
    .replace(/<embed\s+id="(CD1-[^"]+)"\s+[^>]*src="([^"]+)"[^>]*>/gi,
      (_, id, src) => `<img id="${id}" src="${src}" style="width:100%;height:auto;display:block;">`)
    .replace(/<embed([^>]*?)src="([^"]+)"([^>]*?)>/gi,
      (_, before, src, after) => {
        const idM = /id="(CD1-[^"]+)"/i.exec(`${before}${after}`);
        const id = idM ? idM[1] : '';
        return `<img ${id ? `id="${id}"` : ''} src="${src}" style="width:100%;height:auto;display:block;">`;
      })
    .replace(/<input[^>]*type="image"[^>]*>/gi, '')
    .replace(/<object[^>]*>[\s\S]*?<\/object>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<input[^>]*type="hidden"[^>]*>/gi, '')
    /* Keep <link rel="stylesheet"> — Erwin's wi-slp-e_print.css (media=print) supplies header/footer layout. */
    .replace(/<a[^>]*ebolink[^"]*"[^>]*><img[^>]*><\/a>/gi, '')
    // Erwin injects hard page-break paragraphs that can separate title/header from diagram body.
    .replace(/<p[^>]*page-break-before\s*:\s*always[^>]*>\s*(?:&nbsp;|\s)*<\/p>/gi, '')
    .replace(/<p[^>]*style="[^"]*page-break-before\s*:\s*always[^"]*"[^>]*>/gi, '<p>');

  const css = `<style>
      @page { size: A3 landscape; margin: 8mm; }
      body { font-family: Arial, sans-serif; font-size: 9pt; background: white; margin: 0; }
      table { border-collapse: collapse; }
      td.head-left   { font-weight: bold; font-size: 10pt; padding: 2mm 3mm; }
      td.head-center { text-align: center; font-size: 10pt; }
      td.head-right  { text-align: right; font-size: 10pt; padding: 2mm 3mm; }
      td.foot-left   { font-size: 9pt; padding: 2mm 3mm; vertical-align: top; }
      td.foot-center { text-align: center; font-size: 9pt; padding: 2mm 3mm; vertical-align: top; }
      td.foot-right  { text-align: right; font-size: 9pt; padding: 2mm 3mm; vertical-align: top; }
      tr[bgcolor="#000000"] td { background:#000; height:1px; padding:0; font-size:0; }
      td.A4_WIDTH { background: #edf0f2; vertical-align: top; padding: 2mm; width: 55%; }
      img { width: 100%; height: auto; display: block; }
      td.color-leg { font-size: 8pt; padding: 0 1mm; }
      td[id^="slp_legende"] { vertical-align: top; padding: 0 2mm; }
      /* Keep header rows with the immediate content row, but do not freeze whole huge tables. */
      tr:has(td.head-left),
      tr:has(td.head-center),
      tr:has(td.head-right),
      tr:has(td.head-left) + tr,
      tr:has(td.head-center) + tr,
      tr:has(td.head-right) + tr {
        break-inside: avoid-page;
        page-break-inside: avoid;
      }
      div.bild-titel { font-weight: bold; font-size: 9pt; margin-bottom: 2mm;
                       padding-bottom: 1mm; border-bottom: 1px solid #aaa;
                       break-after: avoid; page-break-after: avoid; }
      td.slp-bt-einzug-nummer { font-weight: bold; font-size: 8pt; white-space: nowrap;
                                padding: 1px 2mm 1px 0; vertical-align: top; }
      td.slp-vp-einzug-nummer { font-size: 8pt; white-space: nowrap;
                                padding: 1px 2mm 1px 5mm; vertical-align: top; color: #444; }
      td.slp-bez { font-size: 8pt; padding: 1px 1mm; vertical-align: top; }
      table.cc   { margin-bottom: 1px; width: 100%; }
      table, tr, td { break-inside: auto; page-break-inside: auto; }
      /* Do not hide page-break <p> nodes — Erwin sometimes puts real content there (e.g. footer text). */
      /* Do not hide linked images; some Erwin diagram pages wrap real SVG images in anchors. */
    </style>`;

  if (out.includes('</head>'))
    return out.replace('</head>', css + '</head>');
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${css}</head><body>${out}</body></html>`;
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSubsectionsFromTooLargePrintHtml(raw, parentDocId) {
  const out = [];
  const seen = new Set();
  const parentStr = String(parentDocId);
  const html = String(raw).replace(/&amp;/gi, '&');

  function add(id, titleHtml) {
    if (!id || id === parentStr || seen.has(id)) return;
    seen.add(id);
    out.push({ id, title: stripHtml(titleHtml) || `subsection_${id}` });
  }

  // Erwin often uses printWiringDiagram;jsessionid=…?… — do not require ? right after the servlet name.
  const direct = [
    /<a[^>]+href\s*=\s*"([^"]*printWiringDiagram[^"]*docId=(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a[^>]+href\s*=\s*'([^']*printWiringDiagram[^']*docId=(\d+)[^']*)'[^>]*>([\s\S]*?)<\/a>/gi,
  ];
  for (const re of direct) {
    let m;
    while ((m = re.exec(html)) !== null) add(m[2], m[3]);
  }

  if (out.length === 0) {
    const scanAnchors = (re) => {
      let m;
      while ((m = re.exec(html)) !== null) {
        const href = m[1];
        if (!/printWiringDiagram/i.test(href) && !/\/elsaweb\/ctr\//i.test(href)) continue;
        const dm = /(?:[?&])docId=(\d+)/i.exec(href);
        if (!dm) continue;
        add(dm[1], m[2]);
      }
    };
    scanAnchors(/<a\b[^>]*\bhref\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi);
    scanAnchors(/<a\b[^>]*\bhref\s*=\s*'([^']*)'[^>]*>([\s\S]*?)<\/a>/gi);
  }

  // Last resort: any docId= in the error page (buttons, forms, encoded URLs) — cap count for safety.
  if (out.length === 0) {
    const flat = html.replace(/%3D/gi, '=');
    const loose = /\bdocId=(\d{5,12})\b/gi;
    let m;
    while ((m = loose.exec(flat)) !== null && out.length < 48) add(m[1], '');
  }

  return out;
}

/** getwddoccontent JSON → local HTML → PDF (older path; good fallback). */
async function printDocumentFromDocContent(context, doc, sessionParams, outPath, brand) {
  const BASE = baseUrl(brand);
  const data = await fetchDocContentJson(context, doc, sessionParams, brand);
  if (!data?.docContent) throw new Error('No docContent in response');

  const html = docHtmlToPrintable(data.docContent, brand);
  const docPage = await context.newPage();

  try {
    await docPage.goto(`${BASE}/erwin/showHome.do`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismissCookieBanners(docPage);
    await acceptDisclaimerUntilClear(docPage);
    await docPage.setContent(html, { waitUntil: 'load', timeout: 120000 });
    await docPage.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
    // Erwin ships header/footer rules in wi-slp-e_print.css (media="print"); Chromium defaults to "screen".
    await docPage.emulateMedia({ media: 'print' });

    await docPage.waitForFunction(
      () => [...document.images].every(img => img.complete),
      { timeout: 25000 }
    ).catch(() => {});

    await sleep(400);

    const loaded = await docPage.evaluate(() =>
      [...document.images].filter(i => i.naturalWidth > 0).length
    );
    const total = await docPage.evaluate(() => document.images.length);

    const scale = Math.min(2, Math.max(0.1, parseFloat(process.env.ERWIN_PDF_SCALE_API || '0.82') || 0.82));
    await docPage.pdf({
      path: outPath,
      format: 'A3',
      landscape: true,
      printBackground: true,
      scale,
      margin: { top: '8mm', right: '8mm', bottom: '8mm', left: '8mm' },
    });

    return { loaded, total };
  } finally {
    await docPage.close();
  }
}

/** Chrome-like navigation request — Erwin often returns 9114E when `Accept` asks for PDF first (non-browser path). */
const PRINT_WIRING_ACCEPT_BROWSER =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/pdf;q=0.2,application/octet-stream;q=0.2';

function printDiagramResponseIsPdf(body) {
  const isPdfSignature = body.length >= 5 && body.subarray(0, 5).toString('utf8') === '%PDF-';
  const looksTooSmallPdf = isPdfSignature && body.length < 4096;
  return isPdfSignature && !looksTooSmallPdf;
}

/**
 * Same servlet as manual print, but include WD session fields Erwin expects on the backend
 * (matches getwddoccontent / navigation tree calls — omitting them often yields 9114E).
 */
function buildPrintWiringDiagramUrl(BASE, doc, sessionParams) {
  const q = new URLSearchParams();
  q.set('infoMediaKey', 'WD');
  q.set('docId', String(doc.id));
  if (sessionParams?.jobId) q.set('jobId', sessionParams.jobId);
  if (sessionParams?.globalJobId) q.set('globalJobId', sessionParams.globalJobId);
  if (USERNAME) q.set('userId', USERNAME);
  if (sessionParams?.encodedCode) q.set('encodedCode', sessionParams.encodedCode);
  return `${BASE}/erwin/rp/elsaweb/ctr/printWiringDiagram?${q.toString()}`;
}

function isPrintTooLargeMessage(raw) {
  return (
    /Document is too large and is not intended for printing/i.test(raw) ||
    /document is too large.*not intended for printing/i.test(raw) ||
    /zu\s+gro(ß|ss).*druck/i.test(raw) ||
    /nicht\s+für\s+den\s+druck\s+vorgesehen/i.test(raw)
  );
}

function throwIfPrintDiagramHtmlError(raw, doc) {
  if (/Error code:\s*9114E/i.test(raw) || /WebService Exception/i.test(raw))
    throw new Error('Erwin print service error 9114E (temporary backend/service failure)');
  if (isPrintTooLargeMessage(raw)) {
    const subs = extractSubsectionsFromTooLargePrintHtml(raw, doc.id);
    const err = new Error(`Document ${doc.id} too large for direct print`);
    err.code = 'PRINT_TOO_LARGE';
    err.subsections = subs;
    throw err;
  }
}

/** HTML from printWiringDiagram → Playwright PDF (same pipeline as API HTML path). */
async function renderPrintWiringHtmlToPdf(context, BASE, raw, outPath) {
  let html = raw
    .replace(/(src|href)=["']\/erwin\//gi, `$1="${BASE}/erwin/`);
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${BASE}/erwin/">`);
  } else {
    html = `<!doctype html><html><head><base href="${BASE}/erwin/"></head><body>${html}</body></html>`;
  }

  const docPage = await context.newPage();
  try {
    await docPage.goto(`${BASE}/erwin/showHome.do`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismissCookieBanners(docPage);
    await acceptDisclaimerUntilClear(docPage);
    await docPage.setContent(html, { waitUntil: 'load', timeout: 120000 });
    await docPage.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
    await docPage.emulateMedia({ media: 'print' });

    const appearsEmpty = await docPage.evaluate(() => {
      const t = (document.body && document.body.innerText || '').replace(/\s+/g, ' ').trim();
      const imgCount = document.images.length;
      return t.length < 20 && imgCount === 0;
    });
    if (appearsEmpty) throw new Error('printWiringDiagram rendered empty page');

    await docPage.waitForFunction(
      () => [...document.images].every(img => img.complete),
      { timeout: 25000 }
    ).catch(() => {});

    await sleep(250);

    const loaded = await docPage.evaluate(() =>
      [...document.images].filter(i => i.naturalWidth > 0).length
    );
    const total = await docPage.evaluate(() => document.images.length);

    await docPage.pdf({
      path: outPath,
      format: 'A3',
      landscape: true,
      printBackground: true,
      scale: PDF_SCALE,
      margin: { top: '8mm', right: '8mm', bottom: '8mm', left: '8mm' },
    });

    return { loaded, total };
  } finally {
    await docPage.close();
  }
}

/**
 * Full navigation to printWiringDiagram. Prefer `elsaPage` (WD tree tab) so the request runs in the
 * same browser context as manual print; otherwise a fresh tab + showHome (weaker for 9114E).
 */
async function printWiringDiagramViaBrowserNavigation(context, doc, sessionParams, printUrl, outPath, brand, elsaPage) {
  const BASE = baseUrl(brand);
  const useElsaTab = elsaPage && !elsaPage.isClosed() && typeof elsaPage.goto === 'function';
  let ownPage = null;
  let prevUrl = '';
  const page = useElsaTab ? elsaPage : (ownPage = await context.newPage());

  try {
    if (!useElsaTab) {
      await page.goto(`${BASE}/erwin/showHome.do`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await dismissCookieBanners(page);
      await acceptDisclaimerUntilClear(page);
    } else {
      try {
        prevUrl = page.url();
      } catch {
        prevUrl = '';
      }
      if (!prevUrl) prevUrl = sessionParams?.referer || `${BASE}/erwin/rp/CSP/Retail/ELSAPRO/Show`;
      console.log('  [print] Using existing ELSA browser tab (same WD session as navigation tree)…');
    }

    const response = await page.goto(printUrl, { waitUntil: 'load', timeout: 120000 });
    const status = response?.status() ?? 0;
    if (status >= 400) throw new Error(`printWiringDiagram HTTP ${status}`);

    const body = await response.body();
    if (printDiagramResponseIsPdf(body)) {
      fs.writeFileSync(outPath, body);
      return { loaded: 1, total: 1 };
    }

    const raw = body.toString('utf8');
    throwIfPrintDiagramHtmlError(raw, doc);

    await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
    await page.emulateMedia({ media: 'print' });

    const appearsEmpty = await page.evaluate(() => {
      const t = (document.body && document.body.innerText || '').replace(/\s+/g, ' ').trim();
      const imgCount = document.images.length;
      return t.length < 20 && imgCount === 0;
    });
    if (appearsEmpty) throw new Error('printWiringDiagram rendered empty page');

    await page.waitForFunction(
      () => [...document.images].every(img => img.complete),
      { timeout: 25000 }
    ).catch(() => {});

    await sleep(250);

    const loaded = await page.evaluate(() =>
      [...document.images].filter(i => i.naturalWidth > 0).length
    );
    const total = await page.evaluate(() => document.images.length);

    await page.pdf({
      path: outPath,
      format: 'A3',
      landscape: true,
      printBackground: true,
      scale: PDF_SCALE,
      margin: { top: '8mm', right: '8mm', bottom: '8mm', left: '8mm' },
    });

    return { loaded, total };
  } finally {
    if (useElsaTab && prevUrl) {
      await elsaPage.emulateMedia({ media: 'screen' }).catch(() => {});
      await elsaPage.goto(prevUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    }
    if (ownPage) await ownPage.close().catch(() => {});
  }
}

/**
 * Same document as in browser: /erwin/rp/elsaweb/ctr/printWiringDiagram?infoMediaKey=WD&docId=…
 * Keeps Erwin section numbering and pagination.
 */
async function printDocumentFromPrintDiagram(context, doc, sessionParams, outPath, brand, elsaPage) {
  const BASE = baseUrl(brand);
  const printUrl = buildPrintWiringDiagramUrl(BASE, doc, sessionParams);
  const ref = sessionParams?.referer || `${BASE}/erwin/rp/CSP/Retail/ELSAPRO/Show`;

  const navLikeHeaders = {
    Referer: ref,
    Accept: PRINT_WIRING_ACCEPT_BROWSER,
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  };
  if (sessionParams?.uuid) {
    navLikeHeaders.uuid = sessionParams.uuid;
    navLikeHeaders.UUID = sessionParams.uuid;
  }

  let saw9114E = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(1200 * attempt);
    const resp = await context.request.get(printUrl, { headers: navLikeHeaders });
    const status = resp?.status() ?? 0;
    if (status >= 400) throw new Error(`printWiringDiagram HTTP ${status}`);

    const body = await resp.body();
    if (printDiagramResponseIsPdf(body)) {
      fs.writeFileSync(outPath, body);
      return { loaded: 1, total: 1 };
    }

    const raw = body.toString('utf8');
    if (/Error code:\s*9114E/i.test(raw) || /WebService Exception/i.test(raw)) {
      saw9114E = true;
      continue;
    }

    throwIfPrintDiagramHtmlError(raw, doc);
    return await renderPrintWiringHtmlToPdf(context, BASE, raw, outPath);
  }

  if (saw9114E) {
    console.log('  [print] 9114E on API fetch — trying in-browser printWiringDiagram…');
    for (let b = 0; b < 2; b++) {
      if (b) await sleep(2000);
      try {
        return await printWiringDiagramViaBrowserNavigation(context, doc, sessionParams, printUrl, outPath, brand, elsaPage);
      } catch (e) {
        if (!/9114E|WebService Exception/i.test(e.message || '')) throw e;
      }
    }
    // Same 9114E in the browser = Erwin print servlet / service fault for this doc (not automation).
    if (!PRINT_NO_DOCCONTENT_FALLBACK) {
      console.log(
        '  [print] printWiringDiagram still 9114E — falling back to getwddoccontent → PDF (different backend path).'
      );
      return await printDocumentFromDocContent(context, doc, sessionParams, outPath, brand);
    }
    throw new Error('Erwin print service error 9114E (temporary backend/service failure)');
  }
}

async function printDocument(context, doc, sessionParams, outPath, brand, elsaPage) {
  return printDocumentFromPrintDiagram(context, doc, sessionParams, outPath, brand, elsaPage);
}

/** When printWiringDiagram returns "too large", follow subsection anchors to separate PDFs. Returns count of subsection PDFs present or created. */
async function downloadTooLargeSubsections(context, e, doc, sessionParams, brand, vinDir, vin, label, elsaPage) {
  if (e?.code !== 'PRINT_TOO_LARGE' || !Array.isArray(e.subsections) || !e.subsections.length) return 0;

  console.log(`↻  too large; downloading ${e.subsections.length} subsections`);
  const indexPath = path.join(vinDir, `${doc.id}_subsections_index.json`);
  const index = {
    parent: { id: doc.id, title: doc.title },
    vin,
    label,
    brand,
    generated: new Date().toISOString(),
    reason: 'too_large_for_single_print',
    subsectionPdfPrefix: `${doc.id}_sub_`,
    items: [],
  };
  let subOk = 0;
  for (const sub of e.subsections) {
    const safeSub = (sub.title || `subsection_${sub.id}`)
      .replace(/[^\w\s,.()\-]/g, '')
      .replace(/\s+/g, '_')
      .substring(0, 70);
    const subOut = path.join(vinDir, `${doc.id}_sub_${sub.id}_${safeSub}.pdf`);
    const baseItem = { documentId: sub.id, title: sub.title || `subsection_${sub.id}`, pdf: path.basename(subOut) };
    if (fs.existsSync(subOut)) {
      index.items.push({ ...baseItem, status: 'skipped_exists' });
      subOk++;
      continue;
    }
    try {
      const subDoc = { id: sub.id, title: sub.title || `subsection_${sub.id}`, _source: doc._source };
      const { loaded, total } = await printDocument(context, subDoc, sessionParams, subOut, brand, elsaPage);
      const kb = (fs.statSync(subOut).size / 1024).toFixed(0);
      console.log(`    [sub ${sub.id}] ✓  ${loaded}/${total} imgs  ${kb}KB`);
      index.items.push({ ...baseItem, status: 'ok', loaded, total, kb: parseFloat(kb) });
      subOk++;
    } catch (subErr) {
      const em = (subErr.message || String(subErr)).substring(0, 200);
      console.log(`    [sub ${sub.id}] ✗  ${em.substring(0, 90)}`);
      index.items.push({ ...baseItem, status: 'failed', error: em });
    }
    await sleep(300);
  }
  index.summary = {
    attempted: e.subsections.length,
    succeeded: index.items.filter(i => i.status === 'ok' || i.status === 'skipped_exists').length,
    failed: index.items.filter(i => i.status === 'failed').length,
  };
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  console.log(`    [INDEX] ${indexPath}`);
  if (subOk > 0) console.log(`    ↳ ${subOk}/${e.subsections.length} subsection PDFs ready`);
  if (subOk > 0) await sleep(300);
  return subOk;
}

/**
 * PRINT_TOO_LARGE: subsection PDFs when Erwin lists split links; else one PDF via getwddoccontent.
 */
async function recoverPrintTooLarge(context, e, doc, sessionParams, brand, vinDir, vin, label, elsaPage, outPath) {
  if (e?.code !== 'PRINT_TOO_LARGE') return { recovered: false };
  if (Array.isArray(e.subsections) && e.subsections.length) {
    const subOk = await downloadTooLargeSubsections(context, e, doc, sessionParams, brand, vinDir, vin, label, elsaPage);
    if (subOk > 0) return { recovered: true, via: 'subsections', subOk };
  }
  if (PRINT_NO_DOCCONTENT_FALLBACK) return { recovered: false };
  try {
    console.log('  [print] Too large for print servlet (no usable split links) — getwddoccontent → PDF…');
    const { loaded, total } = await printDocumentFromDocContent(context, doc, sessionParams, outPath, brand);
    return { recovered: true, via: 'doccontent', loaded, total };
  } catch (err) {
    console.log(`  [print] getwddoccontent fallback failed: ${(err.message || String(err)).slice(0, 80)}`);
    return { recovered: false };
  }
}

function isServiceFailureMessage(msg) {
  return /9114E|webservice exception|service invocation/i.test(String(msg || ''));
}

function isHardAuthFailureMessage(msg) {
  return /401|403|expired|session|not logged in|showLogin\.do|login page/i.test(String(msg || ''));
}

async function main() {
  requireCredentials();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (MANUAL_LOGIN && HEADLESS) {
    console.error('[erwin_print] ERWIN_MANUAL_LOGIN=1 needs a visible browser. Unset HEADLESS or set HEADLESS=0.');
    process.exit(1);
  }

  if (!MANUAL_LOGIN && !USE_GOOGLE_CHROME && !BROWSER_EXECUTABLE)
    console.log('[AUTH] Tip: if automated login fails, try ERWIN_BROWSER_EXECUTABLE (Brave path), ERWIN_USE_GOOGLE_CHROME=1, or ERWIN_MANUAL_LOGIN=1.');

  if (BROWSER_EXECUTABLE && !fs.existsSync(BROWSER_EXECUTABLE)) {
    console.error(`[erwin_print] ERWIN_BROWSER_EXECUTABLE does not exist: ${BROWSER_EXECUTABLE}`);
    process.exit(1);
  }

  let browser;
  try {
    browser = await chromium.launch(launchOptions());
  } catch (e) {
    const wantChrome = USE_GOOGLE_CHROME && !BROWSER_EXECUTABLE;
    if (wantChrome) {
      console.warn(
        '[erwin_print] Google Chrome channel is not installed (see error below). Falling back to Playwright Chromium.\n' +
          '  Fix options: install Chrome from https://www.google.com/chrome/ then run: npx playwright install chrome\n' +
          '  Or use Brave: export ERWIN_BROWSER_EXECUTABLE="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"\n' +
          '  Or unset ERWIN_USE_GOOGLE_CHROME and rely on: npx playwright install chromium\n'
      );
      try {
        browser = await chromium.launch(launchBase());
      } catch (e2) {
        console.error(e2.message || e2);
        throw e2;
      }
    } else {
      if (BROWSER_EXECUTABLE || USE_GOOGLE_CHROME)
        console.error('[erwin_print] Browser launch failed:', e.message || e);
      throw e;
    }
  }
  let context = null;
  let activeBrand = null;

  try {
    for (const entry of VINS) {
      const vin = String(entry.vin || '').trim();
      const inferredBrand = inferBrandFromVin(vin);
      const brand = normalizeBrand(entry.brand || inferredBrand || DEFAULT_BRAND);
      let label = '';

      if (!context || brand !== activeBrand) {
        await context?.close().catch(() => {});
        context = await login(browser, brand);
        activeBrand = brand;
      }

      let docs, sessionParams, elsaPage, navTree, vehicleLabel;
      try {
        ({ docs, sessionParams, elsaPage, navTree, vehicleLabel } = await getDocList(context, vin, brand));
      } catch (e) {
        console.error(`  [ERROR] ${e.message}`);
        continue;
      }

      label = normalizeRunLabel(vehicleLabel, '');
      if (!label) label = normalizeRunLabel(`${brand}_${vin}`, `${brand}_${vin}`);

      console.log(`\n${'='.repeat(55)}\n${label} (${vin}) [${brand}]\n${'='.repeat(55)}`);
      const vinDir = path.join(OUT_DIR, label);
      fs.mkdirSync(vinDir, { recursive: true });

      const chaptersPath = path.join(vinDir, '_chapters.json');
      fs.writeFileSync(
        chaptersPath,
        JSON.stringify(
          {
            vin,
            label,
            brand,
            generated: new Date().toISOString(),
            wiringDiagrams: navTree.wiringDiagrams || [],
            componentLocations: navTree.componentLocations || [],
          },
          null,
          2
        )
      );
      console.log(`  [CHAPTERS] ${chaptersPath}`);

      let ok = 0, skipped = 0, failed = 0;

      for (const doc of docs) {
        const safe = doc.title.replace(/[^\w\s,.()\-]/g, '').replace(/\s+/g, '_').substring(0, 70);
        const outPath = path.join(vinDir, `${doc.id}_${safe}.pdf`);

        if (fs.existsSync(outPath)) {
          console.log(`  [SKIP] ${doc.title}`);
          skipped++;
          continue;
        }

        if (SKIP_DOCUMENT_IDS.has(String(doc.id))) {
          console.log(`  [SKIP] ERWIN_SKIP_DOCUMENT_IDS — [${doc.id}] ${doc.title}`);
          skipped++;
          continue;
        }

        process.stdout.write(`  [${doc.id}] ${doc.title.substring(0, 48).padEnd(50)} `);

        try {
          const { loaded, total } = await printDocument(context, doc, sessionParams, outPath, brand, elsaPage);
          const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
          console.log(`✓  ${loaded}/${total} imgs  ${kb}KB`);
          ok++;
        } catch (e) {
          const rec = await recoverPrintTooLarge(context, e, doc, sessionParams, brand, vinDir, vin, label, elsaPage, outPath);
          if (rec.recovered) {
            const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
            if (rec.via === 'doccontent')
              console.log(`✓  ${rec.loaded}/${rec.total} imgs  ${kb}KB [getwddoccontent]`);
            else console.log(`✓  ${kb}KB [${rec.subOk} subsection PDFs]`);
            ok++;
            continue;
          }
          const msg = e.message || String(e);
          console.log(`✗  ${msg.substring(0, 80)}`);
          failed++;

          const serviceFail = isServiceFailureMessage(msg);
          const hardAuthFail = isHardAuthFailureMessage(msg);

          // 9114E/service faults often do not need re-login; retry doc once in the same session first.
          if (serviceFail && !hardAuthFail) {
            try {
              console.log('  [SERVICE] Retrying document in same session (no VIN refresh)…');
              await sleep(2500);
              const { loaded, total } = await printDocument(context, doc, sessionParams, outPath, brand, elsaPage);
              const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
              console.log(`  [SERVICE-RETRY] ✓  ${loaded}/${total} imgs  ${kb}KB`);
              ok++;
              failed--;
              continue;
            } catch (eService) {
              const recService = await recoverPrintTooLarge(
                context, eService, doc, sessionParams, brand, vinDir, vin, label, elsaPage, outPath
              );
              if (recService.recovered) {
                const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
                if (recService.via === 'doccontent')
                  console.log(`  [SERVICE-RETRY] ✓  ${recService.loaded}/${recService.total} imgs  ${kb}KB [getwddoccontent]`);
                else console.log(`  [SERVICE-RETRY] ✓  ${kb}KB [${recService.subOk} subsection PDFs]`);
                ok++;
                failed--;
                continue;
              }
              console.log(`  [SERVICE-RETRY] ✗  ${(eService.message || String(eService)).substring(0, 80)}`);
            }
          }

          if (hardAuthFail) {
            console.log(`  [AUTH] Waiting ${RELOGIN_COOLDOWN_MS / 1000}s before re-login (reduces Erwin lockouts)...`);
            await sleep(RELOGIN_COOLDOWN_MS);
            console.log('  [AUTH] Re-logging in and retrying document...');
            await elsaPage?.close().catch(() => {});
            await context.close().catch(() => {});
            context = await login(browser, brand);
            try {
              ({ docs, sessionParams, elsaPage, navTree } = await getDocList(context, vin, brand));
              const { loaded, total } = await printDocument(context, doc, sessionParams, outPath, brand, elsaPage);
              const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
              console.log(`  [RETRY] ✓  ${loaded}/${total} imgs  ${kb}KB`);
              ok++;
              failed--;
            } catch (e2) {
              const rec2 = await recoverPrintTooLarge(context, e2, doc, sessionParams, brand, vinDir, vin, label, elsaPage, outPath);
              if (rec2.recovered) {
                const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
                if (rec2.via === 'doccontent')
                  console.log(`  [RETRY] ✓  ${rec2.loaded}/${rec2.total} imgs  ${kb}KB [getwddoccontent]`);
                else console.log(`  [RETRY] ✓  ${kb}KB [${rec2.subOk} subsection PDFs]`);
                ok++;
                failed--;
              } else {
                console.log(`  [RETRY] ✗  ${(e2.message || String(e2)).substring(0, 80)}`);
              }
            }
          }
        }
        await sleep(600);
      }

      await elsaPage?.close().catch(() => {});
      console.log(`\n  ${label}: ${ok} ✓  ${skipped} skipped  ${failed} ✗  from ${docs.length} docs`);
      await sleep(1200);
    }
  } finally {
    await context?.close().catch(() => {});
    await browser.close();
  }

  console.log(`\n${'='.repeat(55)}\nDone. PDFs in: ${path.resolve(OUT_DIR)}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
