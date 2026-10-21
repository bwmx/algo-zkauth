# dev-issuer

A LocalNet-only OpenID issuer, so the full stack runs without a real Google (or Slack) client. It emulates a real provider (default `google`): tokens carry that provider's issuer and claim profile (built with `syntheticToken`) and are signed by a local RSA-2048 key, `kid` `dev-1`. The provider's circuit and the services accept them once the dev key is registered in the LocalNet key registry.

## Run

```sh
ZKAUTH_NETWORK=localnet npm --prefix services/dev-issuer start     # from the repository root
npm test -w @algozkauth/dev-issuer                                 # port 8890, temp state dir (npm run test:dev-issuer)
docker build -f services/dev-issuer/Dockerfile -t algozkauth-dev-issuer .   # from the repository root
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `ZKAUTH_NETWORK` | none | Must be `localnet`; the server refuses to start otherwise |
| `DEV_ISSUER_PORT` | `8790` | Listen port |
| `DEV_ISSUER_URL` | `http://localhost:<port>` | Public base URL used in discovery |
| `DEV_ISSUER_BIND` | `127.0.0.1` | Listen address (`0.0.0.0` in the container) |
| `DEV_ISSUER_PROVIDER` | `google` | Provider to emulate (`google`, `slack`) |
| `DEV_ISSUER_ALGOD_URL`, `DEV_ISSUER_ALGOD_TOKEN` | unset | Stamp tokens on this algod's chain clock, read just before each token (a dev-mode LocalNet's block clock drifts from wall time; see [docs/service-architecture.md](../../docs/service-architecture.md#clocks)). Unset: wall time |
| `ZKAUTH_STATE_DIR` | `.local/service` | The key is `dev-issuer/signing-key.pem` here (PKCS#8, mode 0600), so restarts keep the same JWKS |

## Endpoints

- `GET /.well-known/openid-configuration`, `GET /jwks`, `GET /v1/health`.
- `GET /authorize?client_id&redirect_uri&state&nonce` shows a sign-in page (alice, bob, or a typed subject; providers with a subject scope, such as Slack's team, also ask for it). Submitting redirects to `redirect_uri` with `code` and `state`. `redirect_uri` must be http(s) without a fragment. The code is single use, bound to client, redirect URI, nonce and subject, and expires after 60 seconds. An optional S256 `code_challenge` is enforced at the token endpoint.
- `POST /token` (form or JSON: `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`) returns `{ "ok": true, "token_type": "Bearer", "id_token": "..." }`, or HTTP 400 `{ "error": "invalid_grant" }`. No client secret is checked.
- `POST /test/token` with `{ audience, nonce, subject }` (plus `subjectScope` for Slack) returns `{ id_token }` for headless tests.

`src/override.ts` exports `withDevIssuer(provider, baseUrl, publicUrl = baseUrl)`: the provider with `jwksUrl` and `login` (`flow: "code"`, `pkce: "never"`) pointing here; `publicUrl` is the browser's address for the sign-in page when services reach the issuer at another one (compose: `http://localhost:8790` vs `http://dev-issuer:8790`, set by `ZKAUTH_DEV_ISSUER_PUBLIC_URL`). `exchangeCode` still requires a non-empty client secret when PKCE is off; any value works.

## Safety

The issuer signs a token for whoever asks and checks no credential. It refuses to start unless `ZKAUTH_NETWORK=localnet`, listens on loopback by default, and its key must never be registered in a TestNet or MainNet key registry. Tokens and codes are never logged.
