import type { Fetch } from "../src/api.js";
import type { Cookie } from "../src/cookies.js";
import type { LoginBrowser } from "../src/login.js";
import type { SavedSession, SessionStore } from "../src/store.js";

export function memoryStore(initial?: SavedSession): SessionStore & { saved?: SavedSession } {
  const store = {
    saved: initial,
    async load() {
      return store.saved;
    },
    async save(s: SavedSession) {
      store.saved = s;
    },
    async clear() {
      store.saved = undefined;
    },
  };
  return store;
}

export interface Call {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
}

/** A fetch that answers from a route table and records every call. */
export function fakeFetch(routes: (call: Call) => Response | undefined): Fetch & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: (init?.headers as Record<string, string>) ?? {},
    };
    calls.push(call);
    return routes(call) ?? new Response("not found", { status: 404 });
  }) as Fetch & { calls: Call[] };
  f.calls = calls;
  return f;
}

export const text = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers });

/** beWell's list answers: a JSON string holding the JSON. */
export const list = (items: unknown) => new Response(JSON.stringify(JSON.stringify(items)), { headers: { "content-type": "application/json" } });

export interface FakeBrowser extends LoginBrowser {
  posts: { url: string; body: Record<string, unknown> }[];
  clicks: [number, number][];
  closed: boolean;
}

/**
 * The beWell sign-in page, answering SendOTP and AuthenticateOTP; the right
 * code is 123456. With puzzle, the first reCAPTCHA token waits for a click
 * on its puzzle.
 */
export function fakeBrowser(options: { puzzle?: boolean; cookies?: Cookie[] } = {}): FakeBrowser {
  let tokens = 0;
  let solved: (() => void) | undefined;
  let showing = false;
  const browser: FakeBrowser = {
    posts: [],
    clicks: [],
    closed: false,
    async captcha() {
      if (options.puzzle && tokens === 0) {
        showing = true;
        await new Promise<void>((resolve) => (solved = resolve));
        showing = false;
      }
      tokens += 1;
      return `token-${tokens}`;
    },
    async puzzle() {
      return showing ? new Uint8Array([0x89, 0x50, 0x4e, 0x47]) : undefined;
    },
    async click(x, y) {
      browser.clicks.push([x, y]);
      solved?.();
    },
    async post(url, body) {
      browser.posts.push({ url, body: body as Record<string, unknown> });
      if (url.endsWith("/SendOTP")) return { status: 200, text: '"OTP Code Sent to User"' };
      if (url.endsWith("/AuthenticateOTP")) {
        const ok = (body as { otpCode?: string }).otpCode === "123456";
        return { status: 200, text: JSON.stringify(ok ? { StatusMsg: "Success", FirstName: "Example" } : { StatusMsg: "Wrong code" }) };
      }
      return { status: 404, text: "" };
    },
    async cookies() {
      return options.cookies ?? [{ name: "session", value: "s1" }];
    },
    async close() {
      browser.closed = true;
    },
  };
  return browser;
}
