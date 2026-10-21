// Own frontend code under Node/VM with DOM and Google API stubs. This does not
// launch/control a browser or count as real Google/passkey compatibility evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import * as recovery from "../src/phase5/recovery.mjs";
import * as passkeys from "../src/phase5/passkey-prf.mjs";
const source = readFileSync(new URL("../web/phase5-recovery/client.mjs", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
async function page(subject = "123456789012345678901") {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: "", textContent: "", className: "", hidden: false, disabled: false, checked: false, files: [] });
    return elements.get(id);
  };
  let callback, downloaded;
  const requests = [];
  const blobMap = new Map();
  class TestURL extends URL {
    static createObjectURL(blob) { const id = `blob:test-${blobMap.size}`; blobMap.set(id, blob); return id; }
    static revokeObjectURL() {}
  }
  const context = vm.createContext({
    ...recovery, ...passkeys, Uint8Array, TextEncoder, TextDecoder, Blob, URL: TestURL, crypto, setTimeout: () => 0,
    addEventListener: () => {}, navigator: { userAgent: "Node VM protocol test" }, location: { origin: "http://localhost:8765", hostname: "localhost" },
    document: {
      getElementById: element,
      head: { append(script) { queueMicrotask(() => script.onload()); } },
      createElement(tag) { return tag === "a" ? { click() { downloaded = blobMap.get(this.href); } } : {}; },
    },
    google: { accounts: { id: { initialize(options) { callback = options.callback; }, renderButton() {} } } },
    fetch: async (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : undefined;
      requests.push({ url, body });
      const result = url.endsWith("/config") ? { clientId: "test.apps.googleusercontent.com", genesisHash: recovery.toBase64Url(new Uint8Array(32).fill(2)), challengeId: "test", nonce: "test" } : url.endsWith("/identity") ? { identity: { issuer: "https://accounts.google.com", audience: "test.apps.googleusercontent.com", subject } } : { recorded: true };
      return { ok: true, json: async () => result };
    },
  });
  await vm.runInContext(`(async () => {${source}\n})()`, context);
  assert.equal(typeof callback, "function", element("status").textContent);
  return { element, requests, login: () => callback({ credential: "test-token" }), click: id => element(id).onclick(), import: async (text, size = new TextEncoder().encode(text).length) => {
    element("import").files = [{ size, text: async () => text }]; await element("import").onchange();
  }, downloaded: async () => downloaded.text() };
}
test("backup completion requires downloaded-file restoration plus separate secret confirmation", async () => {
  const p = await page(); await p.login(); await p.click("create");
  const secret = p.element("new-secret").value;
  await p.click("download"); const text = await p.downloaded(); await p.import(text);
  p.element("restore-secret").value = "wrong"; await p.click("restore-secret-button");
  assert.equal(p.requests.some(r => r.body?.outcome === "setup-verified"), false);
  p.element("restore-secret").value = secret; await p.click("restore-secret-button");
  assert.equal(p.requests.some(r => r.body?.outcome === "setup-verified"), false);
  p.element("secret-saved").checked = true; p.element("restore-secret").value = secret;
  await p.click("restore-secret-button");
  assert.equal(p.requests.some(r => r.body?.outcome === "setup-verified"), true);
  assert.match(p.element("setup-state").textContent, /Setup verified/);
  const telemetry = JSON.stringify(p.requests.filter(r => r.url.endsWith("/result")));
  assert.equal(telemetry.includes(secret), false); assert.equal(telemetry.includes("123456789012345678901"), false);
});
test("a separate page with empty state restores the exported identity, while another account cannot", async () => {
  const first = await page(); await first.login(); await first.click("create"); await first.click("download");
  const text = await first.downloaded(); const secret = first.element("new-secret").value;
  const fresh = await page(); await fresh.login(); await fresh.import(text);
  fresh.element("restore-secret").value = secret; await fresh.click("restore-secret-button");
  assert.equal(fresh.element("restored-commitment").textContent, first.element("original-commitment").textContent);
  assert.equal(fresh.element("restore-secret").value, "");
  assert.equal(fresh.requests.some(r => r.body?.outcome === "setup-verified"), false);
  const other = await page("other-account"); await other.login(); await other.import(text);
  other.element("restore-secret").value = secret; await other.click("restore-secret-button");
  assert.match(other.element("status").textContent, /original Google identity/);
  assert.equal(other.requests.some(r => r.body?.outcome === "restore-secret"), false);
});
test("wallet packages and excessive imports cannot silently become a new test identity", async () => {
  const p = await page(); await p.login(); await p.click("create"); await p.click("download");
  const text = await p.downloaded();
  await p.import(text, recovery.MAX_PACKAGE_BYTES + 1);
  assert.equal(p.element("restore-secret-button").disabled, true);
  const value = recovery.parsePackage(text);
  value.header.binding = { ...value.header.binding, stage: "wallet", registryAppId: "1", walletAppId: "2", walletAddress: "A".repeat(58) };
  await p.import(recovery.serializePackage(value));
  assert.match(p.element("status").textContent, /chain-verified wallet discovery/);
  assert.equal(p.element("restore-secret-button").disabled, true);
});
