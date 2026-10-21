// Groth16 verification over BN254 for snarkjs-format keys and proofs, on
// @noble/curves (MIT, pure JS) rather than snarkjs (GPL-3.0), so a dApp's backend
// can embed it. Checked against snarkjs in test/groth16.test.ts.
//
//   e(-A, B) · e(α, β) · e(vk_x, γ) · e(C, δ) = 1,   vk_x = IC₀ + Σ sᵢ·ICᵢ₊₁
import { bn254 } from "@noble/curves/bn254.js";

export type Groth16Proof = { pi_a: string[]; pi_b: string[][]; pi_c: string[]; protocol?: string; curve?: string };
export type Groth16VerificationKey = {
  protocol: string; curve: string; nPublic: number;
  vk_alpha_1: string[]; vk_beta_2: string[][]; vk_gamma_2: string[][]; vk_delta_2: string[][]; IC: string[][];
};

const { Fp2, Fp12, Fr } = bn254.fields;
const G1 = bn254.G1.Point;
const G2 = bn254.G2.Point;
type P1 = InstanceType<typeof G1>;
type P2 = InstanceType<typeof G2>;

const decimal = (v: unknown): bigint => {
  if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(v)) throw new Error("not a decimal field element");
  return BigInt(v);
};
const fp = (v: unknown) => {
  const n = decimal(v);
  if (n >= bn254.fields.Fp.ORDER) throw new Error("coordinate out of range");
  return n;
};

/** An affine G1 point in snarkjs form [x, y, "1"]: on the curve and not the identity. */
function g1(v: unknown): P1 {
  if (!Array.isArray(v) || v.length !== 3 || v[2] !== "1") throw new Error("bad G1 point");
  const p = G1.fromAffine({ x: fp(v[0]), y: fp(v[1]) });
  p.assertValidity();
  if (p.is0()) throw new Error("G1 identity");
  return p;
}

/** An affine G2 point in snarkjs form [[x0, x1], [y0, y1], ["1", "0"]]: on the twist, in the subgroup, not the identity. */
function g2(v: unknown): P2 {
  if (!Array.isArray(v) || v.length !== 3 || !Array.isArray(v[2]) || v[2][0] !== "1" || v[2][1] !== "0") throw new Error("bad G2 point");
  const coord = (c: unknown) => {
    if (!Array.isArray(c) || c.length !== 2) throw new Error("bad G2 coordinate");
    return Fp2.fromBigTuple([fp(c[0]), fp(c[1])]);
  };
  const p = G2.fromAffine({ x: coord(v[0]), y: coord(v[1]) });
  p.assertValidity();
  if (p.is0() || !p.isTorsionFree()) throw new Error("G2 point outside the subgroup");
  return p;
}

type PreparedKey = { alpha: P1; beta: P2; gamma: P2; delta: P2; ic: P1[] };

/** Parses and checks a snarkjs verification key once; reuse the result. */
export function prepareVerificationKey(vk: Groth16VerificationKey): PreparedKey {
  if (vk?.protocol !== "groth16" || vk.curve !== "bn128") throw new Error("Not a Groth16 BN254 verification key");
  if (!Array.isArray(vk.IC) || vk.IC.length !== vk.nPublic + 1) throw new Error("Verification key IC does not match nPublic");
  return { alpha: g1(vk.vk_alpha_1), beta: g2(vk.vk_beta_2), gamma: g2(vk.vk_gamma_2), delta: g2(vk.vk_delta_2), ic: vk.IC.map(g1) };
}

/** True when `proof` proves `publicSignals` under `key`. Malformed input is false, never an exception. */
export function groth16Verify(key: PreparedKey, publicSignals: readonly string[], proof: Groth16Proof): boolean {
  try {
    if (!Array.isArray(publicSignals) || publicSignals.length !== key.ic.length - 1) return false;
    const signals = publicSignals.map(decimal);
    if (signals.some((s) => s >= Fr.ORDER)) return false;
    const a = g1(proof?.pi_a), b = g2(proof?.pi_b), c = g1(proof?.pi_c);
    let vkX = key.ic[0]!;
    signals.forEach((s, i) => { if (s !== 0n) vkX = vkX.add(key.ic[i + 1]!.multiplyUnsafe(s)); });
    if (vkX.is0()) return false;
    const product = bn254.pairingBatch([
      { g1: a.negate(), g2: b },
      { g1: key.alpha, g2: key.beta },
      { g1: vkX, g2: key.gamma },
      { g1: c, g2: key.delta },
    ]);
    return Fp12.eql(product, Fp12.ONE);
  } catch {
    return false;
  }
}
