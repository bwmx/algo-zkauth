import test from "node:test";
import assert from "node:assert/strict";
import { SIGN_IN_DOMAIN, signInBytes, signInMessage, validateSignInFields } from "../../packages/protocol/src/sign-in.mjs";

const fields = {
  version: 1, origin: "https://dapp.example", address: "A".repeat(58), statement: "Sign in to Example.",
  network: "testnet", genesisHash: "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9_cOUJOiI", app: "1012", provider: "google",
  nonce: "n0nce1234abcd", issuedAt: 1_800_000_000, expiresAt: 1_800_000_300,
};

test("the message is fixed text rebuilt from the fields", () => {
  assert.equal(signInMessage(fields), [
    "https://dapp.example asks you to sign in with your AlgoZKAuth wallet:",
    "A".repeat(58),
    "",
    "Sign in to Example.",
    "",
    "Version: 1",
    "Network: testnet",
    "Genesis Hash: SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9_cOUJOiI",
    "App: 1012",
    "Provider: google",
    "Nonce: n0nce1234abcd",
    "Issued At: 2027-01-15T08:00:00.000Z",
    "Expires At: 2027-01-15T08:05:00.000Z",
  ].join("\n"));
  const unenrolled = signInMessage({ ...fields, address: null, statement: null }).split("\n");
  assert.equal(unenrolled[1], "(a new wallet, not created yet)");
  assert.equal(unenrolled[3], "Version: 1");
});

test("the signed bytes carry the sign-in domain and can never be a 32-byte action digest", () => {
  const bytes = signInBytes(fields);
  const domain = new TextEncoder().encode(SIGN_IN_DOMAIN);
  assert.deepEqual(bytes.subarray(0, domain.length), domain);
  assert.equal(new TextDecoder().decode(bytes.subarray(domain.length)), signInMessage(fields));
  assert.ok(signInBytes({ ...fields, address: null, statement: null }).length > 32);
});

test("validation returns only the known fields and rejects anything that could change the text", () => {
  assert.deepEqual(Object.keys(validateSignInFields({ ...fields, extra: "x" })), Object.keys(fields));
  const bad = {
    version: [2, "1"],
    origin: ["https://dapp.example/", "https://dapp.example/path", "ftp://dapp.example", "null", "javascript:alert(1)", "https://dapp.example\nNonce: x"],
    address: ["a".repeat(58), "A".repeat(57), ""],
    statement: ["", "two\nlines", "tab\there", "x".repeat(281), "line\u2028separator"],
    network: ["TestNet", ""],
    genesisHash: ["short", `${"A".repeat(42)}=`],
    app: ["01", "-1", "18446744073709551616", 1012],
    provider: ["Google", ""],
    nonce: ["short", "has space here", "x".repeat(129)],
    issuedAt: [0, 1.5, "1800000000"],
    expiresAt: [1_800_000_000, 1_800_000_000 + 601],
  };
  for (const [field, values] of Object.entries(bad))
    for (const value of values)
      assert.throws(() => validateSignInFields({ ...fields, [field]: value }), new RegExp(`Invalid sign-in ${field}`), `${field}=${JSON.stringify(value)}`);
});
