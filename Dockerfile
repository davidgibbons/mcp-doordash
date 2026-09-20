FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# Patchright is least detectable driving real Google Chrome, which ships no
# Linux arm64 build - so arm64 images get Chromium and browser.ts falls back
# to it at runtime. Build for amd64 if you want the quieter browser.
#
# Xvfb gives it a display, because a headless browser is easier for DoorDash's
# bot detection to spot than a headed one on a virtual framebuffer.
RUN if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
      npx patchright install --with-deps chrome; \
    else \
      npx patchright install --with-deps chromium; \
    fi \
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
# /secrets is a read-only Secret mount, so cookies are copied somewhere
# writable and the session can be refreshed in place. The copy only happens
# when there is nothing there yet: mount a volume on the config dir and the
# Secret seeds the first boot, while later boots keep the refreshed session.
# Without that volume the refreshes die with the container and you re-login
# every restart.
#
# ponytail: runs as root, which is why --no-sandbox in browser.ts is load-bearing.
# Move to a non-root user with PLAYWRIGHT_BROWSERS_PATH if this ever faces anything hostile.
CMD ["sh", "-c", "\
COOKIES=/root/.config/striderlabs-mcp-doordash/cookies.json; \
if [ -f /secrets/cookies.json ] && [ ! -s \"$COOKIES\" ]; then \
  install -D -m600 /secrets/cookies.json \"$COOKIES\"; \
fi; \
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp & \
exec node dist/index.js"]
