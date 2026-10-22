# Example backend: sign in with an AlgoZKAuth wallet

`server.ts` is a dApp backend (about 100 lines, Node built-ins only) that signs users in with [`@bwmx/algo-zkauth-verify`](../../packages/verify/README.md). It trusts neither the AlgoZKAuth service nor the browser. Each sign-in is checked against the chain, and then the backend issues its own session cookie.

| Route | |
| --- | --- |
| `GET /api/nonce` | a single-use challenge, valid 5 minutes |
| `POST /api/sign-in` | body: the result of `session.createSignIn` / `wallet.createSignIn`; sets `sid` (HttpOnly) |
| `GET /api/me` | the verified sign-in for the cookie, or 401 |
| `POST /api/sign-out` | |

Both example pages call it: [`examples/send-algo`](../send-algo), embedded (`index.html`) and hosted (`hosted.html`), via `src/backend.ts`.

## Run it

The local stack starts it at <http://localhost:8785> (`npm run stack:up`, compose service `example-backend`). On its own, against the stack:

```sh
node examples/backend/server.ts      # Node 24 runs the TypeScript as is
```

| Variable | Default | |
| --- | --- | --- |
| `PORT`, `BIND` | `8785`, `127.0.0.1` | |
| `ALGOD_URL`, `ALGOD_TOKEN` | `http://localhost:4101`, the LocalNet token | any node on the apps' network |
| `CLOCK_TOLERANCE_SECONDS` | `30` | how far a sign-in may be dated ahead of the chain's clock; 600 on a dev-mode LocalNet, whose clock stands still between transactions |
| `ALLOWED_ORIGINS` | `http://localhost:8775` | the frontend origins it accepts sign-ins for (and answers with CORS) |
| `APP_SETTINGS` | — | a JSON file with the pinned `AppSettings[]`: use this in production |
| `ZKAUTH_SERVICE`, `ZKAUTH_APPS` | `http://localhost:8780`, `example,wallet` | without `APP_SETTINGS`: read these apps' settings from the service once at start, and log them so they can be pinned |

It accepts both the example app (embedded sign-ins) and the hosted wallet's app (sign-ins through `connectWallet`). Nonces and sessions are kept in memory; a real backend keeps them in its database.
