// Keep expensive work off the page, with no additional computation workers.
const mode = "single-thread";
const keyPageBytes = 1 << 22; // Pinned fastfile's bigMem page size: 4 MiB.
let stage = "worker-start";
let finished = false;
let source;
let userAgent;
let runId;
const status = (message, extra = {}) =>
  self.postMessage({ message, stage, mode, runId, ...extra });

function errorCode(error) {
  const message =
    typeof error?.message === "string" ? error.message : String(error);
  if (/allocat|out of memory|memory access|memory\.grow/i.test(message))
    return "memory-allocation";
  if (/fetch|network|load|importScripts/i.test(message)) return "resource-load";
  return "prover-error";
}

async function fail(error) {
  if (finished) return;
  finished = true;
  const code = errorCode(error);
  const detail =
    code === "memory-allocation"
      ? "The browser could not allocate the memory needed for this circuit."
      : code === "resource-load"
        ? "A local prover resource could not be loaded."
        : "The computation or independent verification failed.";
  // Save only an error category and stage, never an input/witness or raw error.
  try {
    await fetch("/prover/failure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source,
        userAgent,
        runId,
        mode,
        stage,
        errorCode: code,
      }),
    });
  } catch {}
  status(
    `Browser proof failed at ${stage}: ${detail} Failure telemetry was saved when available; retry or inspect the local benchmark record.`,
    { done: true, failed: true, errorCode: code },
  );
}

self.addEventListener("error", (event) => {
  event.preventDefault();
  void fail(event.error ?? { message: event.message });
});
self.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  void fail(event.reason);
});

async function loadKey() {
  const response = await fetch("/prover/google_jwt.zkey");
  if (!response.ok || !response.body)
    throw new Error("Could not load proving key");
  const expectedBytes = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0)
    throw new Error("Missing proving key length");
  const reader = response.body.getReader();
  const pages = [];
  let page;
  let offset = 0;
  let loaded = 0;
  let reported = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let consumed = 0;
      if (loaded + value.length > expectedBytes)
        throw new Error("Proving key exceeds its declared length");
      while (consumed < value.length) {
        if (!page)
          page = new Uint8Array(Math.min(keyPageBytes, expectedBytes - loaded));
        const take = Math.min(page.length - offset, value.length - consumed);
        page.set(value.subarray(consumed, consumed + take), offset);
        offset += take;
        consumed += take;
        loaded += take;
        if (offset === page.length) {
          pages.push(page);
          page = undefined;
          offset = 0;
        }
      }
      if (loaded - reported >= 16 * 1024 ** 2 || loaded === expectedBytes) {
        status(
          `Loading proving key: ${((100 * loaded) / expectedBytes).toFixed(0)}% (${mode}).`,
        );
        reported = loaded;
      }
    }
    if (loaded !== expectedBytes || page || pages.length === 0)
      throw new Error("Proving key download is truncated");
    return { type: "bigMem", data: pages };
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

self.onmessage = async ({ data }) => {
  if (source) return;
  ({ source, userAgent } = data);
  let key;
  const witness = { type: "mem" };
  try {
    stage = "library-load";
    status("Worker started. Loading the proving library…");
    importScripts("/prover/snarkjs.min.js");
    stage = "input-load";
    status("Loading the circuit input…");
    const inputResponse = await fetch("/prover/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source }),
    });
    const input = await inputResponse.json();
    if (!inputResponse.ok) throw new Error("Circuit input could not be loaded");
    runId = inputResponse.headers.get("x-prover-run-id");
    if (!runId)
      throw new Error("Reload the page after the local server update");
    const started = performance.now();
    stage = "witness";
    status("Generating the witness with circuit checks enabled…");
    await snarkjs.wtns.calculate(input, "/prover/google_jwt.wasm", witness, {
      sanityCheck: true,
      memorySize: 1024,
    });
    const witnessMs = Math.round(performance.now() - started);
    stage = "key-load";
    status("Witness complete. Loading the proving key in 4 MiB chunks…");
    const keyStarted = performance.now();
    key = await loadKey();
    const keyLoadMs = Math.round(performance.now() - keyStarted);
    stage = "proof";
    status(
      "Generating the proof in one computation thread. This may take several minutes…",
    );
    let lastPhase;
    const logger = {
      debug(message) {
        // Only expose known stage names, never arbitrary library messages.
        const phase = /^Reading/.test(message)
          ? "reading proof data"
          : /ABC|QAP/.test(message)
            ? "building proof polynomials"
            : /FFT/.test(message)
              ? "polynomial transforms"
              : /multiexp/.test(message)
                ? "curve computations"
                : null;
        if (phase && phase !== lastPhase) {
          lastPhase = phase;
          status(`Generating proof: ${phase} (${mode}).`);
        }
      },
      info() {},
      warn() {},
      error() {},
    };
    const proveStarted = performance.now();
    const { proof, publicSignals } = await snarkjs.groth16.prove(
      key,
      witness,
      logger,
      { singleThread: true },
    );
    const proveMs = Math.round(performance.now() - proveStarted);
    const elapsedMs = Math.round(performance.now() - started);
    key.data.length = 0;
    witness.data = undefined;
    let measuredMemoryBytes = null;
    if (typeof performance.measureUserAgentSpecificMemory === "function") {
      try {
        measuredMemoryBytes = (
          await performance.measureUserAgentSpecificMemory()
        ).bytes;
      } catch {}
    }
    stage = "server-verification";
    status(
      "Proof generated. Checking it independently on the localhost server…",
    );
    const response = await fetch("/prover/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source,
        runId,
        mode,
        proof,
        publicSignals,
        elapsedMs,
        witnessMs,
        keyLoadMs,
        proveMs,
        measuredMemoryBytes,
        userAgent,
      }),
    });
    if (!response.ok) throw new Error("Independent verification failed");
    const result = await response.json();
    if (result.verified !== true)
      throw new Error("Independent verification failed");
    finished = true;
    stage = "complete";
    status(
      `Verified browser proof in ${(elapsedMs / 1000).toFixed(1)} seconds (${mode}). The benchmark was saved.`,
      { done: true },
    );
  } catch (error) {
    await fail(error);
  } finally {
    if (key) key.data.length = 0;
    witness.data = undefined;
  }
};
