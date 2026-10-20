# The prover service. Build from the repository root:
#
#   docker build -f services/prover/Dockerfile -t zkauth-prover .
#
# Trixie, not bookworm: the rapidsnark Linux builds need glibc 2.38 or newer.
# The image holds code, the pinned rapidsnark binary and snarkjs. The proving keys
# (1.4 GB each) are not baked in: /app/fixtures is a volume that
# `node scripts/artifacts.mjs fetch` fills (see README.md).

FROM node:24-trixie-slim AS rapidsnark
RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY fixtures/artifacts.json ./artifacts.json
COPY services/prover/install-rapidsnark.mjs ./
RUN node install-rapidsnark.mjs artifacts.json /out

FROM node:24-trixie-slim
# The fallback prover; the version matches the development checkout's snarkjs.
RUN npm install --prefix /opt/snarkjs --no-audit --no-fund snarkjs@0.7.5
ENV SNARKJS_PATH=/opt/snarkjs/node_modules/snarkjs/main.js
WORKDIR /app
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/protocol/src packages/protocol/src
COPY services/prover/package.json services/prover/package.json
COPY services/prover/src services/prover/src
COPY scripts/artifacts.mjs scripts/artifacts.mjs
# The pinned list, and the verification keys the prover checks every proof against.
COPY fixtures/artifacts.json fixtures/artifacts.json
COPY fixtures/phase3/verification_key.json fixtures/phase3/verification_key.json
COPY fixtures/slack/verification_key.json fixtures/slack/verification_key.json
COPY --from=rapidsnark /out .local/bin
# fixtures is where proving keys go: a named volume copies this ownership on first use.
RUN mkdir -p .local/service/prover && chown -R node:node /app/fixtures /app/.local
USER node
VOLUME /app/fixtures
ENV PROVER_PORT=8781 PROVER_WORK_DIR=/app/.local/service/prover
EXPOSE 8781
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PROVER_PORT+'/v1/health').then(r=>r.json()).then(h=>process.exit(h.ok?0:1),()=>process.exit(1))"
# ZKAUTH_PROVER_TOKEN is required and must be supplied at run time. Give the container at least 4 GB of memory.
CMD ["node", "services/prover/src/server.ts"]
