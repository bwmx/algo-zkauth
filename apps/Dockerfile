# The demo app (8765), the hosted wallet (8770) and the send-algo example (8775),
# built with the SDK and served by vite preview. Build from the repository root:
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
RUN npm ci --no-audit --no-fund --workspace @algozkauth/demo --workspace @algozkauth/wallet --workspace @algozkauth/example-send-algo --include-workspace-root=false
ARG VITE_ZKAUTH_SERVICE=http://localhost:8780
ENV VITE_ZKAUTH_SERVICE=$VITE_ZKAUTH_SERVICE
RUN npm run build -w @algozkauth/demo && npm run build -w @algozkauth/wallet && npm run build -w @algozkauth/example-send-algo

FROM node:24-trixie-slim
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8765 8770 8775
CMD ["sh", "-c", "npm run preview -w @algozkauth/demo & npm run preview -w @algozkauth/wallet & npm run preview -w @algozkauth/example-send-algo & wait"]
