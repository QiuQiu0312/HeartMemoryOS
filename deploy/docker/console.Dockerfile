FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY apps/console/package.json apps/console/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY apps/console ./
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 10001 heartmemory \
    && useradd --system --uid 10001 --gid heartmemory --home-dir /app heartmemory
COPY --from=build --chown=heartmemory:heartmemory /app /app
USER heartmemory
EXPOSE 3000
CMD ["npm", "run", "start"]
