FROM node:24-alpine AS build

RUN apk add --no-cache python3 make g++

# node-gyp: official headers host + IPv4-first DNS (avoids WSL2/BuildKit IPv6 timeouts)
ENV NODE_OPTIONS=--dns-result-order=ipv4first npm_config_dist_url=https://nodejs.org/dist

WORKDIR /app

COPY package*.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/daemon/package.json packages/daemon/
COPY packages/relay/package.json packages/relay/
COPY packages/web/package.json packages/web/
RUN npm install --include=dev

COPY . .
RUN npm run build

# node_modules contains symlinks to workspace packages; dereference rcmdsh-core
# (the only workspace the relay requires at runtime) into a real directory
RUN rm -rf node_modules/rcmdsh-core \
  && cp -rL packages/shared node_modules/rcmdsh-core

# ---- runtime image ----
FROM node:24-alpine

RUN addgroup -g 1001 -S rcmdsh && adduser -u 1001 -S rcmdsh -G rcmdsh

WORKDIR /app

COPY --from=build /app/packages/relay/dist ./relay/
COPY --from=build /app/packages/relay/public ./public/
# relay's nested deps (e.g. commander@13, hoisted root holds terser's commander@2)
COPY --from=build /app/packages/relay/node_modules ./relay/node_modules/
COPY --from=build /app/node_modules ./node_modules/

RUN mkdir -p /data && chown rcmdsh:rcmdsh /data
VOLUME /data

ENV NODE_ENV=production

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8787/health || exit 1

USER rcmdsh

CMD ["node", "relay/index.js", "--port", "8787", "--db", "/data/relay.db", "--web", "/app/public"]
