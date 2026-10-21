# keysync, and the zkauth CLI beside it (compose's one-shot `init` runs the same
# image with a different command). Build from the repository root:
#
#   docker build -f services/keysync/Dockerfile -t zkauth-keysync .
#
# Trixie to match the prover image and the legacy demo image (scripts/demo/Dockerfile).
#
# Unlike the prover, keysync loads packages/chain, which takes algosdk, AlgoKit
# utils, snarkjs, the Groth16 LogicSig verifier and the contract clients *by path*
# from the pinned upstream/snarkjs-algorand checkout (packages/chain/README.md).
# The image therefore builds that checkout the way a developer does: the first
# stage runs scripts/setup.sh checkout (pinned commit, frozen lockfile) and
# installs the committed contract clients exactly as scripts/setup.sh stage does.
# The final image carries the result without git, so every module still resolves
# to one algosdk and one AlgoKit instance. The upstream directory is large
# (pnpm store of the pinned dependencies); trimming it would risk the shared-instance
# guarantee, so it is copied whole.

FROM node:24-trixie-slim AS upstream
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY scripts/setup.sh scripts/setup.sh
RUN sh scripts/setup.sh checkout
# chain verifies these byte for byte against contracts/clients before it starts.
COPY contracts/clients contracts/clients
RUN for name in KeyRegistry UserWallet WalletRegistry; do \
      cp "contracts/clients/$name.ts" "upstream/snarkjs-algorand/contracts/clients/$name.ts"; \
    done \
 && rm -rf upstream/snarkjs-algorand/.git

FROM node:24-trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates unzip \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=upstream /app/upstream upstream
COPY contracts/clients contracts/clients
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/protocol/src packages/protocol/src
COPY packages/chain/package.json packages/chain/package.json
COPY packages/chain/src packages/chain/src
COPY packages/config/package.json packages/config/package.json
COPY packages/config/src packages/config/src
# config imports the dev-issuer's provider override (LocalNet), nothing else of it.
COPY services/dev-issuer/package.json services/dev-issuer/package.json
COPY services/dev-issuer/src/override.ts services/dev-issuer/src/override.ts
COPY services/keysync/package.json services/keysync/package.json
COPY services/keysync/src services/keysync/src
COPY tools/cli/package.json tools/cli/zkauth tools/cli/
COPY tools/cli/src tools/cli/src
# zkauth artifacts fetch, and the verification keys deploy checks records against.
COPY scripts/artifacts.mjs scripts/artifacts.mjs
COPY fixtures/artifacts.json fixtures/artifacts.json
COPY fixtures/phase3/verification_key.json fixtures/phase3/verification_key.json
COPY fixtures/slack/verification_key.json fixtures/slack/verification_key.json
# /state holds secrets.env, apps.json and the deployment records (a named volume).
# /app/fixtures takes the proving keys that `zkauth artifacts fetch` downloads;
# keysync itself never reads them, only `zkauth deploy provider` does.
RUN mkdir -p /state /app/.local && chown -R node:node /state /app/fixtures /app/.local
USER node
VOLUME /state
ENV ZKAUTH_STATE_DIR=/state KEYSYNC_BIND=0.0.0.0 KEYSYNC_PORT=8782
EXPOSE 8782
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.KEYSYNC_PORT+'/v1/health').then(r=>r.json()).then(h=>process.exit(h.ok?0:1),()=>process.exit(1))"
# ZKAUTH_NETWORK, ZKAUTH_ADMIN_MNEMONIC (and, on LocalNet, ZKAUTH_ALGOD_URL and
# ZKAUTH_DEV_ISSUER_URL) are supplied at run time. The one-shot init is
#   command: ["tools/cli/zkauth", "up", "--local"]
ENTRYPOINT []
CMD ["node", "--import", "./upstream/snarkjs-algorand/node_modules/tsx/dist/loader.mjs", "services/keysync/src/main.ts"]
