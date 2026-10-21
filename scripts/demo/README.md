# Legacy TestNet demo

The original single-process TestNet demo (quickstart, deployment, the localhost server at <http://localhost:8765/demo/>, its prover and sessions, the TestNet account helper and the key guardian), kept working until it is retired by deleting this folder, now that the service stack has run on TestNet ([`compose.testnet.yaml`](../../compose.testnet.yaml)). Its page is the React app in [`web/app`](../../web/app/), which also builds the public showcase; its acceptance check is [`evidence/check-demo.sh`](../../evidence/check-demo.sh). Retiring it also removes the `demo:*` scripts in the root `package.json`, compose's `demo` service and web/app's demo page.

Run it with `sh scripts/demo/quickstart.sh` ([README](../../README.md#run-the-testnet-demo)); the individual commands are in the [development runbook](../../docs/development.md#legacy-testnet-demo).
