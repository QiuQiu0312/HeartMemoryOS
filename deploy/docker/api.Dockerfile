FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --system --gid 10001 heartmemory \
    && useradd --system --uid 10001 --gid heartmemory --home-dir /app heartmemory \
    && mkdir -p /data \
    && chown -R heartmemory:heartmemory /app /data

COPY --chown=heartmemory:heartmemory packages/memory-core ./packages/memory-core
COPY --chown=heartmemory:heartmemory packages/runtime ./packages/runtime
COPY --chown=heartmemory:heartmemory apps/api ./apps/api

USER heartmemory
EXPOSE 8787
CMD ["node", "apps/api/src/server.js"]
