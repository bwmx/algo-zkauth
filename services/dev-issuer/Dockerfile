# LocalNet-only OpenID issuer (docs/service-architecture.md). Build from the repository root:
#   docker build -f services/dev-issuer/Dockerfile -t algozkauth-dev-issuer .
# Same base as the legacy demo image (scripts/demo/Dockerfile). Run with ZKAUTH_NETWORK=localnet.
FROM node:24-trixie-slim
RUN npm install -g tsx@4.20.6 && npm cache clean --force
WORKDIR /app
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/protocol/src packages/protocol/src
COPY services/dev-issuer/package.json services/dev-issuer/package.json
COPY services/dev-issuer/src services/dev-issuer/src
# The signing key persists in this volume so restarts keep the same JWKS.
RUN mkdir -p /state && chown node:node /state
VOLUME /state
USER node
ENV ZKAUTH_STATE_DIR=/state DEV_ISSUER_BIND=0.0.0.0
EXPOSE 8790
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:'+(process.env.DEV_ISSUER_PORT||8790)+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["tsx", "services/dev-issuer/src/server.ts"]
