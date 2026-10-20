// HTTP plumbing: JSON bodies with a size limit and duplicate-key rejection,
// JSON and HTML responses with the service's security headers.
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseUniqueJson } from "../../../packages/protocol/src/node.ts";
import { fail } from "./errors.ts";

export const MAX_BODY_BYTES = 32 * 1024;

const SECURITY = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

export function sendJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string | number> = {}) {
  const payload = value === undefined ? "" : JSON.stringify(value);
  response.writeHead(status, {
    ...SECURITY, ...headers,
    ...(payload ? { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) } : {}),
  });
  response.end(payload);
}

/** The request body as a JSON object. Requires a JSON content type when a body is present. */
export async function readJson(request: IncomingMessage, o: { optional?: boolean } = {}): Promise<Record<string, unknown>> {
  const declared = Number(request.headers["content-length"]);
  if (declared > MAX_BODY_BYTES) fail("bad_request", "The request body is too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) fail("bad_request", "The request body is too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return o.optional ? {} : fail("bad_request", "A JSON body is required");
  if (!/^application\/json\s*(;|$)/i.test(request.headers["content-type"] ?? "")) fail("bad_request", "The content type must be application/json");
  let value: unknown;
  try { value = parseUniqueJson(Buffer.concat(chunks).toString("utf8")); } catch { fail("bad_request", "The request body is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("bad_request", "The request body must be a JSON object");
  return value as Record<string, unknown>;
}

// The login window's page: a static message, then it closes itself. The CSP
// allows only this script, by hash.
const CLOSE_SCRIPT = "setTimeout(()=>window.close(),1500)";
const CLOSE_SCRIPT_HASH = createHash("sha256").update(CLOSE_SCRIPT).digest("base64");
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function sendClosePage(response: ServerResponse, status: number, title: string, message: string) {
  const body = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><p>${escapeHtml(message)}</p><script>${CLOSE_SCRIPT}</script>`;
  response.writeHead(status, {
    ...SECURITY,
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Content-Security-Policy": `default-src 'none'; script-src 'sha256-${CLOSE_SCRIPT_HASH}'; frame-ancestors 'none'`,
  });
  response.end(body);
}
