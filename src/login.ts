/**
 * Signing in to beWell: an ID (or passport) and the mobile number on file get
 * a one-time code by SMS (or a voice call), and the code gets the session's
 * cookies. There is no password.
 *
 * Both steps carry an invisible reCAPTCHA token that only the beWell page
 * itself can produce, so they run inside a real browser on that page
 * (Playwright's Chromium): the browser asks reCAPTCHA for a token as the page
 * would, and sends each request from the page with its cookies. When
 * reCAPTCHA wants a picture puzzle first, the person solves it on this
 * server's sign-in page, which shows the puzzle and passes their clicks on.
 * Nothing is solved automatically. The ID, the phone number and the code are
 * only ever sent to the hospital.
 */
import { API_BASE_URL, SITE_ORIGIN } from "./api.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Cookie } from "./cookies.js";
import { configDir } from "./store.js";

export const LOGIN_PAGE_URL = `${SITE_ORIGIN}/bewell/personalzonelogin`;
export const RECAPTCHA_SITE_KEY = "6Ld4kfIpAAAAAP6kPFucTjFIHGT8AskbGeXGsBwq";

export class BewellLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BewellLoginError";
  }
}

/** "1" for an Israeli ID number, "2" for a passport. */
export type AuthType = "1" | "2";

export interface Identity {
  id: string;
  phone: string;
  authType: AuthType;
}

/** The browser the sign-in runs in, open on the beWell sign-in page. */
export interface LoginBrowser {
  /**
   * A fresh reCAPTCHA token for the page's site key. When reCAPTCHA wants a
   * picture puzzle first, this waits while a person solves it through
   * puzzle() and click().
   */
  captcha(): Promise<string>;
  /** A picture of reCAPTCHA's puzzle while it shows one. */
  puzzle(): Promise<Uint8Array | undefined>;
  /** Clicks the puzzle at a point of its picture. */
  click(x: number, y: number): Promise<void>;
  /** POSTs JSON to the API from the page, with its cookies; returns the answer's text. */
  post(url: string, body: unknown): Promise<{ status: number; text: string }>;
  /** The API's cookies, HttpOnly ones included. */
  cookies(): Promise<Cookie[]>;
  /**
   * After a sign-in: leaves the browser on beWell's own signed-in page, as a
   * person's browser would be, and closes it after a while. See keepPageOpen.
   */
  keepOpen?(): Promise<void>;
  close(): Promise<void>;
}

export type OpenBrowser = () => Promise<LoginBrowser>;

/** The ID as beWell takes it: digits, one leading zero dropped, as its page does. */
export function normalizeId(id: string, authType: AuthType): string {
  const trimmed = id.trim();
  if (authType === "2") return trimmed;
  return trimmed.startsWith("0") ? trimmed.slice(1) : trimmed;
}

/** Asks beWell to send the one-time code. */
export async function sendCode(browser: LoginBrowser, identity: Identity): Promise<void> {
  const res = await browser.post(new URL("LoginController/SendOTP", API_BASE_URL).href, {
    ID: normalizeId(identity.id, identity.authType),
    // The page sends the phone number in a field called DOB.
    DOB: identity.phone,
    authType: identity.authType,
    res: await browser.captcha(),
  });
  if (res.status !== 200 || !res.text.includes("OTP Code Sent")) {
    throw new BewellLoginError(
      res.status === 200
        ? "beWell did not send a code. Check the ID and the mobile number the hospital has on file."
        : `beWell answered HTTP ${res.status}.`,
    );
  }
}

/** Sends the code; returns the session's cookies. */
export async function verifyCode(browser: LoginBrowser, identity: Identity, otpCode: string): Promise<Cookie[]> {
  if (!/^\d{4,8}$/.test(otpCode)) throw new BewellLoginError("The code is digits only.");
  const res = await browser.post(new URL("LoginController/AuthenticateOTP", API_BASE_URL).href, {
    otpCode,
    ID: normalizeId(identity.id, identity.authType),
    DOB: identity.phone,
    authType: identity.authType,
    res: await browser.captcha(),
  });
  let status = "";
  try {
    status = String((JSON.parse(res.text) as { StatusMsg?: unknown }).StatusMsg ?? "");
  } catch {
    // Not JSON: a refusal.
  }
  if (res.status !== 200 || !/success/i.test(status)) {
    throw new BewellLoginError(status && !/success/i.test(status) ? status : "beWell did not accept the code.");
  }
  const cookies = await browser.cookies();
  if (cookies.length === 0) throw new BewellLoginError("beWell accepted the code but set no session cookie.");
  return cookies;
}

/** How long a person has to solve reCAPTCHA's puzzle. */
const CAPTCHA_TIMEOUT_MS = 5 * 60_000;

// Run in the page, so given as source: a TypeScript loader may wrap compiled
// functions in helpers the page doesn't have.

/** Renders an invisible reCAPTCHA widget for the site key and resolves with its token. */
const CAPTCHA_SCRIPT = `function (siteKey, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var el = document.createElement("div");
    document.body.appendChild(el);
    var timer = setTimeout(function () { reject(new Error("timeout")); }, timeoutMs);
    var id = window.grecaptcha.render(el, {
      sitekey: siteKey,
      size: "invisible",
      callback: function (token) { clearTimeout(timer); resolve(token); },
      "error-callback": function () { clearTimeout(timer); reject(new Error("error")); }
    });
    window.grecaptcha.execute(id);
  });
}`;

/** POSTs a JSON body with the page's cookies, as the page's own fetch does. */
const POST_SCRIPT = `function (url, body) {
  return fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", accept: "application/json, text/plain, */*" },
    body: body
  }).then(function (res) { return res.text().then(function (text) { return { status: res.status, text: text }; }); });
}`;

/** What beWell's page keeps from the code's answer, so its signed-in page opens. */
const SIGNED_IN_SCRIPT = `function (answer) {
  var keys = ["FirstName", "LastName", "StatusMsg", "TokenCreateDate", "Phone1", "Phone2", "City", "Postal", "BirthDate", "ExtPatientId", "IsTempPwd", "Email", "Address"];
  var data = JSON.parse(answer);
  keys.forEach(function (key) { if (data[key]) localStorage.setItem(key, data[key]); });
}`;

/** A data call from the page, as its own fetches make them; returns the HTTP status. */
const PROBE_SCRIPT = `function (url) {
  return fetch(url, { credentials: "include", headers: { accept: "application/json", "content-type": "application/json" } })
    .then(function (res) { return res.status; }, function () { return 0; });
}`;

/** beWell's "stay signed in" button in its session popup. */
const STAY_IN = "\u05dc\u05d4\u05e9\u05d0\u05e8 \u05de\u05d7\u05d5\u05d1\u05e8";

/** How long keepOpen leaves the page open. */
const KEEP_OPEN_MS = 40 * 60_000;

const READY_SCRIPT = `typeof window.grecaptcha === "object" && typeof window.grecaptcha.render === "function"`;

/** The sign-in browser that has the profile, and the launch in progress. */
let open: { close(): Promise<void> } | undefined;
let launching: Promise<unknown> = Promise.resolve();

/**
 * Chromium on the beWell sign-in page. Headless unless ICHILOV_HEADLESS=false;
 * ICHILOV_CHROMIUM_PATH picks another Chromium than Playwright's own.
 *
 * reCAPTCHA asks more puzzles of a browser that looks automated or new, so
 * this runs full Chromium in its new headless mode (not the bare headless
 * shell), without the automation flag or "HeadlessChrome" in its user agent,
 * and keeps one profile in ICHILOV_CONFIG_DIR/browser, so Google's cookies
 * from one sign-in carry over to the next.
 */
export async function openChromium(): Promise<LoginBrowser> {
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new BewellLoginError("Playwright is not installed: run `npm install` and `npx playwright install chromium`.");
  }
  const headless = process.env.ICHILOV_HEADLESS !== "false";
  const executablePath = process.env.ICHILOV_CHROMIUM_PATH || undefined;
  const options = {
    headless,
    ...(executablePath ? { executablePath } : { channel: "chromium" }),
    args: ["--disable-blink-features=AutomationControlled"],
    locale: "he-IL",
    timezoneId: "Asia/Jerusalem",
    viewport: { width: 1280, height: 800 },
    // The page forbids eval, which Playwright waits on the page with.
    bypassCSP: true,
  };
  const profile = join(configDir(), "browser");
  // The profile takes one browser at a time. A newer sign-in replaces an older
  // one still open (say, the form sent twice), as the sign-in page does; once
  // none is open, a lock left in the profile is from a browser that died with
  // its container.
  const launch = launching.then(async () => {
    await open?.close().catch(() => undefined);
    for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) await rm(join(profile, lock), { force: true });
    return chromium.launchPersistentContext(profile, options);
  });
  launching = launch.catch(() => undefined);
  const context = await launch.catch((err: unknown) => {
    throw new BewellLoginError(`Could not start Chromium (${err instanceof Error ? err.message : String(err)}). Run \`npx playwright install chromium\`.`);
  });
  open = context;
  const browser = {
    close: async () => {
      if (open === context) open = undefined;
      await context.close();
    },
  };
  try {
    // New headless mode still says "HeadlessChrome" in its user agent, which Google reads as a bot.
    const first = context.pages()[0] ?? (await context.newPage());
    const userAgent = String(await first.evaluate("navigator.userAgent"));
    if (userAgent.includes("HeadlessChrome")) {
      const plain = userAgent.replace("HeadlessChrome", "Chrome");
      await context.setExtraHTTPHeaders({ "user-agent": plain });
      await context.addInitScript(`Object.defineProperty(Navigator.prototype, "userAgent", { get: () => ${JSON.stringify(plain)} });`);
    }
    const page = first;
    await page.goto(LOGIN_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // The page loads reCAPTCHA itself; load it if it has not by the time the page settles.
    if (!(await page.waitForFunction(READY_SCRIPT, undefined, { timeout: 15_000 }).then(() => true, () => false))) {
      await page.addScriptTag({ url: "https://www.google.com/recaptcha/api.js?render=explicit" });
      await page.waitForFunction(READY_SCRIPT, undefined, { timeout: 30_000 });
    }
    let signInAnswer = "";
    /** reCAPTCHA's puzzle frame, while it is on screen. */
    const visiblePuzzle = async () => {
      for (const el of await page.$$('iframe[src*="/recaptcha/api2/bframe"]')) {
        const box = await el.boundingBox();
        if (box && box.width > 50 && box.height > 50 && (await el.isVisible())) return el;
      }
      return undefined;
    };
    return {
      async captcha() {
        return page
          .evaluate(`(${CAPTCHA_SCRIPT})(${JSON.stringify(RECAPTCHA_SITE_KEY)}, ${CAPTCHA_TIMEOUT_MS})`)
          .then((token) => {
            if (typeof token !== "string" || !token) throw new Error("no token");
            return token;
          })
          .catch((err: unknown) => {
            console.error(`[ichilov-mcp] reCAPTCHA failed: ${err instanceof Error ? err.message : String(err)}`);
            throw new BewellLoginError("reCAPTCHA did not pass this sign-in. Start again.");
          });
      },
      async puzzle() {
        const frame = await visiblePuzzle();
        return frame ? new Uint8Array(await frame.screenshot()) : undefined;
      },
      async click(x, y) {
        const box = await (await visiblePuzzle())?.boundingBox();
        if (!box) return;
        await page.mouse.click(box.x + Math.min(Math.max(x, 0), box.width), box.y + Math.min(Math.max(y, 0), box.height));
      },
      async post(url, body) {
        const res = (await page.evaluate(`(${POST_SCRIPT})(${JSON.stringify(url)}, ${JSON.stringify(JSON.stringify(body))})`)) as { status: number; text: string };
        if (url.endsWith("/AuthenticateOTP") && res.status === 200) signInAnswer = res.text;
        return res;
      },
      async cookies() {
        const all = await context.cookies(API_BASE_URL);
        return all.map((c) => ({ name: c.name, value: c.value, ...(c.expires > 0 ? { expires: Math.floor(c.expires) } : {}) }));
      },
      async keepOpen() {
        await keepPageOpen(page, signInAnswer, () => browser.close());
      },
      async close() {
        await browser.close();
      },
    };
  } catch (err) {
    await browser.close().catch(() => undefined);
    throw err instanceof BewellLoginError ? err : new BewellLoginError(`Could not open the beWell sign-in page: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * An experiment on how long beWell keeps a sign-in (ICHILOV_KEEP_PAGE_OPEN).
 * Opens beWell's signed-in page as the site does after a sign-in, then lets
 * the page run as it would in a person's browser: when its session popup
 * shows, clicks "stay signed in", the site's only way to extend a session.
 * Every 2 minutes it makes a data call from the page and logs the answer's
 * status, so the log shows whether the site itself outlasts the 20 minutes
 * the server's own calls get. Logs no personal data. Closes the browser after
 * KEEP_OPEN_MS, or sooner when a new sign-in opens it.
 */
async function keepPageOpen(page: import("playwright").Page, answer: string, close: () => Promise<void>): Promise<void> {
  const log = (message: string) => console.error(`[ichilov-mcp] page kept open: ${message}`);
  const started = Date.now();
  const minutes = () => ((Date.now() - started) / 60_000).toFixed(1);
  try {
    await page.evaluate(`(${SIGNED_IN_SCRIPT})(${JSON.stringify(answer || "{}")})`);
    await page.goto(`${SITE_ORIGIN}/bewell/main`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    log(`opened ${new URL(page.url()).pathname}`);
  } catch (err) {
    log(`could not open the signed-in page: ${err instanceof Error ? err.message : String(err)}`);
    await close().catch(() => undefined);
    return;
  }
  const probeUrl = new URL("PrivateArea/GetPatientApointments", API_BASE_URL).href;
  let lastProbe = 0;
  const timer = setInterval(() => {
    void (async () => {
      if (page.isClosed()) {
        clearInterval(timer);
        return;
      }
      if (Date.now() - started > KEEP_OPEN_MS) {
        clearInterval(timer);
        log(`closing after ${minutes()} min`);
        await close().catch(() => undefined);
        return;
      }
      try {
        const stay = page.getByRole("button", { name: STAY_IN });
        if (await stay.isVisible()) {
          await stay.click();
          log(`clicked "stay signed in" at ${minutes()} min`);
        }
        if (Date.now() - lastProbe >= 2 * 60_000) {
          lastProbe = Date.now();
          const status = await page.evaluate(`(${PROBE_SCRIPT})(${JSON.stringify(probeUrl)})`);
          log(`data call at ${minutes()} min: HTTP ${String(status)}, page ${new URL(page.url()).pathname}`);
        }
      } catch (err) {
        log(`check failed at ${minutes()} min: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }, 15_000);
  timer.unref();
}
