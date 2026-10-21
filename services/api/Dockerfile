# The /v1 API service. Build from the repository root:
#
#   docker build -f services/api/Dockerfile -t zkauth-api .
#
# packages/chain loads algosdk, AlgoKit utils, snarkjs, tsx and the Groth16
# LogicSig verifier by path from the pinned upstream/snarkjs-algorand checkout,
# so there is exactly one instance of each (packages/chain/README.md). The
# checkout is gitignored and .dockerignore'd, so the first stage makes it the
# same way a developer does (scripts/setup.sh checkout: pinned commit, frozen
# lockfile, Linux-native dependencies) and installs the committed contract
# clients into it, as scripts/setup.sh stage does. The runtime stage copies
# that checkout and only the repository code the service imports.
#
# Trixie, matching services/prover and the legacy demo image (scripts/demo/Dockerfile).

FROM node:24-trixie-slim AS upstream
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY scripts/setup.sh scripts/setup.sh
RUN sh scripts/setup.sh checkout && rm -rf upstream/snarkjs-algorand/.git
COPY contracts/clients/KeyRegistry.ts contracts/clients/UserWallet.ts contracts/clients/WalletRegistry.ts upstream/snarkjs-algorand/contracts/clients/

FROM node:24-trixie-slim
WORKDIR /app
COPY --from=upstream /app/upstream upstream
# Packages (each "type": "module", which packages/chain requires of its importers).
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/protocol/src packages/protocol/src
COPY packages/config/package.json packages/config/package.json
COPY packages/config/src packages/config/src
COPY packages/chain/package.json packages/chain/package.json
COPY packages/chain/src packages/chain/src
# openChain checks the installed clients against these committed ones.
COPY contracts/clients/KeyRegistry.ts contracts/clients/UserWallet.ts contracts/clients/WalletRegistry.ts contracts/clients/
# packages/config applies the LocalNet dev-issuer override from here.
COPY services/dev-issuer/package.json services/dev-issuer/package.json
COPY services/dev-issuer/src/override.ts services/dev-issuer/src/override.ts
COPY services/api/package.json services/api/openapi.yaml services/api/
COPY services/api/src services/api/src
# The verifier LogicSig is derived from each provider's proving key, so the api
# reads the same fixtures volume as the prover (read-only is enough); the
# verification keys are baked in like the prover's.
COPY fixtures/phase3/verification_key.json fixtures/phase3/verification_key.json
COPY fixtures/slack/verification_key.json fixtures/slack/verification_key.json
RUN mkdir -p .local/service && chown -R node:node /app/fixtures /app/.local
USER node
VOLUME /app/fixtures
# Deployment records and apps.json (written by the cli) live in ZKAUTH_STATE_DIR.
ENV API_PORT=8780 API_HOST=0.0.0.0 ZKAUTH_STATE_DIR=/app/.local/service
EXPOSE 8780
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.API_PORT+'/v1/health').then(r=>r.json()).then(h=>process.exit(h.ok?0:1),()=>process.exit(1))"
# Required at run time: ZKAUTH_NETWORK, ZKAUTH_SPONSOR_MNEMONIC, ZKAUTH_PROVER_URL, ZKAUTH_PROVER_TOKEN
# (and ZKAUTH_API_PUBLIC_URL, ZKAUTH_ALGOD_URL, per-app client secrets as needed).
CMD ["node", "--import", "./upstream/snarkjs-algorand/node_modules/tsx/dist/loader.mjs", "services/api/src/server.ts"]
