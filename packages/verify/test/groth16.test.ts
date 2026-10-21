// The noble-based verifier must agree with snarkjs (the prover's own verifier)
// on the committed fixture proofs, and reject every kind of tampering.
import { readFileSync } from "node:fs";
import { bn254 } from "@noble/curves/bn254.js";
import { describe, expect, it } from "vitest";
import { groth16Verify, prepareVerificationKey, type Groth16Proof } from "../src/groth16.ts";
// Test-only: snarkjs from the pinned checkout (scripts/setup.sh), as a reference. It has no types.
const snarkjs: any = await import("../../../upstream/snarkjs-algorand/node_modules/snarkjs/main.js" as string);

const root = new URL("../../../fixtures/", import.meta.url);
const json = (path: string) => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const cases = ["phase1", "benchmark/1", "benchmark/7"].map((dir) => ({
  dir, vk: json(`${dir}/verification_key.json`), proof: json(`${dir}/proof.json`) as Groth16Proof, signals: json(`${dir}/public.json`) as string[],
}));

describe("groth16Verify", () => {
  for (const { dir, vk, proof, signals } of cases) {
    it(`accepts the ${dir} fixture proof, as snarkjs does`, async () => {
      expect(await snarkjs.groth16.verify(vk, signals, proof)).toBe(true);
      expect(groth16Verify(prepareVerificationKey(vk), signals, proof)).toBe(true);
    });

    it(`rejects tampered ${dir} signals and proofs`, async () => {
      const key = prepareVerificationKey(vk);
      const bumped = signals.map((s, i) => (i === 0 ? String(BigInt(s) + 1n) : s));
      expect(groth16Verify(key, bumped, proof)).toBe(false);
      expect(await snarkjs.groth16.verify(vk, bumped, proof)).toBe(false);
      // Swapped A and C, and a C from another proof.
      expect(groth16Verify(key, signals, { ...proof, pi_a: proof.pi_c, pi_c: proof.pi_a })).toBe(false);
      const other = cases.find((c) => c.dir !== dir)!.proof;
      expect(groth16Verify(key, signals, { ...proof, pi_c: other.pi_c })).toBe(false);
      // Wrong signal count, out-of-field signal, non-decimal, off-curve point, identity.
      expect(groth16Verify(key, signals.slice(1), proof)).toBe(false);
      const wrapped = String(BigInt(signals[0]!) + bn254.fields.Fr.ORDER); // the same value mod r, as snarkjs would reduce it
      expect(groth16Verify(key, signals.map((s, i) => (i === 0 ? wrapped : s)), proof)).toBe(false);
      expect(groth16Verify(key, signals.map((s, i) => (i === 0 ? `0x${s}` : s)), proof)).toBe(false);
      expect(groth16Verify(key, signals, { ...proof, pi_a: [proof.pi_a[0]!, String(BigInt(proof.pi_a[1]!) + 1n), "1"] })).toBe(false);
      expect(groth16Verify(key, signals, { ...proof, pi_a: ["0", "1", "0"] })).toBe(false);
      expect(groth16Verify(key, signals, null as never)).toBe(false);
    });
  }

  it("refuses a malformed verification key", () => {
    const { vk } = cases[0]!;
    expect(() => prepareVerificationKey({ ...vk, curve: "bls12381" })).toThrow();
    expect(() => prepareVerificationKey({ ...vk, nPublic: vk.nPublic + 1 })).toThrow();
  });
});
