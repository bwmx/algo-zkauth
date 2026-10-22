import { afterEach, describe, expect, it, vi } from "vitest";
import { ZkAuthError, algo, createZkAuth, formatAlgo } from "../src/index.ts";
import type { LoginHandler, ZkAuthOptions } from "../src/index.ts";
import { fromBase64Url, signInBytes } from "@bwmx/algo-zkauth-protocol";
import { FAKE_PROOF, FakeApi, token } from "./fake-api.ts";

const asAlice: LoginHandler = async ({ nonce }) => token(nonce, "alice");
const asBob: LoginHandler = async ({ nonce }) => token(nonce, "bob");

function client(api: FakeApi, extra: Partial<ZkAuthOptions> = {}) {
  return createZkAuth({ service: "http://svc.test", app: "demo", fetch: api.fetch, pollMs: 1, login: asAlice, ...extra });
}

async function catchError(promise: Promise<unknown>): Promise<ZkAuthError> {
  try { await promise; } catch (e) { return e as ZkAuthError; }
  throw new Error("expected a rejection");
}

afterEach(() => { vi.useRealTimers(); });

describe("happy path", () => {
  it("signs in, backs up, enrolls, sends ALGO, opts in, sends an asset, and restores the same wallet elsewhere", async () => {
    const api = new FakeApi();
    const zk = client(api);
    const session = await zk.signIn();
    expect(session.identity).toEqual({ issuer: "https://accounts.google.com", audience: api.clientId, subject: "alice" });
    expect(zk.session).toBe(session);

    // No wallet before there is a salt.
    expect((await catchError(session.wallet())).code).toBe("salt_required");

    const backup = await session.backup.create();
    expect(backup.secret).toMatch(/^ZKR1:/);
    expect(backup.file).toBeInstanceOf(Blob);
    expect(session.backup.hasSalt).toBe(true);
    expect(session.backup.stage).toBe("pre-enrollment");

    const wallet = await session.wallet();
    expect(wallet.enrolled).toBe(false);
    expect(wallet.address).toBeNull();

    const enrolled = await wallet.enroll();
    expect(enrolled?.txId).toBeTruthy();
    expect(enrolled?.explorerUrl).toBe(`https://lora.algokit.io/testnet/transaction/${enrolled!.txId}`);
    expect(wallet.enrolled).toBe(true);
    expect(await wallet.enroll()).toBeNull();                       // idempotent
    expect(session.backup.needsExport).toBe(true);

    const proofRequests = () => api.requests.filter((r) => r.path.endsWith("/proofs") && r.method === "POST").length;
    expect(proofRequests()).toBe(1);                               // proof requested once, cached for the session

    const address = wallet.address!;
    api.fund(address, 5_000_000n);
    const to = api.sponsor;

    const sent = await wallet.sendAlgo({ to, amount: algo("1.5") });
    expect(sent.confirmedRound).toBeGreaterThan(1000n);
    expect(sent.groupId).toMatch(/^GROUP/);
    const balance = await wallet.balance();
    expect(balance.microAlgos).toBe(200_000n + 5_000_000n - 1_500_000n);
    expect(balance.spendable).toBe(balance.microAlgos - balance.minBalance);

    const optIn = await wallet.optIn(31566704);
    expect(optIn.txId).toBeTruthy();
    api.giveAsset(address, 31566704n, 50n);
    const asset = await wallet.sendAsset({ assetId: 31566704n, to, amount: 7n });
    expect(asset.txId).toBeTruthy();
    expect((await wallet.balance()).assets).toEqual([{ id: 31566704n, amount: 43n }]);
    expect(proofRequests()).toBe(1);

    // Everything that was submitted carries real digests signed by the session key.
    expect(api.submitted.map((s) => s.operation)).toEqual(["0", "1", "2", "3"]);

    const exported = await session.backup.export();
    expect(exported.secret).toBe(backup.secret);                   // the session reuses the secret it created
    expect(session.backup.stage).toBe("wallet");
    expect(session.backup.needsExport).toBe(false);

    // A fresh instance (another browser) restores the wallet from file + secret.
    for (const file of [exported.file, backup.file]) {
      const zk2 = client(api);
      const session2 = await zk2.signIn();
      const restored = await session2.backup.restore(file, { secret: backup.secret });
      expect(restored.enrolled).toBe(true);
      expect(restored.walletId).toBe(wallet.id);
      const wallet2 = await session2.wallet();
      expect(wallet2.address).toBe(address);
      expect((await wallet2.balance()).assets[0]?.amount).toBe(43n);
    }
  });

  it("sends the salt only to POST /salt", async () => {
    const api = new FakeApi();
    const session = await client(api).signIn();
    const { file, secret } = await session.backup.create();
    const wallet = await session.wallet();
    api.fund((await wallet.enroll(), wallet.address!), 1_000_000n);
    await wallet.sendAlgo({ to: api.sponsor, amount: 10_000n });
    const saltRequests = api.requests.filter((r) => /\/salt$/.test(r.path));
    const salt = saltRequests[0]!.body.salt as string;
    expect(salt).toHaveLength(43);
    for (const r of api.requests.filter((x) => !/\/salt$/.test(x.path))) expect(JSON.stringify(r.body ?? {})).not.toContain(salt);
    // Neither the secret nor the package is ever sent.
    expect(JSON.stringify(api.requests)).not.toContain(secret);
    expect(JSON.stringify(api.requests)).not.toContain(await file.text().then((t) => JSON.parse(t).header.packageId));
  });

  it("enrolls on the first action when the wallet is not yet enrolled", async () => {
    const api = new FakeApi();
    const session = await client(api).signIn();
    await session.backup.create();
    const wallet = await session.wallet();
    await wallet.sendAlgo({ to: api.sponsor, amount: 50_000n });
    expect(wallet.enrolled).toBe(true);
    expect(api.submitted.map((s) => s.operation)).toEqual(["0", "1"]);
  });

  it("serializes concurrent actions so nonces never collide", async () => {
    const api = new FakeApi();
    const session = await client(api).signIn();
    await session.backup.create();
    const wallet = await session.wallet();
    await wallet.enroll();
    api.fund(wallet.address!, 2_000_000n);
    await Promise.all([1n, 2n, 3n].map((n) => wallet.sendAlgo({ to: api.sponsor, amount: n * 1000n })));
    expect(api.submitted.map((s) => s.operation)).toEqual(["0", "1", "1", "1"]);
  });

  it("waitForFunds resolves when the balance arrives and times out otherwise", async () => {
    const api = new FakeApi();
    const session = await client(api).signIn();
    await session.backup.create();
    const wallet = await session.wallet();
    expect((await catchError(wallet.waitForFunds({ microAlgos: 1n }))).code).toBe("not_enrolled");
    await wallet.enroll();
    setTimeout(() => api.fund(wallet.address!, 1_000_000n), 20);
    await wallet.waitForFunds({ microAlgos: 1_000_000n, timeoutMs: 2000 });
    expect((await catchError(wallet.waitForFunds({ microAlgos: 99_000_000n, timeoutMs: 30 }))).code).toBe("timeout");
  });

  it("reads history from the configured indexer", async () => {
    const api = new FakeApi();
    const session = await client(api).signIn();
    await session.backup.create();
    const wallet = await session.wallet();
    await wallet.enroll();
    api.indexerTxns = [{ id: "T1", "tx-type": "pay", sender: api.sponsor, "confirmed-round": 12, "round-time": 99, "payment-transaction": { amount: 42, receiver: wallet.address } }];
    const history = await wallet.history();
    expect(history).toEqual([{ txId: "T1", round: 12n, time: 99, type: "received", amount: 42n, assetId: 0n, counterparty: api.sponsor }]);
  });
});

describe("validation before signing", () => {
  async function enrolled(api: FakeApi) {
    const session = await client(api).signIn();
    await session.backup.create();
    const wallet = await session.wallet();
    await wallet.enroll();
    api.fund(wallet.address!, 5_000_000n);
    return { session, wallet };
  }

  it.each([
    ["amount", (p: any) => ({ ...p, amount: "999999" })],
    ["recipient", (p: any) => ({ ...p, recipient: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ" })],
    ["recipient bytes", (p: any) => ({ ...p, recipientPublicKey: "A".repeat(43) })],
    ["asset", (p: any) => ({ ...p, assetId: "7" })],
    ["owner", (p: any) => ({ ...p, owner: "B".repeat(43) })],
    ["network", (p: any) => ({ ...p, genesisHash: "C".repeat(43) })],
    ["registry", (p: any) => ({ ...p, registryId: "1" })],
    ["nonce", (p: any) => ({ ...p, nonce: "77" })],
    ["operation", (p: any) => ({ ...p, operation: "3" })],
    ["session expiry", (p: any) => ({ ...p, sessionExpiresAt: "1" })],
  ])("a plan with a changed %s is refused and nothing is submitted", async (_name, tamper) => {
    const api = new FakeApi();
    const { wallet } = await enrolled(api);
    const submittedBefore = api.submitted.length;
    api.tamper = tamper;
    const error = await catchError(wallet.sendAlgo({ to: api.sponsor, amount: 1000n }));
    expect(error).toBeInstanceOf(ZkAuthError);
    expect(error.code).toBe("plan_mismatch");
    expect(api.submitted.length).toBe(submittedBefore);
    // No signature left the page for the tampered plan.
    const submits = api.requests.filter((r) => /\/submit$/.test(r.path));
    expect(submits).toHaveLength(1);                                // only the enrollment
  });

  it("approve() can stop an action before the key signs", async () => {
    const api = new FakeApi();
    const seen: unknown[] = [];
    const session = await client(api, { approve: async (plan) => { seen.push(plan); return plan.kind !== "sendAlgo"; } }).signIn();
    await session.backup.create();
    const wallet = await session.wallet();
    await wallet.enroll();
    api.fund(wallet.address!, 1_000_000n);
    const plans: string[] = [];
    wallet.on("plan", (p) => plans.push(p.kind));
    expect((await catchError(wallet.sendAlgo({ to: api.sponsor, amount: 1000n }))).code).toBe("user_rejected");
    expect(plans).toEqual(["sendAlgo"]);
    expect(api.submitted.map((s) => s.operation)).toEqual(["0"]);
  });

  it("rejects bad input locally", async () => {
    const api = new FakeApi();
    const { wallet } = await enrolled(api);
    expect((await catchError(wallet.sendAlgo({ to: "not-an-address", amount: 1n }))).code).toBe("bad_request");
    expect((await catchError(wallet.sendAlgo({ to: api.sponsor, amount: 0n }))).code).toBe("bad_request");
    expect((await catchError(wallet.sendAlgo({ to: api.sponsor, amount: 900_000_000n }))).code).toBe("insufficient_funds");
    expect(() => algo("1.0000001")).toThrow(ZkAuthError);
    expect(algo("0.1").microAlgo).toBe(100_000n);
    expect(formatAlgo(algo(1.5), { trim: true })).toBe("1.50 ALGO");
  });
});

describe("errors", () => {
  it("maps service errors, including retryAfter", async () => {
    const api = new FakeApi();
    const session = await client(api).signIn();
    await session.backup.create();
    const wallet = await session.wallet();
    api.fail(/POST \/v1\/actions$/, "key_pending_delay", { status: 409, retryAfter: 3600 });
    const error = await catchError(wallet.enroll());
    expect(error.code).toBe("key_pending_delay");
    expect(error.retryAfter).toBe(3600);
    expect(error.retryable).toBe(true);
    // The failure does not poison the queue or the cached proof.
    expect((await wallet.enroll())?.txId).toBeTruthy();
  });

  it("maps HTTP status, Retry-After and transport failures", async () => {
    const responses: Response[] = [
      new Response("busy", { status: 429, headers: { "Retry-After": "7" } }),
      new Response(JSON.stringify({ error: { code: "something_new", message: "x" } }), { status: 500 }),
    ];
    const zk = createZkAuth({ service: "http://svc.test", app: "demo", fetch: (async () => responses.shift() ?? Promise.reject(new TypeError("offline"))) as typeof fetch });
    const limited = await catchError(zk.config());
    expect([limited.code, limited.retryAfter]).toEqual(["rate_limited", 7]);
    expect((await catchError(zk.config())).code).toBe("service_unavailable");
    expect((await catchError(zk.config())).code).toBe("service_unavailable");
  });

  it("refuses the wrong network", async () => {
    const api = new FakeApi();
    expect((await catchError(client(api, { network: "mainnet" }).config())).code).toBe("network_mismatch");
  });

  it("rejects a token for another nonce and an unknown provider", async () => {
    const api = new FakeApi();
    expect((await catchError(client(api, { login: async () => token("wrong-nonce") }).signIn())).code).toBe("token_invalid");
    expect((await catchError(client(api).signIn("slack"))).code).toBe("provider_unsupported");
  });

  it("detects a service that does not bind this page's session key", async () => {
    const api = new FakeApi();
    const real = api.fetch;
    const lying = (async (input: any, init: any) => {
      const response = await real(input, init);
      if (new URL(String(input)).pathname !== "/v1/sessions" || init?.method !== "POST") return response;
      const body = await response.json();
      return new Response(JSON.stringify({ ...body, nonce: "x".repeat(43) }), { status: 201 });
    }) as typeof fetch;
    expect((await catchError(client(api, { fetch: lying }).signIn())).code).toBe("nonce_mismatch");
  });
});

describe("backup", () => {
  it("fails restores with the wrong secret, the wrong account, or garbage", async () => {
    const api = new FakeApi();
    const session = await client(api).signIn();
    const { file, secret } = await session.backup.create();
    const other = await client(api).signIn();
    expect((await catchError(other.backup.restore(file, { secret: "ZKR1:" + "A".repeat(43) + ":AAAAAA" }))).code).toBe("backup_invalid");
    expect((await catchError(other.backup.restore("not a package", { secret }))).code).toBe("backup_invalid");
    expect(other.backup.hasSalt).toBe(false);
    const bob = await client(api, { login: asBob }).signIn();
    expect((await catchError(bob.backup.restore(file, { secret }))).code).toBe("wrong_account");
    expect(bob.backup.hasSalt).toBe(false);
  });

  it("keeps the salt when create() is called again", async () => {
    const api = new FakeApi();
    const session = await client(api).signIn();
    const first = await session.backup.create();
    const second = await session.backup.create();
    expect(second.secret).not.toBe(first.secret);
    // Both files open the same wallet.
    const again = await client(api).signIn();
    await again.backup.restore(first.file, { secret: first.secret });
    const salts = api.requests.filter((r) => /\/salt$/.test(r.path)).map((r) => r.body.salt);
    expect(new Set(salts).size).toBe(1);
    expect(second.fileName).toMatch(/^algo-zkauth-.*\.json$/);
  });

  it("export needs an enrolled wallet", async () => {
    const api = new FakeApi();
    const session = await client(api).signIn();
    await session.backup.create();
    expect((await catchError(session.backup.export())).code).toBe("not_enrolled");
  });

  it("reports an unavailable passkey as a typed error and leaves the session unchanged", async () => {
    const api = new FakeApi();
    const session = await client(api).signIn();
    expect((await catchError(session.backup.create({ passkey: true }))).code).toBe("passkey_unavailable");
    expect(session.backup.hasSalt).toBe(false);
  });
});

describe("login flows", () => {
  it("code flow: opens the provider window through the handler, then polls the session", async () => {
    const api = new FakeApi({ loginFlow: "code" });
    const seen: string[] = [];
    const zk = client(api, {
      login: async (ctx) => {
        seen.push(ctx.authorizeUrl!);
        setTimeout(() => void api.completeCodeLogin(api.lastSessionId), 10);
        return { closed: false };
      },
    });
    const session = await zk.signIn();
    expect(seen[0]).toContain("provider.example/authorize");
    expect(session.identity.subject).toBe("alice");
    expect(api.requests.some((r) => r.method === "GET" && /\/v1\/sessions\/[^/]+$/.test(r.path))).toBe(true);
  });

  it("code flow: a closed window is a typed cancellation", async () => {
    const api = new FakeApi({ loginFlow: "code" });
    const zk = client(api, { login: async () => ({ closed: true }) });
    expect((await catchError(zk.signIn())).code).toBe("login_cancelled");
    expect(api.sessions.size).toBe(0);                              // the half-open session is deleted
  });

  it("an aborted sign-in is cancelled", async () => {
    const api = new FakeApi();
    const abort = new AbortController();
    const zk = client(api, { login: ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new ZkAuthError("login_cancelled", "x")))) });
    const promise = zk.signIn(undefined, { signal: abort.signal });
    setTimeout(() => abort.abort(), 10);
    expect((await catchError(promise)).code).toBe("login_cancelled");
  });

  it("signOut closes the session and wipes its state", async () => {
    const api = new FakeApi();
    const zk = client(api);
    const events: unknown[] = [];
    zk.on("session", (s) => events.push(s));
    const session = await zk.signIn();
    await session.backup.create();
    await zk.signOut();
    expect(zk.session).toBeNull();
    expect(events).toHaveLength(2);
    expect(api.sessions.size).toBe(0);
    expect(session.backup.hasSalt).toBe(false);
    expect((await catchError(session.wallet())).code).toBe("not_signed_in");
  });
});

describe("session lifetime", () => {
  it("emits expiring and expired, blocks actions after expiry, and renew() keeps the wallet", async () => {
    vi.useFakeTimers({ now: new Date("2030-01-01T00:00:00Z"), shouldAdvanceTime: true });
    const api = new FakeApi();
    const zk = client(api, { expiringSeconds: 90 });
    const session = await zk.signIn();
    await session.backup.create();
    const wallet = await session.wallet();
    await wallet.enroll();

    const expiring: number[] = [];
    const expired = vi.fn();
    session.on("expiring", (s) => expiring.push(s));
    session.on("expired", expired);

    await vi.advanceTimersByTimeAsync((600 - 90) * 1000 + 5);
    expect(expiring).toEqual([90]);
    expect(expired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(90 * 1000);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(session.expired).toBe(true);
    expect((await catchError(wallet.sendAlgo({ to: api.sponsor, amount: 1n }))).code).toBe("session_expired");

    const oldExpiry = session.expiresAt;
    const renewed = await session.renew();
    expect(renewed).toBe(session);
    expect(session.expired).toBe(false);
    expect(session.expiresAt).toBeGreaterThanOrEqual(oldExpiry + 600);
    expect(wallet.enrolled).toBe(true);
    api.fund(wallet.address!, 1_000_000n);
    await wallet.sendAlgo({ to: api.sponsor, amount: 1000n });     // new session key + new proof
    expect(api.requests.filter((r) => /\/proofs$/.test(r.path) && r.method === "POST")).toHaveLength(2);
  });

  it("renew() refuses a different account", async () => {
    const api = new FakeApi();
    let who: LoginHandler = asAlice;
    const session = await client(api, { login: (c) => who(c) }).signIn();
    who = asBob;
    expect((await catchError(session.renew())).code).toBe("wrong_account");
    expect(session.identity.subject).toBe("alice");
  });
});

describe("browser proving", () => {
  it("fetches the circuit input, proves in the injected runner and uploads the proof", async () => {
    const api = new FakeApi();
    const run = vi.fn(async (input: Record<string, unknown>, progress: (m: string) => void) => {
      progress("proving");
      expect(input).toEqual({ fake: "circuit input" });
      return { proof: { pi_a: [], pi_b: [], pi_c: [], protocol: "groth16", curve: "bn128" } as never, publicSignals: await api.expectedSignals(api.lastSessionId) };
    });
    const session = await client(api, { proving: "browser", browserProver: { wasmUrl: "/a.wasm", zkeyUrl: "/a.zkey", snarkjsUrl: "/snarkjs.js", run } }).signIn();
    await session.backup.create();
    const wallet = await session.wallet();
    const progress: (string | null)[] = [];
    wallet.on("change", () => progress.push(wallet.progress));
    await wallet.enroll();
    expect(run).toHaveBeenCalledTimes(1);
    expect(progress).toContain("proving");
    const paths = api.requests.map((r) => `${r.method} ${r.path.replace(/sess-[^/]+/, ":id")}`);
    expect(paths).toContain("POST /v1/sessions/:id/circuit-input");
    expect(paths).toContain("PUT /v1/sessions/:id/proof");
    expect(paths).not.toContain("POST /v1/sessions/:id/proofs");
    expect(wallet.enrolled).toBe(true);
  });

  it("refuses a proof whose public signals do not bind this session", async () => {
    const api = new FakeApi();
    const run = async () => ({ proof: {} as never, publicSignals: Array(12).fill("1") });
    const session = await client(api, { proving: "browser", browserProver: { wasmUrl: "a", zkeyUrl: "b", snarkjsUrl: "c", run } }).signIn();
    await session.backup.create();
    const wallet = await session.wallet();
    expect((await catchError(wallet.enroll())).code).toBe("proof_failed");
    expect(api.requests.some((r) => r.method === "PUT")).toBe(false);
  });

  it("requires browserProver options", () => {
    expect(() => createZkAuth({ service: "http://x", app: "demo", proving: "browser" })).toThrow(ZkAuthError);
  });

  it("service proof signals that do not match are refused", async () => {
    const api = new FakeApi();
    const real = api.fetch;
    const bad = (async (input: any, init: any) => {
      const response = await real(input, init);
      if (!/\/proofs\/job-1$/.test(new URL(String(input)).pathname)) return response;
      const body = await response.json();
      if (body.stage !== "ready") return new Response(JSON.stringify(body), { status: 200 });
      return new Response(JSON.stringify({ ...body, publicSignals: body.publicSignals.map((_: string, i: number) => (i === 6 ? "5" : body.publicSignals[i])) }), { status: 200 });
    }) as typeof fetch;
    const session = await client(api, { fetch: bad }).signIn();
    await session.backup.create();
    expect((await catchError((await session.wallet()).enroll())).code).toBe("proof_failed");
  });
});

describe("sign-in for a backend", () => {
  const ORIGIN = "https://dapp.example";

  it("signs the backend's challenge with the session key and carries the session's proof", async () => {
    const api = new FakeApi();
    const session = await client(api).signIn();
    expect((await catchError(session.createSignIn({ nonce: "abcdefgh12345678", origin: ORIGIN }))).code).toBe("salt_required");
    await session.backup.create();

    const before = await session.createSignIn({ nonce: "abcdefgh12345678", origin: ORIGIN, statement: "Sign in to Example" });
    expect(before.fields).toMatchObject({
      version: 1, origin: ORIGIN, address: null, statement: "Sign in to Example", network: "testnet",
      genesisHash: api.genesisHash, app: "1001", provider: "google", nonce: "abcdefgh12345678",
    });
    expect(before.fields.expiresAt - before.fields.issuedAt).toBeLessThanOrEqual(300);
    expect(before.fields.expiresAt).toBeLessThanOrEqual(session.expiresAt);
    expect(before.proof.proof).toEqual(FAKE_PROOF);
    // The key that signed is the one the proof's public signals name (signals 6 and 7).
    const [hi, lo] = before.proof.publicSignals.slice(6, 8).map(BigInt);
    const raw = Uint8Array.from(Buffer.from(((hi! << 128n) | lo!).toString(16).padStart(64, "0"), "hex"));
    const key = await crypto.subtle.importKey("raw", raw, "Ed25519", false, ["verify"]);
    expect(await crypto.subtle.verify("Ed25519", key, fromBase64Url(before.signature, 64), signInBytes(before.fields))).toBe(true);

    // After enrollment the message names the wallet; the proof is not requested again.
    const wallet = await session.wallet();
    await wallet.enroll();
    const after = await session.createSignIn({ nonce: "abcdefgh12345679", origin: ORIGIN, expiresIn: 9999 });
    expect(after.fields.address).toBe(wallet.address);
    expect(after.fields.statement).toBeNull();
    expect(after.fields.expiresAt - after.fields.issuedAt).toBeLessThanOrEqual(600);
    expect(api.requests.filter((r) => r.path.endsWith("/proofs") && r.method === "POST")).toHaveLength(1);
  });

  it("refuses a bad nonce, statement or origin before signing", async () => {
    const api = new FakeApi();
    const session = await client(api).signIn();
    await session.backup.create();
    expect((await catchError(session.createSignIn({ nonce: "short", origin: ORIGIN }))).code).toBe("bad_request");
    expect((await catchError(session.createSignIn({ nonce: "abcdefgh12345678", origin: ORIGIN, statement: "a\nNonce: x" }))).code).toBe("bad_request");
    expect((await catchError(session.createSignIn({ nonce: "abcdefgh12345678", origin: `${ORIGIN}/path` }))).code).toBe("bad_request");
    expect((await catchError(session.createSignIn({ nonce: "abcdefgh12345678" }))).code).toBe("bad_request"); // no page origin in Node
  });
});
