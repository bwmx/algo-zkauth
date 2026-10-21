// @algozkauth/verify: check an AlgoZKAuth sign-in on a dApp's backend without
// trusting the AlgoZKAuth service. Everything is checked against the app
// settings the backend pins and the chain, read from an algod node of the
// backend's choosing:
//
//   1. the message names the backend's origin and nonce, and this app and network;
//   2. the session key in the proof's public signals signed exactly that message;
//   3. the Groth16 proof is valid under the pinned verification key (so the login
//      token was signed by the provider's key and bound to this session key,
//      audience and network, without revealing the token or the user's identity);
//   4. the provider key is approved and active in the on-chain KeyRegistry;
//   5. the on-chain WalletRegistry maps the proof's owner commitment to the wallet.
//
// What remains trusted: the login provider, the circuit and its trusted setup,
// and the algod node (as for any chain read).
import { createHash, createPublicKey, verify as verifySignature, webcrypto } from "node:crypto";
import { SESSION_SECONDS, fromBase64Url, signInBytes, validateSignInFields, type SignIn, type SignInFields } from "@algozkauth/protocol";
import { groth16Verify, prepareVerificationKey, type Groth16VerificationKey } from "./groth16.ts";

export { groth16Verify, prepareVerificationKey } from "./groth16.ts";
export type { Groth16Proof, Groth16VerificationKey } from "./groth16.ts";
export type { SignIn, SignInFields } from "@algozkauth/protocol";

/**
 * One app's deployment, as `GET /v1/apps/:app/config` reports it. Pin these values in
 * the backend's configuration; fetchAppSettings() is only a way to read them once.
 */
export type AppSettings = {
  app: string;
  network: string;
  genesisHash: string;
  provider: string;
  registryId: string;
  keyRegistryId: string;
  audienceHash: string;
  verifier: string;
  verificationKeySha256: string;
};

export type VerifierOptions = {
  /** An algod node on the apps' network. */
  algodUrl: string;
  algodToken?: string;
  /** The apps whose sign-ins this backend accepts (its own; or the hosted wallet's). */
  apps: AppSettings | AppSettings[];
  /** Each provider's verification_key.json, as file contents; checked against verificationKeySha256. */
  verificationKeys: Record<string, string | Uint8Array>;
  /**
   * How far a sign-in's issuedAt may be ahead of the chain's clock (default 30 s). A dev-mode
   * LocalNet makes blocks only for transactions, so its clock stands still between them while the
   * SDK's advances: allow the session length (600) there. The nonce and the proof's session
   * expiry, not issuedAt, are what bound a sign-in.
   */
  clockToleranceSeconds?: number;
  /** How old a sign-in may be when it arrives (default 300 s). */
  maxAgeSeconds?: number;
  fetch?: typeof fetch;
};

export type VerifiedSignIn = {
  /** The app's id in the AlgoZKAuth service (AppSettings.app). */
  app: string;
  /** The wallet address, or null if the wallet has not been created on chain yet. */
  address: string | null;
  walletId: bigint | null;
  /**
   * The wallet owner's identity commitment (base64url): stable for this user and app
   * across sessions and devices that use the same backup, and reveals nothing else.
   */
  subject: string;
  provider: string;
  network: string;
  origin: string;
  statement: string | null;
  nonce: string;
  issuedAt: number;
  /** Treat the sign-in as proven until here (the session's expiry, at most 10 minutes); issue your own session. */
  expiresAt: number;
};

export type SignInErrorCode =
  | "malformed" | "unknown_app" | "wrong_origin" | "wrong_nonce" | "wrong_network" | "wrong_audience"
  | "bad_signature" | "invalid_proof" | "expired" | "not_yet_valid" | "key_inactive" | "registry_paused"
  | "wallet_mismatch" | "node_unavailable";

// Plain fields (no parameter properties), so Node runs this file with type stripping alone.
export class SignInError extends Error {
  readonly name = "SignInError";
  readonly code: SignInErrorCode;
  constructor(code: SignInErrorCode, message: string) { super(message); this.code = code; }
}

export type Verifier = {
  /** Resolves with who signed in, or rejects with a SignInError. Each nonce must be issued by you and used once. */
  verify(signIn: unknown, expected: { origin: string | readonly string[]; nonce: string }): Promise<VerifiedSignIn>;
  /** The chain's clock (latest block timestamp), which every time check uses. */
  now(): Promise<number>;
};

const fail = (code: SignInErrorCode, message: string): never => { throw new SignInError(code, message); };
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

/** 32 random letters and digits: a sign-in nonce. Store it, and accept it once. */
export function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const out: string[] = [];
  while (out.length < 32) for (const b of webcrypto.getRandomValues(new Uint8Array(64))) if (b < 248 && out.length < 32) out.push(alphabet[b % 62]!);
  return out.join("");
}

/**
 * Reads an app's settings from an AlgoZKAuth service. This trusts the service once:
 * check the values (or read them from your deployment records) and pin them.
 */
export async function fetchAppSettings(serviceUrl: string, app: string, o: { fetch?: typeof fetch; origin?: string } = {}): Promise<AppSettings> {
  const response = await (o.fetch ?? fetch)(`${serviceUrl.replace(/\/+$/, "")}/v1/apps/${encodeURIComponent(app)}/config`, o.origin ? { headers: { Origin: o.origin } } : {});
  if (!response.ok) throw new Error(`The service did not return app ${app} (HTTP ${response.status})`);
  const c = await response.json() as Record<string, unknown>;
  const keys = ["network", "genesisHash", "provider", "registryId", "keyRegistryId", "audienceHash", "verifier", "verificationKeySha256"] as const;
  for (const k of keys) if (typeof c[k] !== "string") throw new Error(`App ${app} settings lack ${k}`);
  return { app, ...Object.fromEntries(keys.map((k) => [k, c[k] as string])) } as AppSettings;
}

// ---- Algorand encoding -----------------------------------------------------------------------

const sha512_256 = (data: Uint8Array) => createHash("sha512-256").update(data).digest();
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function encodeAddress(publicKey: Uint8Array): string {
  const bytes = Buffer.concat([publicKey, sha512_256(publicKey).subarray(-4)]);
  let bits = 0, value = 0, out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(n); return b; };
const applicationAddress = (id: bigint) => encodeAddress(sha512_256(Buffer.concat([Buffer.from("appID"), u64(id)])));

/** Two 128-bit public-signal limbs (high, low) as 32 bytes. */
function limbs(signals: bigint[], offset: number): Buffer {
  const hi = signals[offset]!, lo = signals[offset + 1]!;
  if (hi >> 128n || lo >> 128n) fail("invalid_proof", "Public signal limb out of range");
  return Buffer.from(((hi << 128n) | lo).toString(16).padStart(64, "0"), "hex");
}

// ---- algod reads -----------------------------------------------------------------------------

type GlobalValue = { type: number; bytes?: string; uint?: number };

function algod(o: VerifierOptions) {
  const base = o.algodUrl.replace(/\/+$/, "");
  const doFetch = o.fetch ?? fetch;
  const get = async (path: string): Promise<any> => {
    let response: Response;
    try { response = await doFetch(`${base}${path}`, { headers: o.algodToken ? { "X-Algo-API-Token": o.algodToken } : {} }); }
    catch { return fail("node_unavailable", "The Algorand node is unreachable"); }
    if (response.status === 404) return undefined;
    if (!response.ok) return fail("node_unavailable", `The Algorand node answered HTTP ${response.status}`);
    return response.json();
  };
  return {
    async genesisHash(): Promise<string> {
      const params = await get("/v2/transactions/params");
      return typeof params?.["genesis-hash"] === "string" ? Buffer.from(params["genesis-hash"], "base64").toString("base64url") : fail("node_unavailable", "The node did not report its genesis hash");
    },
    // The latest block's timestamp, the clock the contracts check sessions against.
    async time(): Promise<number> {
      const status = await get("/v2/status");
      const block = await get(`/v2/blocks/${Number(status?.["last-round"])}?format=json&header-only=true`);
      const ts = block?.block?.ts;
      return typeof ts === "number" ? ts : fail("node_unavailable", "The node did not report the latest block time");
    },
    async box(app: bigint, name: Uint8Array): Promise<Buffer | undefined> {
      const box = await get(`/v2/applications/${app}/box?name=${encodeURIComponent(`b64:${Buffer.from(name).toString("base64")}`)}`);
      return box ? Buffer.from(box.value, "base64") : undefined;
    },
    async globals(app: bigint): Promise<Map<string, GlobalValue> | undefined> {
      const info = await get(`/v2/applications/${app}`);
      if (!info) return undefined;
      const entries = (info.params?.["global-state"] ?? []) as { key: string; value: GlobalValue }[];
      return new Map(entries.map((e) => [Buffer.from(e.key, "base64").toString("utf8"), e.value]));
    },
  };
}
const uintOf = (g: Map<string, GlobalValue>, key: string) => { const v = g.get(key); return v?.type === 2 ? BigInt(v.uint ?? 0) : undefined; };
const bytesOf = (g: Map<string, GlobalValue>, key: string) => { const v = g.get(key); return v?.type === 1 ? Buffer.from(v.bytes ?? "", "base64") : undefined; };

// ---- The verifier ----------------------------------------------------------------------------

export function createVerifier(options: VerifierOptions): Verifier {
  const apps = new Map((Array.isArray(options.apps) ? options.apps : [options.apps]).map((a) => [a.registryId, a]));
  if (!apps.size) throw new Error("Pass at least one app's settings");
  const keys = new Map<string, ReturnType<typeof prepareVerificationKey>>();
  for (const app of apps.values()) {
    if (keys.has(app.verificationKeySha256)) continue;
    const file = options.verificationKeys[app.provider];
    if (file === undefined) throw new Error(`No verification key for provider ${app.provider}`);
    const bytes = typeof file === "string" ? Buffer.from(file, "utf8") : Buffer.from(file);
    if (createHash("sha256").update(bytes).digest("hex") !== app.verificationKeySha256)
      throw new Error(`The ${app.provider} verification key does not match app ${app.app}'s deployment`);
    keys.set(app.verificationKeySha256, prepareVerificationKey(JSON.parse(bytes.toString("utf8")) as Groth16VerificationKey));
  }
  const node = algod(options);
  const tolerance = options.clockToleranceSeconds ?? 30;
  const maxAge = options.maxAgeSeconds ?? 300;
  let network: Promise<string> | undefined;
  const nodeGenesis = () => (network ??= node.genesisHash().catch((e) => { network = undefined; throw e; }));

  async function verify(input: unknown, expected: { origin: string | readonly string[]; nonce: string }): Promise<VerifiedSignIn> {
    // ---- 1. shape and the message's claims
    const s = input as Partial<SignIn> | null;
    let fields: SignInFields;
    try { fields = validateSignInFields(s?.fields); } catch (e) { return fail("malformed", (e as Error).message); }
    let signature: Uint8Array;
    try { signature = fromBase64Url(s!.signature as string, 64, 64); } catch { return fail("malformed", "The signature must be 64 bytes in base64url"); }
    const publicSignals = s!.proof?.publicSignals;
    if (!Array.isArray(publicSignals) || publicSignals.length !== 12 || !publicSignals.every((v) => typeof v === "string" && /^(0|[1-9][0-9]{0,77})$/.test(v)))
      return fail("malformed", "The proof must have 12 decimal public signals");
    const signals = publicSignals.map(BigInt);

    const origins = typeof expected.origin === "string" ? [expected.origin] : expected.origin;
    if (!origins.includes(fields.origin)) fail("wrong_origin", "The sign-in is for another site");
    if (typeof expected.nonce !== "string" || fields.nonce !== expected.nonce) fail("wrong_nonce", "The sign-in answers another challenge");
    const app = apps.get(fields.app) ?? fail("unknown_app", "The sign-in is for an app this backend does not accept");
    if (fields.provider !== app.provider || fields.network !== app.network || fields.genesisHash !== app.genesisHash)
      fail("wrong_network", "The sign-in's network or provider differs from the app's");
    if (await nodeGenesis() !== app.genesisHash) fail("node_unavailable", "The Algorand node is on another network than the app");

    // ---- 2. the session key in the proof signed this message
    if (!equal(limbs(signals, 8), Buffer.from(app.genesisHash, "base64url"))) fail("wrong_network", "The proof is for another network");
    if (!equal(limbs(signals, 4), Buffer.from(app.audienceHash, "base64url"))) fail("wrong_audience", "The proof is for another app's login");
    let signed = false;
    try {
      const sessionKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64url(limbs(signals, 6)) }, format: "jwk" });
      signed = verifySignature(null, signInBytes(fields), sessionKey, signature);
    } catch { /* not a valid key: unsigned */ }
    if (!signed) fail("bad_signature", "The session key did not sign this message");

    // ---- 3. the proof
    if (!groth16Verify(keys.get(app.verificationKeySha256)!, publicSignals, s!.proof!.proof as never)) fail("invalid_proof", "The zero-knowledge proof is invalid");

    // ---- times, on the chain's clock (the proof's session window is checked against it on chain too)
    const now = await node.time();
    const sessionExpiresAt = Number(signals[10]!), notBefore = Number(signals[11]!);
    if (notBefore > now + tolerance || fields.issuedAt > now + tolerance) fail("not_yet_valid", "The sign-in is dated in the future");
    if (sessionExpiresAt <= now || fields.expiresAt <= now) fail("expired", "The sign-in or its session expired");
    if (sessionExpiresAt > now + SESSION_SECONDS + tolerance) fail("invalid_proof", "The proof's session is longer than the protocol allows");
    if (fields.expiresAt > sessionExpiresAt) fail("malformed", "The sign-in outlives its session");
    if (fields.issuedAt < now - maxAge) fail("expired", "The sign-in is too old");

    // ---- 4. the provider key, in the on-chain KeyRegistry
    const keyRegistry = BigInt(app.keyRegistryId);
    const registryState = await node.globals(keyRegistry) ?? fail("key_inactive", "The key registry does not exist");
    if ((uintOf(registryState, "paused") ?? 0n) !== 0n) fail("registry_paused", "The provider's key registry is paused");
    // Registries made before the approval delay have no guardian and no bootstrap seal.
    if (registryState.has("guardian") && (uintOf(registryState, "sealed") ?? 0n) === 0n) fail("key_inactive", "The key registry is not sealed");
    const record = await node.box(keyRegistry, Buffer.concat([Buffer.from("gk:"), limbs(signals, 2)]));
    if (!record || record.length < 17) return fail("key_inactive", "The provider key that signed the login is not registered");
    const validFrom = record.readBigUInt64BE(0);
    let validUntil = record.readBigUInt64BE(8);
    // A pending renewal counts once it takes effect, as the contract applies it.
    if (record.length >= 33) { const renewedUntil = record.readBigUInt64BE(17), effectiveAt = record.readBigUInt64BE(25); if (effectiveAt && BigInt(now) >= effectiveAt) validUntil = renewedUntil; }
    if ((record[16]! & 0x80) !== 0 || validFrom > BigInt(now) || validUntil <= BigInt(now) || validUntil < BigInt(sessionExpiresAt))
      fail("key_inactive", "The provider key that signed the login is not active");

    // ---- 5. the wallet, from the on-chain WalletRegistry
    const owner = limbs(signals, 0);
    const box = await node.box(BigInt(app.registryId), Buffer.concat([Buffer.from("w:"), owner]));
    let walletId: bigint | null = null, address: string | null = null;
    if (box) {
      if (box.length !== 8) fail("wallet_mismatch", "Invalid wallet registry entry");
      walletId = box.readBigUInt64BE(0);
      const g = await node.globals(walletId) ?? fail("wallet_mismatch", "The registered wallet does not exist");
      const verifierBytes = bytesOf(g, "verifier");
      if (!equal(bytesOf(g, "owner") ?? Buffer.alloc(0), owner) || uintOf(g, "registry") !== BigInt(app.registryId) || uintOf(g, "keyRegistry") !== keyRegistry
        || !verifierBytes || encodeAddress(verifierBytes) !== app.verifier || !equal(bytesOf(g, "audience") ?? Buffer.alloc(0), Buffer.from(app.audienceHash, "base64url")))
        fail("wallet_mismatch", "The registered wallet does not match the app's deployment");
      address = applicationAddress(walletId);
    }
    if (fields.address !== address) fail("wallet_mismatch", fields.address ? "The sign-in names another wallet" : "The sign-in predates the wallet; sign in again");

    return {
      app: app.app, address, walletId, subject: b64url(owner), provider: app.provider, network: app.network,
      origin: fields.origin, statement: fields.statement, nonce: fields.nonce, issuedAt: fields.issuedAt, expiresAt: fields.expiresAt,
    };
  }

  return { verify, now: () => node.time() };
}
