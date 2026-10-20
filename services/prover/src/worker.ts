// One proving job in its own process: reads {provider, input, workDir} as JSON on
// stdin, writes {ok, ...} as JSON on stdout. Run by server.ts, never by hand.
//
// A separate process keeps the server answering health checks and 429s while a
// proof runs (witness and snarkjs work block the event loop), returns the proof's
// memory to the system when it ends, makes peakRssBytes a per-job figure and lets a
// hung job be killed. The input never appears in argv, the environment or on disk.
import { proveInput, ProveError } from "./prove.ts";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);

let output: unknown;
try {
  const { provider, input, workDir } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  output = { ok: true, result: await proveInput({ provider, input, workDir }) };
} catch (error) {
  output = error instanceof ProveError
    ? { ok: false, code: error.code, message: error.message }
    : { ok: false, code: "proof_failed", message: "The proof could not be produced" };
}
process.stdout.write(JSON.stringify(output), () => process.exit(0));
