import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { DocumentEntry } from "./api.js";
import type { SessionManager } from "./session.js";

export const VERSION = "0.1.0";

const INSTRUCTIONS = [
  "Unofficial, read-only reader of the user's own records in beWell, the patient portal of Tel Aviv Sourasky Medical Center (Ichilov, איכילוב). Unaffiliated with the hospital.",
  "Tools: list_documents → get_document_pdf; list_appointments.",
  "Lab results, imaging reports and visit summaries are PDFs only: list_documents lists them and get_document_pdf returns one (pass its type, number, version and part from the list). There are no prescriptions in beWell.",
  "When a tool says the user must sign in, call ichilov_login and give the user the link it returns; the user signs in on that page (ID, mobile number and a one-time code). Never ask for these in the chat.",
  "Keep Hebrew text as beWell gives it.",
].join(" ");

const KINDS = ["all", "lab", "imaging", "other"] as const;

const schemas = {
  empty: z.object({}),
  documents: z.object({
    kind: z.enum(KINDS).default("all").describe("lab: lab results; imaging: radiology reports; other: summaries and the rest."),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only documents on or after this day, yyyy-MM-dd."),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only documents on or before this day, yyyy-MM-dd."),
    search: z.string().max(100).optional().describe("Only documents whose title or department contains this text."),
  }),
  pdf: z.object({
    type: z.string().regex(/^[A-Z]{2,4}$/).describe("DOKAR of the document, e.g. LAB."),
    number: z.string().regex(/^\d{1,30}$/).describe("DOKNR of the document."),
    version: z.string().regex(/^\d{1,4}$/).describe("DOKVR of the document."),
    part: z.string().regex(/^\d{1,4}$/).describe("DOKTL of the document."),
  }),
};

function inputSchema(schema: z.ZodObject<z.ZodRawShape>): Tool["inputSchema"] {
  const properties: Record<string, object> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(schema.shape)) {
    const field = value as z.ZodTypeAny;
    let inner = field;
    while (inner instanceof z.ZodOptional || inner instanceof z.ZodDefault) inner = inner._def.innerType;
    properties[key] = {
      type: "string",
      ...(field.description ? { description: field.description } : {}),
      ...(inner instanceof z.ZodEnum ? { enum: inner.options } : {}),
    };
    if (!field.isOptional()) required.push(key);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

const TOOLS: { name: string; description: string; schema: z.ZodObject<z.ZodRawShape> }[] = [
  { name: "ichilov_login", description: "Get the link where the user signs in to beWell (ID, mobile number and one-time code are typed on that page, never in the chat). Returns the status when already signed in.", schema: schemas.empty },
  { name: "ichilov_session_status", description: "Whether this server is signed in to beWell, since when, until when, and the sign-in link when it is not.", schema: schemas.empty },
  { name: "ichilov_logout", description: "Sign out of beWell here: end the session and forget it.", schema: schemas.empty },
  { name: "list_documents", description: "The documents in the patient's file (lab results, imaging, visit and hospitalization summaries), newest first, with the type, number, version and part get_document_pdf takes.", schema: schemas.documents },
  { name: "get_document_pdf", description: "Download one document from list_documents as a PDF (base64).", schema: schemas.pdf },
  { name: "list_appointments", description: "The patient's upcoming appointments at the hospital.", schema: schemas.empty },
];

/** Which list a document falls in, as the beWell site sorts its tabs. */
export function kindOf(doc: DocumentEntry): (typeof KINDS)[number] {
  if (doc.DOKAR === "LAB" || doc.PROTF?.includes("מעבדה") || /LAB/.test(doc.DTID ?? "")) return "lab";
  if (doc.DOKAR === "RIS") return "imaging";
  return "other";
}

export function filterDocuments(docs: DocumentEntry[], args: z.infer<typeof schemas.documents>): DocumentEntry[] {
  const search = args.search?.trim();
  return docs
    .filter((d) => args.kind === "all" || kindOf(d) === args.kind)
    .filter((d) => !args.from || (d.DODAT ?? "") >= args.from)
    .filter((d) => !args.to || (d.DODAT ?? "") <= args.to)
    .filter((d) => !search || [d.DKTXT, d.ORGDO, d.PROTF].some((t) => t?.includes(search)))
    .sort((a, b) => `${b.DODAT ?? ""} ${b.DOTIM ?? ""}`.localeCompare(`${a.DODAT ?? ""} ${a.DOTIM ?? ""}`));
}

export function createMcpServer(session: SessionManager): Server {
  const api = session.api;
  const server = new Server({ name: "ichilov-mcp", version: VERSION }, { instructions: INSTRUCTIONS, capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchema(t.schema) })),
  }));

  async function call(name: string, raw: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "ichilov_login": {
        const status = await session.status();
        if (status.state === "signed_in") return { ...status, message: "Already signed in." };
        return { ...status, message: `Ask the user to open ${status.signInUrl} and sign in there, then try the request again.` };
      }
      case "ichilov_session_status":
        return session.status();
      case "ichilov_logout":
        if (session.keeper.status().state === "signed_in") await api.logout().catch(() => undefined);
        await session.keeper.signOut();
        return { state: "signed_out", message: "Signed out; the saved session is gone." };
      case "list_documents": {
        const args = schemas.documents.parse(raw);
        const docs = filterDocuments(await api.documents(), args);
        return { count: docs.length, documents: docs.map((d) => ({ kind: kindOf(d), ...d })) };
      }
      case "get_document_pdf": {
        const args = schemas.pdf.parse(raw);
        const bytes = await api.documentPdf(args);
        return {
          filename: `ichilov-${args.type.toLowerCase()}-${args.number}.pdf`,
          mimeType: "application/pdf",
          byteLength: bytes.byteLength,
          base64: Buffer.from(bytes).toString("base64"),
        };
      }
      case "list_appointments":
        return { appointments: await api.appointments() };
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await call(request.params.name, request.params.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : "tool failed" }] };
    }
  });

  return server;
}
