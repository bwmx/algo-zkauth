# zkauth

The operator's CLI for an AlgoZKAuth deployment: accounts, deployments, apps, key registry and guardian. Contract: [docs/service-architecture.md](../../docs/service-architecture.md).

```sh
npm run setup                                     # once: pinned dependencies and contract clients (sh scripts/setup.sh)
tools/cli/zkauth --help                                        # or: tools/cli/zkauth <command> --help
```

`tools/cli/zkauth` is a shell wrapper that runs `src/main.ts` with the pinned checkout's tsx loader. Exit codes: 0 success, 1 failure or guardian alert, 2 usage error.

## Configuration

Everything comes from the environment and from `$ZKAUTH_STATE_DIR/secrets.env` (written by `init`; an exported variable wins over the file). `--network` and `--state-dir` are global options for `ZKAUTH_NETWORK` (default `localnet`; `testnet` has to be chosen) and `ZKAUTH_STATE_DIR` (default `.local/service`). Other variables are in the architecture document; the CLI adds `ZKAUTH_KMD_URL` and `ZKAUTH_KMD_TOKEN` (LocalNet, defaults `http://localhost:4002` and the standard token) for the dispenser. Mnemonics are never printed; `init` prints only the path of `secrets.env`.

## Commands

| Command | What it does | Secrets |
| --- | --- | --- |
| `init [--wait] [--fund-from <VAR>] [--dry-run]` | Creates admin, sponsor and guardian accounts and a random `ZKAUTH_PROVER_TOKEN` in `secrets.env` (mode 0600). LocalNet funds them from the KMD dispenser; TestNet prints addresses and amounts, and `--wait` polls until funded. `--fund-from <VAR>`, on either network, tops them up instead from the account whose mnemonic is in the variable `<VAR>` ([Funding from an account](#funding-from-an-account)). Idempotent. A guardian held elsewhere: set `ZKAUTH_GUARDIAN_ADDRESS` and no guardian mnemonic before running. | none |
| `deploy provider <id>` | Verifier LogicSig and key registry, once per provider per network. Needs the provider's proving artifacts. An existing record is verified on chain (registry exists, guardian, verification key) and kept. | admin |
| `deploy app <app>` | Wallet registry for an app in `apps.json`. Existing record verified on chain and kept. | sponsor |
| `apps add <id> --provider <p> --client-id <id> --origin <url>… [--shared] [--client-secret-env NAME] [--redirect-uri <url>]` | Adds to `apps.json`; the same settings again do nothing, different ones are refused. | none |
| `apps list`, `apps remove <id>` | List with deployment state; remove (keeps the deployment record). | none |
| `keys sync [provider]` | One `ensureKeys` pass from the provider's JWKS. | admin |
| `keys list [provider]` | The registry's keys and validity. | none |
| `guardian status [provider]` | Lists keys; **exit 1** when a key that is or will become valid is missing from the live JWKS. | none |
| `guardian revoke <fingerprint>`, `cancel-renewal <fingerprint>`, `pause [provider]` | Veto actions. The signer must be the guardian recorded in the provider's deployment. | guardian |
| `artifacts fetch [providers]` | `scripts/artifacts.mjs`: proving artifacts and the rapidsnark prover. | none |
| `check` | `evidence/check-demo.sh`: the legacy TestNet demo evidence check. | legacy `.env` |
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

[`compose.testnet.yaml`](../../compose.testnet.yaml) runs these steps in its `init` service and then the whole stack (`npm run stack:testnet:up`). By hand:

```sh
export ZKAUTH_NETWORK=testnet                     # or pass --network testnet
zkauth init                                       # writes secrets.env; prints the admin and sponsor addresses and what to fund
zkauth init --wait                                # same, then polls until both are funded (dispenser: https://dispenser.testnet.aws.algodev.network/)
zkauth init --fund-from ZKAUTH_FUNDER_MNEMONIC    # or tops them up from an account you hold (see Funding from an account)
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

### Funding from an account

`zkauth init --fund-from <VAR>` pays the role accounts from a funding account you already hold, so nobody has to copy addresses into the dispenser. `<VAR>` names an environment variable (or a `secrets.env` entry) holding that account's mnemonic; the CLI reads it and never prints it, only the funder's address. It tops each account up to a spendable balance (above its minimum) of:

| Account | Spendable after `--fund-from` |
| --- | --- |
| admin | 5 ALGO (the provider deployment and key registrations) |
| sponsor | 10 ALGO (app deployments, enrollment deposits and fees; the api's wallet faucet also pays from it) |
| guardian | 0.50 ALGO (its veto transactions) |

An account already holding that much gets nothing, so a rerun sends nothing. Before sending, it checks that the funder can cover every top-up and fee, and otherwise stops without paying anyone. The funder must be a separate account: one whose address is the admin's, sponsor's or guardian's is refused. On LocalNet it replaces the KMD dispenser; on TestNet its payments are the only transactions `init` sends. With `--dry-run` it names the funder and the targets and sends nothing.

From fresh accounts the funder pays about 15.8 ALGO: the three targets, 0.1 ALGO of minimum balance for each new account, and fees. The single-account TestNet demo's `.env` already holds an account like that: set `ZKAUTH_FUNDER_MNEMONIC` to the value of its `TESTNET_MNEMONIC` and run `zkauth init --fund-from ZKAUTH_FUNDER_MNEMONIC`, which is what [`compose.testnet.yaml`](../../compose.testnet.yaml) does when that variable is set.

## Tests

`npm test -w @algozkauth/cli`: LocalNet on localhost:4001/4002, the google proving artifacts, port 9290 for an in-process dev issuer. Temporary state directories; it neither resets LocalNet nor moves its clock, and makes no TestNet transaction (the TestNet `init` test points at an unreachable node to show it makes no call; `--fund-from` is tested on LocalNet with a funder from the dispenser).
