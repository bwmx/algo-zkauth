// Own relay page under Node/VM; no browser or GitHub Pages request.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../web/oauth-relay/index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function relay(search, pathname = "/algo-zkauth/slack-callback/") {
  const result = { message: "" };
  vm.runInNewContext(script, {
    URLSearchParams,
    location: { search, pathname, replace(url) { result.target = url; } },
    history: { replaceState(_, __, url) { result.cleaned = url; } },
    document: { getElementById: () => ({ set textContent(v) { result.message = v; } }) },
  });
  return result;
}

test("relay script matches its CSP hash", () => {
  const digest = createHash("sha256").update(script).digest("base64");
  assert.ok(html.includes(`script-src 'sha256-${digest}'`));
  assert.ok(html.includes('<meta name="referrer" content="no-referrer">'));
});

test("relay forwards only code, state and error to the fixed local callback", () => {
  const sent = relay("?code=abc&state=xyz&next=https://evil.example&redirect=x");
  assert.equal(sent.target, "http://localhost:8765/demo/slack/callback?code=abc&state=xyz");
  assert.equal(sent.cleaned, "/algo-zkauth/slack-callback/");
  assert.equal(relay("?error=access_denied&state=xyz").target, "http://localhost:8765/demo/slack/callback?state=xyz&error=access_denied");
  const none = relay("?code=abc");
  assert.equal(none.target, undefined);
  assert.match(none.message, /No sign-in/);
});

test("relay takes the provider from its published path and nothing else", () => {
  assert.equal(relay("?code=abc&state=xyz", "/algo-zkauth/facebook-callback/").target, "http://localhost:8765/demo/facebook/callback?code=abc&state=xyz");
  for (const pathname of ["/algo-zkauth/", "/algo-zkauth/Slack-callback/", "/algo-zkauth/a.b-callback/", "/algo-zkauth/slack-callback/x"]) {
    const sent = relay("?code=abc&state=xyz", pathname);
    assert.equal(sent.target, undefined, pathname);
    assert.match(sent.message, /No sign-in/);
  }
});
