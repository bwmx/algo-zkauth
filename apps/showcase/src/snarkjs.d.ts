// The showcase uses only Groth16 verification from snarkjs, loaded on demand.
declare module "snarkjs" {
  export const groth16: { verify(verificationKey: unknown, publicSignals: string[], proof: unknown): Promise<boolean> };
}
