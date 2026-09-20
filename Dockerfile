FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# Chromium plus its OS libraries, and Xvfb to give it a display. Headless
# Chromium is easier for DoorDash's bot detection to spot, so the container
# runs a headed browser against a virtual framebuffer instead.
RUN npx patchright install --with-deps chromium \
    && apt-get update \
    && apt-get install -y --no-install-recommends xvfb \
    && rm -rf /var/lib/apt/lists/*

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV MCP_HTTP_PORT=3000 \
    MCP_HTTP_HOST=0.0.0.0 \
    DISPLAY=:99 \
    DOORDASH_HEARTBEAT_HOURS=6
EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=10s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Xvfb runs in the background rather than under xvfb-run: as PID 1 xvfb-run
# never execs its command, and this way node is PID 1 and gets the SIGTERM
# that triggers browser cleanup.
#
# Cookies are copied out of the (read-only) Secret mount so the session can be
# refreshed in place; refreshes are lost when the container restarts.
#
# ponytail: runs as root, which is why --no-sandbox in browser.ts is load-bearing.
# Move to a non-root user with PLAYWRIGHT_BROWSERS_PATH if this ever faces anything hostile.
CMD ["sh", "-c", "\
if [ -f /secrets/cookies.json ]; then \
  install -D -m600 /secrets/cookies.json /root/.config/striderlabs-mcp-doordash/cookies.json; \
fi; \
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp & \
exec node dist/index.js"]
