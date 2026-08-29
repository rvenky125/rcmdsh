FROM node:24-alpine AS build

WORKDIR /app

COPY package*.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/daemon/package.json packages/daemon/
COPY packages/relay/package.json packages/relay/
COPY packages/web/package.json packages/web/
RUN npm install --include=dev

COPY . .
RUN npm run build

# ---- runtime image ----
FROM node:24-alpine

RUN addgroup -g 1001 -S rcmdsh && adduser -u 1001 -S rcmdsh -G rcmdsh

WORKDIR /app

COPY --from=build /app/packages/relay/dist ./relay/
COPY --from=build /app/packages/relay/public ./public/
COPY --from=build /app/node_modules ./node_modules/

RUN mkdir -p /data && chown rcmdsh:rcmdsh /data
VOLUME /data

ENV NODE_ENV=production

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8787/health || exit 1

USER rcmdsh

CMD ["node", "relay/index.js", "--port", "8787", "--db", "/data/relay.db", "--web", "/app/public"]
