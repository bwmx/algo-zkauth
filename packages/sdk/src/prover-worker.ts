// Browser proving worker (single-thread snarkjs, 4 MiB proving-key pages), ported from web/phase3-prover/worker.js.
//
// Host this module yourself and pass it as `browserProver.worker`, e.g.
//   worker: () => new Worker(new URL("@algozkauth/sdk/prover-worker", import.meta.url), { type: "module" })
// snarkjs is NOT part of the SDK bundle: the worker imports it from `snarkjsUrl` (host
// node_modules/snarkjs/build/browser.esm.js next to your app). The private circuit input arrives by
// postMessage from the SDK and never leaves the worker; nothing is sent to any server from here.
import type { ProverMessage } from "./proving.ts";

const KEY_PAGE_BYTES = 1 << 22; // snarkjs/fastfile "bigMem" page size: 4 MiB.

type ProveRequest = { type: "prove"; input: Record<string, unknown>; wasmUrl: string; zkeyUrl: string; snarkjsUrl: string };
type Snarkjs = {
  wtns: { calculate(input: unknown, wasm: string, out: { type: "mem"; data?: unknown }, options: Record<string, unknown>): Promise<void> };
  groth16: { prove(key: unknown, witness: unknown, logger: unknown, options: Record<string, unknown>): Promise<{ proof: any; publicSignals: string[] }> };
};

const scope = self as unknown as { postMessage(message: ProverMessage): void; onmessage: ((event: MessageEvent<ProveRequest>) => void) | null };
const post = (message: ProverMessage) => scope.postMessage(message);
const progress = (message: string) => post({ type: "progress", message });

async function loadKey(url: string): Promise<{ type: "bigMem"; data: Uint8Array[] }> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error("Could not load the proving key");
  const expected = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(expected) || expected <= 0) throw new Error("The proving key response has no length");
  const reader = response.body.getReader();
  const pages: Uint8Array[] = [];
  let page: Uint8Array | undefined;
  let offset = 0;
  let loaded = 0;
  let reported = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (loaded + value.length > expected) throw new Error("The proving key exceeds its declared length");
      let consumed = 0;
      while (consumed < value.length) {
        if (!page) page = new Uint8Array(Math.min(KEY_PAGE_BYTES, expected - loaded));
        const take = Math.min(page.length - offset, value.length - consumed);
        page.set(value.subarray(consumed, consumed + take), offset);
        offset += take; consumed += take; loaded += take;
        if (offset === page.length) { pages.push(page); page = undefined; offset = 0; }
      }
      if (loaded - reported >= 16 * 1024 ** 2 || loaded === expected) {
        progress(`Loading the proving key: ${((100 * loaded) / expected).toFixed(0)}%`);
        reported = loaded;
      }
    }
    if (loaded !== expected || page || pages.length === 0) throw new Error("The proving key download is truncated");
    return { type: "bigMem", data: pages };
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

let started = false;
scope.onmessage = async ({ data }) => {
  if (started || data?.type !== "prove") return;
  started = true;
  let key: { data: Uint8Array[] } | undefined;
  const witness: { type: "mem"; data?: unknown } = { type: "mem" };
  try {
    progress("Loading the proving library…");
    const mod = (await import(/* @vite-ignore */ data.snarkjsUrl)) as Snarkjs & { default?: Snarkjs };
    const snarkjs = mod.groth16 ? mod : mod.default;
    if (!snarkjs?.groth16) throw new Error("snarkjsUrl is not a snarkjs ES module");
    progress("Generating the witness…");
    await snarkjs.wtns.calculate(data.input, data.wasmUrl, witness, { sanityCheck: true, memorySize: 1024 });
    progress("Witness complete. Loading the proving key…");
    key = await loadKey(data.zkeyUrl);
    progress("Generating the proof in one thread. This can take a few minutes…");
    let phase: string | undefined;
    const logger = {
      debug(message: string) {
        // Only known stage names are exposed, never arbitrary library output.
        const next = /^Reading/.test(message) ? "reading proof data" : /ABC|QAP/.test(message) ? "building proof polynomials"
          : /FFT/.test(message) ? "polynomial transforms" : /multiexp/.test(message) ? "curve computations" : undefined;
        if (next && next !== phase) { phase = next; progress(`Generating the proof: ${next}`); }
      },
      info() {}, warn() {}, error() {},
    };
    const { proof, publicSignals } = await snarkjs.groth16.prove(key, witness, logger, { singleThread: true });
    post({ type: "result", proof, publicSignals });
  } catch (error) {
    const text = typeof (error as Error)?.message === "string" ? (error as Error).message : "";
    // Category only: never echo input, witness or raw library errors.
    const message = /allocat|out of memory|memory access|memory\.grow/i.test(text)
      ? "The browser could not allocate the memory this circuit needs"
      : /fetch|network|load|import/i.test(text) ? "A proving resource could not be loaded"
      : "The proof computation failed";
    post({ type: "error", message });
  } finally {
    if (key) key.data.length = 0;
    witness.data = undefined;
  }
};
