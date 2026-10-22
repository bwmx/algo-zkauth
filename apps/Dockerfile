# The demo app (8765), the hosted wallet (8770) and the send-algo example (8775),
# built with the SDK and served by vite preview; compose's example-backend runs
# examples/backend (8785) from the same image. Build from the repository root:
#   docker build -f apps/Dockerfile -t zkauth-web .
# VITE_ZKAUTH_SERVICE sets the API URL baked into the bundles (default: the local stack's).
FROM node:24-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol packages/protocol
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/sdk/src packages/sdk/src
COPY apps/demo apps/demo
COPY apps/wallet apps/wallet
COPY examples/send-algo examples/send-algo
COPY packages/verify/package.json packages/verify/package.json
COPY packages/verify/src packages/verify/src
COPY examples/backend examples/backend
# The example backend checks proofs with these (they must match each app's deployment).
COPY fixtures/phase3/verification_key.json fixtures/phase3/verification_key.json
COPY fixtures/slack/verification_key.json fixtures/slack/verification_key.json
RUN npm ci --no-audit --no-fund --workspace @bwmx/algo-zkauth-demo --workspace @bwmx/algo-zkauth-wallet --workspace @bwmx/algo-zkauth-example-send-algo --workspace @bwmx/algo-zkauth-example-backend --include-workspace-root=false
ARG VITE_ZKAUTH_SERVICE=http://localhost:8780
ENV VITE_ZKAUTH_SERVICE=$VITE_ZKAUTH_SERVICE
RUN npm run build -w @bwmx/algo-zkauth-demo && npm run build -w @bwmx/algo-zkauth-wallet && npm run build -w @bwmx/algo-zkauth-example-send-algo

FROM node:24-trixie-slim
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8765 8770 8775 8785
CMD ["sh", "-c", "npm run preview -w @bwmx/algo-zkauth-demo & npm run preview -w @bwmx/algo-zkauth-wallet & npm run preview -w @bwmx/algo-zkauth-example-send-algo & wait"]
