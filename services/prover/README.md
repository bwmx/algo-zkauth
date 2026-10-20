# prover

Internal HTTP service that turns a private circuit input into a verified Groth16 proof: witness from the circuit's WASM, then native [rapidsnark](https://github.com/iden3/rapidsnark) (about 20 times faster), with snarkjs as the fallback. The api service calls it; it is not exposed outside the internal network. Contract: [docs/service-architecture.md](../../docs/service-architecture.md).

The input contains an ID token and the wallet salt. It is held in memory, passed to a one-job worker process on a pipe, and never logged, echoed or written to disk. Only the witness is written, into a mode-700 job directory that is removed when the job ends and again for everything at startup. Log lines carry provider, outcome and timing only.

## Run

```sh
ZKAUTH_PROVER_TOKEN=$(openssl rand -hex 24) node services/prover/src/server.ts   # or: npm start -w @algozkauth/prover
```

Needs Node 24 (TypeScript runs natively), the proving artifacts (`node scripts/artifacts.mjs fetch [providers]`, which also installs rapidsnark under `.local/bin/<platform>-<arch>/prover`) and, for the snarkjs fallback and verification, the `upstream/` checkout (`scripts/fetch-upstream.sh`) or `SNARKJS_PATH`. Proving takes about 2.5 GB (rapidsnark, 5 to 10 s on an M-series Mac) or 2 GB (snarkjs, about 2 minutes).

| Variable | Default | Meaning |
| --- | --- | --- |
| `ZKAUTH_PROVER_TOKEN` | required | Bearer secret shared with the api; the service refuses to start without it |
| `PROVER_PORT` | `8781` | |
| `PROVER_HOST` | `0.0.0.0` | Bind address |
| `PROVER_CONCURRENCY` | `1` | Proofs at the same time |
| `PROVER_QUEUE` | `4` | Requests waiting for a slot; more get `429` |
| `PROVER_WORK_DIR` | `.local/service/prover` | Job directories (created mode 700, emptied at startup) |
| `PROVER_MAX_BODY_BYTES` | `131072` | A real input is about 7 KB |
| `PROVER_JOB_TIMEOUT_SECONDS` | `900` | A job still running after this is killed |
| `PROVER` | unset | `snarkjs` forces the fallback |
| `RAPIDSNARK_PATH` | `.local/bin/<platform>-<arch>/prover` | Another rapidsnark binary |
| `SNARKJS_PATH` | upstream checkout, else the `snarkjs` package | snarkjs `main.js` |

## API

- `POST /v1/prove` with `Authorization: Bearer $ZKAUTH_PROVER_TOKEN` and `{ "provider": "google", "input": { ... } }` (`input` is `oidcCircuitInput(...)`). `200` returns `{ proof, publicSignals, measurement: { prover, witnessMs, proveMs, elapsedMs, peakRssBytes } }`, after the proof verified against the provider's verification key and `expectedPublicSignals(input)`.
- `GET /v1/health` returns `{ ok, rapidsnark, providers }`: providers whose proving key, witness files and verification key are present; no token needed.

Errors are `{ "error": { "code", "message" } }` with fixed messages: `400 bad_request` (also `401` for a missing or wrong token, `413` for an oversized body), `404 not_found`, `422 proof_failed` (the circuit rejected the input, or the proof failed its checks), `429 rate_limited` with `Retry-After` (seconds, also `retryAfter` in the body), `503 service_unavailable` (proving keys missing, shutting down).

`peakRssBytes` is the highest sampled sum of the job process's resident set size and, while rapidsnark runs, the rapidsnark child's, sampled every 250 ms. On Linux the child figure is the kernel's own peak (`VmHWM`); on macOS it is the current size from `ps`. Each job runs in its own process, so this is per job at any concurrency.

## Tests

```sh
npm test -w @algozkauth/prover        # all, about 3 minutes; the snarkjs run alone is about 2
npm run test:fast -w @algozkauth/prover
```

They start the service on port 8981 with a temporary work directory and prove the synthetic Google input from `.local/phase3/synthetic-input.json`, one proof at a time.

## Docker

The proving keys (1.4 GB per provider) are not in the image; `/app/fixtures` is a volume that holds them. Build from the repository root, fill the volume once, then run:

```sh
docker build -f services/prover/Dockerfile -t zkauth-prover .
docker run --rm -v zkauth-fixtures:/app/fixtures zkauth-prover node scripts/artifacts.mjs fetch google --no-prover
docker run -d -p 127.0.0.1:8781:8781 -e ZKAUTH_PROVER_TOKEN=... -v zkauth-fixtures:/app/fixtures --memory 4g zkauth-prover
```

The image is `node:24-trixie-slim` because the rapidsnark Linux builds need glibc 2.38 or newer. rapidsnark is installed at build time from the pinned release in `fixtures/artifacts.json` (size and SHA-256 checked); snarkjs 0.7.5 comes from npm. The health check reports unhealthy until the volume holds a provider's artifacts.
