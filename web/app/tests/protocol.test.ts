import { describe, expect, test } from "vitest";
import { decodeSignals, formatAlgo, parseAlgo, parseUnits, proofBindingChecks, summarizeToken } from "../src/protocol";
import { summarizeHistory } from "../src/indexer";
import fixture from "./fixtures/wallet-773944646-history.json";

const limbs = (bytes: Uint8Array) => [bytes.subarray(0, 16), bytes.subarray(16)].map(v => BigInt(`0x${Buffer.from(v).toString("hex")}`).toString());
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

describe("amounts", () => {
  test("ALGO decimals convert to exact µALGO without floating point", () => {
    expect(parseAlgo("0.01")).toBe("10000");
    expect(parseAlgo("1")).toBe("1000000");
    expect(parseAlgo("0.000001")).toBe("1");
    expect(parseAlgo(" 12.5 ")).toBe("12500000");
    for (const bad of ["0", "0.0", "1.0000001", "-1", "1e3", "01", ".5", ""]) expect(() => parseAlgo(bad)).toThrow();
  });
  test("ASA units must be positive whole uint64 values", () => {
    expect(parseUnits("7")).toBe("7");
    for (const bad of ["0", "1.5", "18446744073709551616"]) expect(() => parseUnits(bad)).toThrow();
  });
  test("formatting keeps six decimals unless trimmed", () => {
    expect(formatAlgo("1080000")).toBe("1.080000 ALGO");
    expect(formatAlgo("1080000", true)).toBe("1.08 ALGO");
    expect(formatAlgo("454800", true)).toBe("0.4548 ALGO");
  });
});

test("public signals decode as 128-bit big-endian limb pairs and every binding is checked", () => {
  const values = Array.from({ length: 5 }, (_, i) => new Uint8Array(32).fill(i + 1));
  const signals = [...values.flatMap(limbs), "1800000000", "1799999300"];
  const decoded = decodeSignals(signals);
  expect(decoded).toEqual({ commitment: b64(values[0]), keyHash: b64(values[1]), audienceHash: b64(values[2]), sessionKey: b64(values[3]), genesisHash: b64(values[4]), expiresAt: 1800000000, notBefore: 1799999300 });
  const expected = { commitment: b64(values[0]), audienceHash: b64(values[2]), genesisHash: b64(values[4]), sessionKey: b64(values[3]), expiresAt: 1800000000, approvedKeys: [] };
  expect(proofBindingChecks(decoded, expected).filter(c => c.required).every(c => c.ok)).toBe(true);
  const changed = proofBindingChecks(decoded, { ...expected, sessionKey: b64(values[0]) });
  expect(changed.find(c => c.label === "Session key")?.ok).toBe(false);
  expect(() => decodeSignals(signals.slice(1))).toThrow(/twelve/);
  expect(() => decodeSignals([(1n << 128n).toString(), ...signals.slice(1)])).toThrow(/Noncanonical/);
});

test("token summary masks the subject and measures the signed message", () => {
  const part = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const token = `${part({ alg: "RS256", kid: "abc", typ: "JWT" })}.${part({ iss: "https://accounts.google.com", sub: "123456789012345678901", nonce: "n", iat: 1, exp: 2 })}.sig`;
  const summary = summarizeToken(token)!;
  expect(summary.sub).toBe("1234…01");
  expect(summary.signedBytes).toBe(token.lastIndexOf("."));
  expect(summarizeToken("not-a-token")).toBeUndefined();
});

test("recorded TestNet history summarizes enrollment, funding, opt-in and signed transfers", () => {
  const address = "FB7OE6DEMJVNDRTBGWETJTX62SMTNOD7W24QBMPEE4VHXUD5YQLGRSVJAE";
  const items = summarizeHistory(fixture.transactions as Parameters<typeof summarizeHistory>[0], address, "773944646");
  expect(items.map(i => [i.label, i.direction, i.amount, i.assetId])).toEqual([
    ["Signed transfer", "out", "7", "773914042"],
    ["Signed transfer", "out", "10000", "0"],
    ["Signed transfer", "out", "7", "773914042"],
    ["Received ASA", "in", "100", "773914042"],
    ["ASA opt-in", "none", undefined, "773914042"],
    ["Signed transfer", "out", "10000", "0"],
    ["Received ALGO", "in", "1000000", "0"],
    ["Enrollment", "in", "100000", "0"],
  ]);
});
