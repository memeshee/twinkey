# TwinKey on Fly.io — scale-to-zero container.
#
# The app talks to the Portaldot node over a websocket and parses runtime metadata on first use,
# so it cannot be a lambda or a Worker; it needs a real process. That is exactly what Fly runs, and
# with `auto_stop_machines` the process is only billed while a request is in flight.
#
# `output: "standalone"` in next.config.mjs makes the runner stage the build output plus a Node
# runtime: no `npm ci` in the final image, no `next start`. The entrypoint is `node server.js`.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --include=dev: the build needs typescript/tailwind-class tooling that production installs skip.
RUN npm ci --include=dev

FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# Run unprivileged; the standalone bundle is world-readable so nothing needs root.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
