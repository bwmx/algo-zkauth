import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserProver } from "../src/proving.ts";

// Runs src/prover-worker.ts in-process against a stub snarkjs module and a stubbed key download, through the
// same message protocol the SDK uses with a real Worker.
const SNARKJS = "data:text/javascript," + encodeURIComponent(`
  export const wtns = { calculate: async (input, wasm, out) => { out.data = { input, wasm }; } };
  export const groth16 = { prove: async (key, witness, logger, options) => {
    logger.debug("multiexp");
    return { proof: { pi_a: [String(key.data.length), String(options.singleThread)], pi_b: [], pi_c: [], protocol: "groth16", curve: "bn128" }, publicSignals: [witness.data.wasm] };
  } };
`);

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("browser prover worker", () => {
  it("computes a witness, pages the key in 4 MiB chunks and returns the proof", async () => {
    const toWorker: { current?: (event: { data: unknown }) => void } = {};
    const toPage: any[] = [];
    vi.stubGlobal("self", {
      postMessage: (m: unknown) => toPage.push(m),
      set onmessage(fn: (event: { data: unknown }) => void) { toWorker.current = fn; },
      get onmessage() { return toWorker.current!; },
    });
    const keyBytes = 9 * 1024 * 1024;       // three pages: 4 + 4 + 1 MiB
    vi.stubGlobal("fetch", async () => new Response(new Blob([new Uint8Array(keyBytes)]).stream(), { headers: { "content-length": String(keyBytes) } }));
    await import("../src/prover-worker.ts");

    const done = new Promise<any>((resolve) => {
      const original = (self as any).postMessage;
      (self as any).postMessage = (m: any) => { original(m); if (m.type !== "progress") resolve(m); };
    });
    toWorker.current!({ data: { type: "prove", input: { x: 1 }, wasmUrl: "/c.wasm", zkeyUrl: "/c.zkey", snarkjsUrl: SNARKJS } });
    const result = await done;
    expect(result.type).toBe("result");
    expect(result.proof.pi_a).toEqual(["3", "true"]);
    expect(result.publicSignals).toEqual(["/c.wasm"]);
    expect(toPage.some((m) => m.type === "progress" && /key/i.test(m.message))).toBe(true);
    // Only progress and the result leave the worker; the input is not echoed.
    expect(JSON.stringify(toPage)).not.toContain('"x"');
  });

  it("requires the three URLs", () => {
    expect(() => createBrowserProver({ wasmUrl: "", zkeyUrl: "b", snarkjsUrl: "c" })).toThrow(/wasmUrl/);
  });
});
