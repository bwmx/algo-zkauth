# Runs the legacy TestNet demo on Linux (compose.yaml's demo service). The image
# holds only the tools; the repository is mounted at /app, so .env, the downloaded
# proving keys and the run records stay in your checkout and are shared with a native run.
# Trixie, not bookworm: the rapidsnark release needs glibc 2.38 or newer.
FROM node:24-trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# The mount points for compose's named volumes are created here so the node user can write to them.
RUN mkdir -p /app/upstream /app/web/app/node_modules && chown -R node:node /app
USER node
WORKDIR /app
ENV DEMO_BIND=0.0.0.0
EXPOSE 8765
CMD ["sh", "scripts/demo/quickstart.sh"]
