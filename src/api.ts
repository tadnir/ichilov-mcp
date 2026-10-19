/**
 * beWell's patient API (api.tasmc.org.il), read-only calls only.
 *
 * Every call carries the session's cookies, as the beWell site's own
 * fetch(..., { credentials: "include" }) does. Signed out, the API answers 401
 * with an IIS error page. List answers are a JSON string holding the JSON, so
 * they are parsed twice.
 */
import type { CookieJar } from "./cookies.js";

export type Fetch = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

export const SITE_ORIGIN = "https://www.tasmc.org.il";
export const API_BASE_URL = process.env.ICHILOV_API_BASE_URL || "https://api.tasmc.org.il/api/";

const HEADERS: Record<string, string> = {
  // The headers the beWell site's own fetch sends.
  accept: "application/json",
  "content-type": "application/json",
  "accept-language": "he,en;q=0.9",
  origin: SITE_ORIGIN,
  referer: `${SITE_ORIGIN}/`,
};

export class IchilovApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "IchilovApiError";
  }
}

/** beWell refused the cookies: the session is over. */
export class Unauthorized extends IchilovApiError {
  constructor() {
    super("beWell ended the session.", 401);
    this.name = "Unauthorized";
  }
}

/** One document of the patient's file, as beWell lists it (empty fields left out). */
export type DocumentEntry = Record<string, unknown> & {
  DOKAR?: string;
  DOKNR?: string;
  DOKVR?: string;
  DOKTL?: string;
  DODAT?: string;
  DTID?: string;
  DKTXT?: string;
  PROTF?: string;
  ORGDO?: string;
};

/** What identifies one document: its type, number, version and part. */
export interface DocumentKey {
  type: string;
  number: string;
  version: string;
  part: string;
}

export class BewellApi {
  readonly #jar: () => Promise<CookieJar>;
  readonly #changed: () => Promise<void>;
  readonly #fetch: Fetch;

  /**
   * jar returns the live session's cookies (throwing when there is none);
   * changed is called after the API set new ones, so they can be saved.
   */
  constructor(jar: () => Promise<CookieJar>, changed: () => Promise<void>, f: Fetch = fetch) {
    this.#jar = jar;
    this.#changed = changed;
    this.#fetch = f;
  }

  /** "OK" while the session lives. Each call also counts as activity, which keeps it alive. */
  async ping(): Promise<void> {
    const res = await this.#request("LoginController/TimeOutResponseDialog", { method: "GET" });
    const text = (await res.text()).replace(/^"|"$/g, "");
    if (text !== "OK") throw new IchilovApiError(`beWell's session check answered ${JSON.stringify(text.slice(0, 40))}.`);
  }

  async logout(): Promise<void> {
    await this.#request("LoginController/Logout", { method: "POST" });
  }

  /**
   * Every document in the patient's file: lab results, imaging and visit
   * summaries. The site's three record tabs read the same list and sort it by
   * PROTF and DTID, so one call returns all of it.
   */
  async documents(): Promise<DocumentEntry[]> {
    const list = await this.#getList("PrivateArea/GetLaboratoryTestResults");
    return list.map((entry) => compact(entry) as DocumentEntry);
  }

  async appointments(): Promise<unknown[]> {
    const list = await this.#getList("PrivateArea/GetPatientApointments");
    return list.map(compact);
  }

  /** One document as a PDF. Lab results, imaging reports and summaries all come this way. */
  async documentPdf(key: DocumentKey): Promise<Uint8Array> {
    const query = new URLSearchParams({
      DocumentType: code(key.type, /^[A-Z]{2,4}$/),
      DocumentNumber: code(key.number, /^\d{1,30}$/),
      DocumentVersion: code(key.version, /^\d{1,4}$/),
      DocumentPart: code(key.part, /^\d{1,4}$/),
      ServiceCode: "0",
    });
    const res = await this.#request(`PrivateArea/GetLaboratoryTestResultsPDF?${query}`, { method: "GET", headers: { accept: "application/pdf, */*" } });
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!isPdf(bytes)) throw new IchilovApiError("beWell did not return a PDF for this document.");
    return bytes;
  }

  async #getList(path: string): Promise<Record<string, unknown>[]> {
    const res = await this.#request(path, { method: "GET" });
    const parsed = parseTwice(await res.text());
    if (parsed === null || parsed === undefined || parsed === "") return [];
    if (!Array.isArray(parsed)) throw new IchilovApiError(`beWell answered ${path} with something other than a list.`);
    return parsed as Record<string, unknown>[];
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    const jar = await this.#jar();
    const res = await this.#fetch(new URL(path, API_BASE_URL), {
      ...init,
      headers: { ...HEADERS, ...(init.headers as Record<string, string> | undefined), cookie: jar.header() },
    });
    if (jar.update(res)) await this.#changed();
    if (res.status === 401 || res.status === 403) throw new Unauthorized();
    if (!res.ok) throw new IchilovApiError(`beWell answered HTTP ${res.status}.`, res.status);
    return res;
  }
}

/** Lists come as a JSON string holding the JSON. */
export function parseTwice(text: string): unknown {
  let value: unknown = text.trim() === "" ? "" : JSON.parse(text);
  if (typeof value === "string" && value.trim() !== "") {
    try {
      value = JSON.parse(value);
    } catch {
      // A plain string, such as "null" already parsed or a message.
    }
  }
  return value;
}

/** Drops empty values and the xxxSpecified flags beWell's SOAP backend adds to every field. */
export function compact(entry: unknown): unknown {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key.endsWith("Specified")) continue;
    if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) continue;
    if (typeof value === "string" && /^0{4}-0{2}-0{2}/.test(value)) continue;
    out[key] = value;
  }
  return out;
}

function code(value: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw new IchilovApiError(`Not a beWell document field: ${JSON.stringify(value)}`);
  return value;
}

function isPdf(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}
