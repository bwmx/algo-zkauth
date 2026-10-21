// Execute the browser bundle under Node as a library regression check. This is
// not a browser benchmark and does not control or inspect any browser.
import assert from "node:assert/strict";
import {
  createReadStream,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { Readable } from "node:stream";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import * as snarkjs from "../upstream/snarkjs-algorand/node_modules/snarkjs/main.js";

const root = new URL("../", import.meta.url);
const small = process.argv.includes("--small");
const directory = small ? "fixtures/phase1" : "fixtures/phase3";
const wasmName = small ? "square_chain_2" : "google_jwt";
const input = JSON.parse(
  readFileSync(
    new URL(
      small
        ? "fixtures/phase1/input.json"
        : ".local/phase3/synthetic-input.json",
      root,
    ),
    "utf8",
  ),
);
const key = JSON.parse(
  readFileSync(new URL(`${directory}/verification_key.json`, root), "utf8"),
);
const expected = small
  ? JSON.parse(
      readFileSync(new URL("fixtures/phase1/public.json", root), "utf8"),
    )
  : [
      ...input.identity,
      ...input.keyHash,
      ...input.audienceHash,
      ...input.sessionKey,
      ...input.genesisHash,
      input.sessionExpiresAt,
      input.notBefore,
    ].map(String);
const publicFiles = new Map([
  ["/prover/google_jwt.wasm", `${directory}/${wasmName}_js/${wasmName}.wasm`],
  ["/prover/google_jwt.zkey", `${directory}/${wasmName}.zkey`],
]);
let nestedWorkerCount = 0;
let verified = false;
let result;
let lastStage;
let peakRss = process.memoryUsage().rss;
const monitor = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 1000);
let finish;
const completion = new Promise((resolve) => {
  finish = resolve;
});
const self = {
  addEventListener() {},
  postMessage(data) {
    if (!small && data.stage !== lastStage) {
      console.log(`Node library check: ${data.stage}`);
      lastStage = data.stage;
    }
    if (data.done) finish(data);
  },
};
const sandbox = {
  self,
  crypto: webcrypto,
  navigator: { hardwareConcurrency: 16 },
  performance,
  TextEncoder,
  TextDecoder,
  URL,
  Blob,
  Response,
  WebAssembly,
  atob,
  btoa,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  console: { log() {}, warn() {}, error() {} },
  Worker: class {
    constructor() {
      nestedWorkerCount++;
      throw new Error("Nested computation workers are forbidden in this check");
    }
  },
  fetch: async (url, options) => {
    if (url === "/prover/input")
      return new Response(JSON.stringify(input), {
        headers: {
          "Content-Type": "application/json",
          "X-Prover-Run-Id": "node-library-check",
        },
      });
    if (publicFiles.has(url)) {
      const file = new URL(publicFiles.get(url), root);
      return new Response(Readable.toWeb(createReadStream(file)), {
        headers: { "Content-Length": String(statSync(file).size) },
      });
    }
    if (url === "/prover/result") {
      result = JSON.parse(options.body);
      assert.deepEqual(result.publicSignals, expected);
      assert.equal(result.mode, "single-thread");
      verified = await snarkjs.groth16.verify(
        key,
        result.publicSignals,
        result.proof,
      );
      assert.equal(verified, true);
      return new Response(JSON.stringify({ verified }));
    }
    if (url === "/prover/failure") throw new Error("Worker reported a failure");
    throw new Error("Unexpected test resource");
  },
};
for (const name of [
  "ArrayBuffer",
  "DataView",
  "Uint8Array",
  "Uint16Array",
  "Uint32Array",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "BigUint64Array",
  "BigInt64Array",
  "Float32Array",
  "Float64Array",
])
  sandbox[name] = globalThis[name];
const context = vm.createContext(sandbox);
sandbox.importScripts = (url) => {
  assert.equal(url, "/prover/snarkjs.min.js");
  vm.runInContext(
    readFileSync(
      new URL(
        "upstream/snarkjs-algorand/node_modules/snarkjs/build/snarkjs.min.js",
        root,
      ),
      "utf8",
    ),
    context,
  );
};
try {
  vm.runInContext(
    readFileSync(new URL("web/phase3-prover/worker.js", root), "utf8"),
    context,
  );
  await self.onmessage({
    data: {
      source: "synthetic",
      userAgent: "Node library check; not a browser",
    },
  });
  const done = await completion;
  assert.equal(
    done.failed,
    undefined,
    `Worker failed at ${done.stage}: ${done.errorCode}`,
  );
  assert.equal(verified, true);
  assert.equal(nestedWorkerCount, 0);
  const record = {
    recordedAt: new Date().toISOString(),
    runtime: process.version,
    actualBrowserExecuted: false,
    circuit: wasmName,
    publicSignals: expected.length,
    browserBundle: "pinned snarkjs.min.js",
    proverMode: "single-thread",
    keyLoadStrategy: "4-MiB bigMem pages",
    nestedWorkerCount,
    witnessMs: result.witnessMs,
    keyLoadMs: result.keyLoadMs,
    proveMs: result.proveMs,
    elapsedMs: result.elapsedMs,
    peakSampledRssBytes: peakRss,
    independentVerificationPassed: verified,
  };
  if (!small)
    writeFileSync(
      new URL("benchmarks/phase3-browser-bundle.node.json", root),
      JSON.stringify(record, null, 2) + "\n",
    );
  console.log(JSON.stringify(record, null, 2));
} finally {
  clearInterval(monitor);
  await globalThis.curve_bn128?.terminate();
}
