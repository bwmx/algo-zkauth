# zkauth

The operator's CLI for an AlgoZKAuth deployment: accounts, deployments, apps, key registry and guardian. Contract: [docs/service-architecture.md](../../docs/service-architecture.md).

```sh
sh scripts/fetch-upstream.sh && sh scripts/prepare-demo.sh     # once: pinned dependencies and contract clients
tools/cli/zkauth --help                                        # or: tools/cli/zkauth <command> --help
```

`tools/cli/zkauth` is a shell wrapper that runs `src/main.ts` with the pinned checkout's tsx loader. Exit codes: 0 success, 1 failure or guardian alert, 2 usage error.

## Configuration

Everything comes from the environment and from `$ZKAUTH_STATE_DIR/secrets.env` (written by `init`; an exported variable wins over the file). `--network` and `--state-dir` are global options for `ZKAUTH_NETWORK` (default `localnet`; `testnet` has to be chosen) and `ZKAUTH_STATE_DIR` (default `.local/service`). Other variables are in the architecture document; the CLI adds `ZKAUTH_KMD_URL` and `ZKAUTH_KMD_TOKEN` (LocalNet, defaults `http://localhost:4002` and the standard token) for the dispenser. Mnemonics are never printed; `init` prints only the path of `secrets.env`.

## Commands

| Command | What it does | Secrets |
| --- | --- | --- |
| `init [--wait] [--dry-run]` | Creates admin, sponsor and guardian accounts and a random `ZKAUTH_PROVER_TOKEN` in `secrets.env` (mode 0600). LocalNet funds them from the KMD dispenser; TestNet prints addresses and amounts, and `--wait` polls until funded. Idempotent. A guardian held elsewhere: set `ZKAUTH_GUARDIAN_ADDRESS` and no guardian mnemonic before running. | none |
| `deploy provider <id>` | Verifier LogicSig and key registry, once per provider per network. Needs the provider's proving artifacts. An existing record is verified on chain (registry exists, guardian, verification key) and kept. | admin |
| `deploy app <app>` | Wallet registry for an app in `apps.json`. Existing record verified on chain and kept. | sponsor |
| `apps add <id> --provider <p> --client-id <id> --origin <url>… [--shared] [--client-secret-env NAME] [--redirect-uri <url>]` | Adds to `apps.json`; the same settings again do nothing, different ones are refused. | none |
| `apps list`, `apps remove <id>` | List with deployment state; remove (keeps the deployment record). | none |
| `keys sync [provider]` | One `ensureKeys` pass from the provider's JWKS. | admin |
| `keys list [provider]` | The registry's keys and validity. | none |
| `guardian status [provider]` | Lists keys; **exit 1** when a key that is or will become valid is missing from the live JWKS. | none |
| `guardian revoke <fingerprint>`, `cancel-renewal <fingerprint>`, `pause [provider]` | Veto actions. The signer must be the guardian recorded in the provider's deployment. | guardian |
| `artifacts fetch [providers]` | `scripts/artifacts.mjs`: proving artifacts and the rapidsnark prover. | none |
| `check` | `scripts/check-demo.sh`: the legacy TestNet demo evidence check. | legacy `.env` |
| `up --local` | `init`, `apps add demo` (google, client `dev-client`, origin `http://localhost:8765`), `deploy provider google`, `deploy app demo`, `keys sync` against the dev issuer. Idempotent; what compose's `init` runs. | creates them |

Deployment records and `apps.json` go where the services read them: `$ZKAUTH_STATE_DIR/deployments/<network>/{providers,apps}/*.json` and `$ZKAUTH_STATE_DIR/apps.json`. To redeploy something, delete its record.

## LocalNet

`docker compose --profile local up` runs all of this for you (its `init` service), including the `example` and shared `wallet` apps; see [docs/service-architecture.md](../../docs/service-architecture.md#compose). Against AlgoKit's own LocalNet instead:

```sh
algokit localnet start
ZKAUTH_NETWORK=localnet ZKAUTH_DEV_ISSUER_URL=http://localhost:8790 npm start -w @algozkauth/dev-issuer &   # LocalNet only
tools/cli/zkauth artifacts fetch                  # google proving artifacts (1.4 GB), once
ZKAUTH_DEV_ISSUER_URL=http://localhost:8790 tools/cli/zkauth up --local
tools/cli/zkauth guardian status                  # exit 0
```

By hand, step by step:

```sh
zkauth init
zkauth apps add demo --provider google --client-id dev-client --origin http://localhost:8765
zkauth deploy provider google && zkauth deploy app demo
ZKAUTH_DEV_ISSUER_URL=http://localhost:8790 zkauth keys sync       # registers the dev key and seals the bootstrap
```

## TestNet

```sh
export ZKAUTH_NETWORK=testnet                     # or pass --network testnet
zkauth init                                       # writes secrets.env; prints the admin and sponsor addresses and what to fund
zkauth init --wait                                # same, then polls until both are funded (dispenser: https://dispenser.testnet.aws.algodev.network/)
zkauth artifacts fetch google
zkauth apps add demo --provider google --client-id 123.apps.googleusercontent.com --origin http://localhost:8765
zkauth deploy provider google && zkauth deploy app demo
zkauth keys sync                                  # real Google JWKS; new keys take effect after the 24-hour delay once sealed
```

`zkauth init --dry-run` shows what would be created and makes no network call; `init` without `--wait` makes none either. To keep the guardian off the host, set `ZKAUTH_GUARDIAN_ADDRESS` to its address before `init` (no guardian mnemonic is created), or move `ZKAUTH_GUARDIAN_MNEMONIC` out of `secrets.env` afterwards. Run the watch from anywhere, no secrets needed:

```sh
zkauth guardian status || echo "unexpected key: zkauth guardian revoke <fingerprint>"      # a cron job
```

Fingerprints are the base64url SHA-256 of a key's RSA modulus, as `status` lists them.

## Tests

`npm test -w @algozkauth/cli`: LocalNet on localhost:4001/4002, the google proving artifacts, port 9290 for an in-process dev issuer. Temporary state directories; it neither resets LocalNet nor moves its clock, and makes no TestNet transaction (the TestNet `init` test points at an unreachable node to show it makes no call).
