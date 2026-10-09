import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

for (const count of [1, 7]) {
  const extra = count - 1;
  const publicDeclaration = extra
    ? `    signal input context[${extra}];\n`
    : "";
  const first = extra ? "secret + context[0]" : "secret + 7";
  const round = extra ? `context[i % ${extra}]` : "7";
  const main = extra
    ? "component main {public [context]} = Benchmark();"
    : "component main = Benchmark();";
  const source = `pragma circom 2.2.3;

// Toy circuit for verifier cost scaling. Not a cryptographic hash.
template Benchmark() {
    signal input secret;
${publicDeclaration}    signal output digest;
    signal state[33];
    state[0] <== ${first};
    for (var i = 0; i < 32; i++) {
        state[i + 1] <== state[i] * state[i] + ${round} + i;
    }
    digest <== state[32];
}

${main}
`;
  const directory = resolve(root, `fixtures/benchmark/${count}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, `bench_${count}.circom`), source);
  writeFileSync(
    resolve(directory, "input.json"),
    JSON.stringify(
      extra
        ? { secret: "11", context: Array.from({ length: extra }, (_, i) => String(i + 3)) }
        : { secret: "11" },
      null,
      2,
    ) + "\n",
  );
}
