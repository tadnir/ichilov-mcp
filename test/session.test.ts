import { afterEach, describe, expect, test } from "vitest";
import { request } from "node:http";
import { compact, parseTwice } from "../src/api.js";
import { normalizeId } from "../src/login.js";
import { SessionManager } from "../src/session.js";
import { createMcpServer, filterDocuments } from "../src/server.js";
import { fakeBrowser, fakeFetch, list, memoryStore, text, type FakeBrowser } from "./helpers.js";

/** Made-up documents in beWell's shape. */
const DOCS = [
  { DOKAR: "LAB", DOKNR: "0000000000000000000000001", DOKVR: "01", DOKTL: "000", DODAT: "2026-01-02", DOTIM: "08:00:00", DTID: "Z05LABFIND", PROTF: "מעבדה", DKTXT: "בדיקת דם", ORGDO: "מעבדה מרכזית", EMPTY: "", DOKARSpecified: true },
  { DOKAR: "RIS", DOKNR: "0000000000000000000000002", DOKVR: "01", DOKTL: "000", DODAT: "2026-02-03", DOTIM: "09:00:00", DTID: "Z85CAMER", PROTF: "דימות", DKTXT: "צילום", ORGDO: "רנטגן" },
  { DOKAR: "PDF", DOKNR: "0000000000000000000000003", DOKVR: "01", DOKTL: "000", DODAT: "2025-12-01", DOTIM: "10:00:00", DTID: "Z29FIND_V2", PROTF: "סיכום", DKTXT: "סיכום ביקור", ORGDO: "מרפאה" },
];

function world() {
  return fakeFetch((call) => {
    if (call.headers.cookie !== "session=s1") return text("<html>401</html>", 401);
    if (call.url.endsWith("/LoginController/TimeOutResponseDialog")) return text('"OK"', 200, { "set-cookie": "session=s1; Path=/; HttpOnly" });
    if (call.url.endsWith("/PrivateArea/GetLaboratoryTestResults")) return list(DOCS);
    if (call.url.endsWith("/PrivateArea/GetPatientApointments")) return text('"null"');
    if (call.url.includes("/PrivateArea/GetLaboratoryTestResultsPDF?")) return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
    return undefined;
  });
}

function http(port: number, method: string, path: string, body?: string, host = `127.0.0.1:${port}`, extra: Record<string, string> = {}) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host, "content-type": "application/x-www-form-urlencoded", ...extra } }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve({ status: res.statusCode!, text: t }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

let session: SessionManager | undefined;
afterEach(() => session?.stop());

async function signedOutSession(puzzle = false) {
  const browsers: FakeBrowser[] = [];
  const f = world();
  session = new SessionManager({
    store: memoryStore(),
    fetch: f,
    port: 0,
    stepWaitMs: 50,
    openBrowser: async () => {
      const b = fakeBrowser({ puzzle: puzzle && browsers.length === 0 });
      browsers.push(b);
      return b;
    },
  });
  await session.start();
  const url = await session.signInUrl();
  return { f, session, browsers, port: Number(new URL(url).port) };
}

const csrfOf = (html: string) => /name="csrf" value="([0-9a-f]+)"/.exec(html)![1]!;

describe("sign-in page", () => {
  test("ID and phone, then code, then signed in; each step gets its own reCAPTCHA token", async () => {
    const { session, browsers, port } = await signedOutSession();
    const first = await http(port, "GET", "/");
    expect(first.text).toContain("Send code");
    const csrf = csrfOf(first.text);

    expect((await http(port, "POST", "/start", `csrf=${csrf}&id=012345678&phone=050-000-0000`)).status).toBe(303);
    const browser = browsers[0]!;
    expect(browser.posts[0]).toEqual({
      url: "https://api.tasmc.org.il/api/LoginController/SendOTP",
      body: { ID: "12345678", DOB: "0500000000", authType: "1", res: "token-1" },
    });
    expect((await http(port, "GET", "/")).text).toContain("Enter the code");

    expect((await http(port, "POST", "/code", `csrf=${csrf}&code=000000`)).status).toBe(303);
    expect((await http(port, "GET", "/")).text).toContain("Wrong code");
    expect((await http(port, "POST", "/code", `csrf=${csrf}&code=123456`)).status).toBe(303);
    expect(browser.posts[2]!.body).toMatchObject({ otpCode: "123456", ID: "12345678", res: "token-3" });
    expect(browser.closed).toBe(true);
    expect(session.keeper.status().state).toBe("signed_in");

    // Signing in again keeps the session until it succeeds.
    const status = (await http(port, "GET", "/")).text;
    expect(status).toContain("Signed in to beWell");
    expect(status).toContain("Sign in again");
    expect((await http(port, "POST", "/start", `csrf=${csrf}&id=AB123&passport=1&phone=0500000000`)).status).toBe(303);
    expect(browsers[1]!.posts[0]!.body).toMatchObject({ ID: "AB123", authType: "2" });
    expect(session.keeper.status().state).toBe("signed_in");
  });

  test("a reCAPTCHA puzzle is shown on the page and clicks on it reach the browser", async () => {
    const { session, browsers, port } = await signedOutSession(true);
    const csrf = csrfOf((await http(port, "GET", "/")).text);
    expect((await http(port, "POST", "/start", `csrf=${csrf}&id=12345678&phone=0500000000`)).status).toBe(303);
    const puzzle = await http(port, "GET", "/");
    expect(puzzle.text).toContain("Solve reCAPTCHA");
    expect(puzzle.text).toContain('src="puzzle.js"');
    expect((await http(port, "GET", "/puzzle.js")).text).toContain("x-puzzle-live");
    expect((await http(port, "GET", "/puzzle.png")).status).toBe(200);
    expect((await http(port, "POST", "/puzzle", `csrf=${csrf}&p.x=10&p.y=20`, undefined, { "x-puzzle-live": "1" })).status).toBe(204);
    expect((await http(port, "POST", "/puzzle", `csrf=${csrf}&p.x=120&p.y=45`)).status).toBe(303);
    expect(browsers[0]!.clicks).toEqual([[10, 20], [120, 45]]);
    expect((await http(port, "GET", "/")).text).toContain("Enter the code");
    expect((await http(port, "POST", "/code", `csrf=${csrf}&code=123456`)).status).toBe(303);
    expect(session.keeper.status().state).toBe("signed_in");
  });

  test("other hosts, forms without the token and bad input are refused", async () => {
    const { port, browsers } = await signedOutSession();
    expect((await http(port, "GET", "/", undefined, "attacker.example")).status).toBe(421);
    expect((await http(port, "POST", "/start", "csrf=nope&id=1&phone=0500000000")).status).toBe(400);
    const csrf = csrfOf((await http(port, "GET", "/")).text);
    expect((await http(port, "POST", "/start", `csrf=${csrf}&id=12a&phone=0500000000`)).status).toBe(400);
    expect(browsers).toHaveLength(0);
  });
});

describe("tools", () => {
  async function callTool(server: ReturnType<typeof createMcpServer>, name: string, args: Record<string, unknown> = {}) {
    const handler = (server as unknown as { _requestHandlers: Map<string, (r: unknown, x: unknown) => Promise<unknown>> })._requestHandlers.get("tools/call")!;
    return (await handler({ method: "tools/call", params: { name, arguments: args } }, {})) as { isError?: boolean; content: { text: string }[] };
  }

  test("signed out: data tools answer with the sign-in link", async () => {
    const { session, port } = await signedOutSession();
    const result = await callTool(createMcpServer(session), "list_documents");
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(`http://localhost:${port}/`);
    expect(result.content[0]!.text).toContain("Never ask the user");
  });

  test("signed in: documents, PDFs and appointments, with the session's cookie", async () => {
    const { session, f } = await signedOutSession();
    await session.keeper.signedIn([{ name: "session", value: "s1" }], 3_600_000);
    const server = createMcpServer(session);
    const labs = JSON.parse((await callTool(server, "list_documents", { kind: "lab" })).content[0]!.text);
    expect(labs.count).toBe(1);
    expect(labs.documents[0]).toMatchObject({ kind: "lab", DOKNR: "0000000000000000000000001" });
    expect(labs.documents[0]).not.toHaveProperty("EMPTY");
    expect(labs.documents[0]).not.toHaveProperty("DOKARSpecified");

    const pdf = JSON.parse((await callTool(server, "get_document_pdf", { type: "LAB", number: "0000000000000000000000001", version: "01", part: "000" })).content[0]!.text);
    expect(pdf.mimeType).toBe("application/pdf");
    expect(f.calls.at(-1)!.url).toContain("DocumentType=LAB&DocumentNumber=0000000000000000000000001&DocumentVersion=01&DocumentPart=000&ServiceCode=0");
    expect(f.calls.at(-1)!.headers.origin).toBe("https://www.tasmc.org.il");

    expect(JSON.parse((await callTool(server, "list_appointments")).content[0]!.text)).toEqual({ appointments: [] });
  });

  test("a refused cookie ends the session and the tools ask for a sign-in", async () => {
    const { session } = await signedOutSession();
    await session.keeper.signedIn([{ name: "session", value: "stale" }], 3_600_000);
    const result = await callTool(createMcpServer(session), "list_documents");
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Not signed in");
    expect(session.keeper.status().state).toBe("expired");
  });

  test("the keep-alive check uses the session", async () => {
    const { session } = await signedOutSession();
    await session.keeper.signedIn([{ name: "session", value: "s1" }], 3_600_000);
    await session.keeper.tick();
    expect(session.keeper.status()).toMatchObject({ state: "signed_in" });
    expect(session.keeper.status().lastError).toBeUndefined();
  });

  test("the check ends a session beWell refuses, though its session check still answers OK", async () => {
    const f = fakeFetch((call) => {
      if (call.url.endsWith("/LoginController/TimeOutResponseDialog")) return text('"OK"');
      return text("<html>401</html>", 401);
    });
    session = new SessionManager({ store: memoryStore(), fetch: f, port: 0 });
    await session.start();
    await session.keeper.signedIn([{ name: "session", value: "s1" }], 3_600_000);
    await session.keeper.tick();
    expect(session.keeper.status().state).toBe("expired");
    expect(f.calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/LoginController/TimeOutResponseDialog", "/api/PrivateArea/GetPatientApointments"]);
  });

  test("bad document fields never reach a URL", async () => {
    const { session } = await signedOutSession();
    await session.keeper.signedIn([{ name: "session", value: "s1" }], 3_600_000);
    const result = await callTool(createMcpServer(session), "get_document_pdf", { type: "LAB", number: "../x", version: "01", part: "000" });
    expect(result.isError).toBe(true);
  });
});

describe("helpers", () => {
  test("lists are parsed twice, and empty answers are empty", () => {
    expect(parseTwice(JSON.stringify(JSON.stringify([1])))).toEqual([1]);
    expect(parseTwice('"null"')).toBeNull();
    expect(parseTwice("")).toBe("");
  });

  test("compact drops empty fields and Specified flags", () => {
    expect(compact({ a: "1", b: "", c: null, dSpecified: true, e: "0000-00-00", f: [] })).toEqual({ a: "1" });
  });

  test("one leading zero is dropped from an ID, as beWell's page does", () => {
    expect(normalizeId("012345678", "1")).toBe("12345678");
    expect(normalizeId("0AB1", "2")).toBe("0AB1");
  });

  test("documents filter by kind, date and text, newest first", () => {
    const docs = DOCS.map((d) => compact(d) as (typeof DOCS)[number]);
    expect(filterDocuments(docs, { kind: "all" }).map((d) => d.DOKAR)).toEqual(["RIS", "LAB", "PDF"]);
    expect(filterDocuments(docs, { kind: "imaging" }).map((d) => d.DOKAR)).toEqual(["RIS"]);
    expect(filterDocuments(docs, { kind: "all", from: "2026-01-01", to: "2026-01-31" }).map((d) => d.DOKAR)).toEqual(["LAB"]);
    expect(filterDocuments(docs, { kind: "all", search: "סיכום" }).map((d) => d.DOKAR)).toEqual(["PDF"]);
  });
});
