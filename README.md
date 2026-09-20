# @striderlabs/mcp-doordash

**Order food delivery via DoorDash using AI agents**

[![npm](https://img.shields.io/npm/v/@striderlabs/mcp-doordash)](https://www.npmjs.com/package/@striderlabs/mcp-doordash)
[![MCP Registry](https://img.shields.io/badge/MCP-Registry-blue)](https://mcpservers.org/servers/strider-labs-doordash)
[![Claude Desktop](https://img.shields.io/badge/Claude-Desktop-blue)](https://docs.anthropic.com/mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

Part of [Strider Labs](https://github.com/striderlabsdev/striderlabs) — action execution for personal AI agents.

## Get Started in 2 Minutes

### For Claude Desktop Users

1. Add this to `~/.openclaw/config.json` or your Claude Desktop config:

```json
{
  "mcpServers": {
    "doordash": {
      "command": "npx",
      "args": ["-y", "@striderlabs/mcp-doordash"]
    }
  }
}
```

2. Restart Claude.
3. Tell Claude: *"Order Thai food from nearby for delivery today"*

Your agent can now place orders. That's it.

---

## Installation (NPM)

```bash
npm install @striderlabs/mcp-doordash
```

Or with npx directly:

```bash
npx @striderlabs/mcp-doordash
```

## Features

- 🔍 **Search restaurants** by name, cuisine, or food type
- 📜 **Browse menus** with full item details and prices
- 🛒 **Add to cart** with quantity and special instructions
- 💳 **Place orders** with confirmation step
- 📍 **Track orders** with real-time status updates
- 🔐 **Persistent sessions** - stay logged in across restarts
- 🔄 **Automatic MFA** - handles multi-factor authentication
- 📱 **Per-user credentials** - encrypted session storage

## Tested & Compatible

| Component | Version | Status |
|-----------|---------|--------|
| **MCP SDK** | ^1.0.0 | ✅ |
| **Node.js** | 18+ | ✅ |
| **Claude Desktop** | Latest | ✅ |
| **Claude (API)** | claude-3.5-sonnet+ | ✅ |
| **Anthropic SDK** | ^0.20+ | ✅ |

## Metrics

- **Weekly downloads:** 395 (Apr 10-17, 2026) — #1 Strider Labs connector (+24% growth)
- **Status:** ✅ Live in production
- **Reliability:** 85%+ task completion rate
- **Discovery:** npm, Claude Plugins, mcpservers.org, ClawHub, PulseMCP

## Available Elsewhere

- **npm:** [npmjs.com/@striderlabs/mcp-doordash](https://npmjs.com/package/@striderlabs/mcp-doordash)
- **Claude Plugins:** Search "Strider Labs" in Claude
- **mcpservers.org:** [Strider Labs DoorDash](https://mcpservers.org/servers/strider-labs-doordash)
- **Full Strider Labs:** [github.com/striderlabsdev/striderlabs](https://github.com/striderlabsdev/striderlabs)

## How It Works

### For Agents
Your agent can use these capabilities:
```javascript
// Search for restaurants
restaurants = search_restaurants({
  location: "San Francisco, CA",
  cuisine: "Thai",
  max_delivery_time: 30
})

// Browse a restaurant's menu
menu = get_restaurant_menu({
  restaurant_id: "thai-place-downtown",
  search: "Pad Thai"
})

// Place an order
order = place_order({
  restaurant_id: "thai-place-downtown",
  items: [
    { item_id: "pad_thai", quantity: 1 },
    { item_id: "spring_rolls", quantity: 2 }
  ],
  delivery_address: "123 Main St, San Francisco, CA",
  special_instructions: "Extra lime on the side"
})

// Track delivery
status = track_order({ order_id: order.order_id })
```

### Session Management
- Each user has encrypted, persistent credentials
- Automatic OAuth token refresh
- MFA handling (SMS/email)
- Sessions survive agent restarts

### Reliability
- 85%+ task completion rate
- Automated UI change detection (connectors update when DoorDash changes)
- Fallback paths for failures
- 24/7 monitoring + alerting

## Configuration

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_HTTP_PORT` | unset | Serve Streamable HTTP on this port instead of stdio |
| `MCP_HTTP_TOKEN` | — | Bearer token clients must present. Required when `MCP_HTTP_PORT` is set |
| `MCP_HTTP_HOST` | `127.0.0.1` | Interface to bind |
| `DOORDASH_HEADLESS` | unset | Set to `1` to run Chromium headless |
| `DOORDASH_HEARTBEAT_HOURS` | unset (`6` in the image) | Hours between session-keepalive beats. `0` or unset disables |

### Self-Hosted

```bash
git clone https://github.com/striderlabsdev/mcp-doordash
cd mcp-doordash
npm install
npm run build
npm start   # stdio
```

### Docker

The image serves Streamable HTTP on port 3000 and runs a **headed** Chromium against an Xvfb virtual framebuffer — DoorDash's bot detection is easier to trip in headless mode, and a framebuffer costs less than being blocked.

```bash
docker build -t mcp-doordash .

# Log in once on your own machine; this writes the cookies the container reads.
npm run build && npm run login

docker run -d --name doordash -p 3000:3000 \
  -e MCP_HTTP_TOKEN="$(openssl rand -hex 32)" \
  -v ~/.config/striderlabs-mcp-doordash:/secrets:ro \
  --shm-size=1g \
  mcp-doordash
```

Point a client at `http://127.0.0.1:3000/` with `Authorization: Bearer <token>`.

`--shm-size=1g` matters: Chromium's default 64 MB of shared memory in Docker causes tab crashes on heavy pages.

The container copies `/secrets/cookies.json` to a writable path at startup, so it can refresh the session as it runs. Those refreshes are lost on restart — DoorDash sessions expire, so re-run `npm run login` and restart the container when it goes stale.

`GET /healthz` returns 200 without a token for liveness probes. It reports only that the process is up, not that DoorDash still knows you — that's the heartbeat's job.

### Session heartbeat

An idle container's DoorDash session goes stale quietly, and you find out when you're hungry. Every `DOORDASH_HEARTBEAT_HOURS` (6 in the image) the server re-checks the session and re-saves the cookies, which keeps a rolling session alive and logs a clear warning once it can't be saved:

```
Heartbeat: DoorDash session is stale. Re-run `npm run login` and restart.
```

The check loads the auth-gated `/orders` page and sees where the redirect lands, rather than looking for a cookie by name — an expired session cookie is still a cookie, and trusting the name is how a dead session reports itself as healthy.

Each beat is jittered ±25% so the traffic isn't a metronome, and a beat is skipped entirely if any tool ran during the interval — those already refreshed the cookies, and the check navigates the single shared browser tab, which would strand a caller between `doordash_menu` and `doordash_add_to_cart`.

Consecutive failures double the wait, up to 24 hours. Nothing a beat does fixes a stale session or an IP DoorDash has started blocking, so beating at full rate is just more of whatever caused it. The warning above repeats on that slower schedule until you re-run `npm run login`.

For Kubernetes, `npm run login -- --secret-name doordash-cookies --namespace my-namespace` prints the `kubectl` command to create the Secret from those cookies. Mount it at `/secrets`.

### HTTP transport without Docker

Set `MCP_HTTP_PORT` and the server speaks Streamable HTTP instead of stdio:

```bash
MCP_HTTP_PORT=3000 MCP_HTTP_TOKEN="$(openssl rand -hex 32)" npm start
```

Without a framebuffer, either keep a display attached or set `DOORDASH_HEADLESS=1` and accept the higher chance of being flagged.

### What you are hosting

- **This server spends money.** Anyone who can reach the port and present the token can place orders on your account. The server refuses to start in HTTP mode without a token, and binds to loopback unless you change `MCP_HTTP_HOST` (the image sets `0.0.0.0`, so publish the port only where you trust the network, and put TLS in front of it if it leaves the host).
- **One DoorDash account, shared.** Cookies live in a single file, so every caller acts as whoever logged in. This is a personal deployment, not a multi-user service.
- **Calls are serialized.** All tools drive one browser tab, so concurrent requests queue rather than run in parallel.

## Architecture

### How We Connect
This connector uses browser automation (Playwright) to interact with DoorDash, because DoorDash doesn't have a public API. Here's why that's safe and reliable:

- **User-controlled:** Your agent only accesses your own DoorDash account
- **Session-based:** We store your login session securely, not your password
- **Change-aware:** We detect DoorDash UI changes and alert immediately
- **Fingerprinting:** We use realistic browser profiles to avoid bot detection
- **Rate-limited:** We respect DoorDash's infrastructure with appropriate delays

### Security
- Credentials stored encrypted in your local `.env` or secure vault
- Sessions isolated per user
- No data sent to third parties
- MIT Licensed — audit the code yourself

## Support

- 📖 [Full Strider Labs Docs](https://github.com/striderlabsdev/striderlabs)
- 🐛 [Report Issues](https://github.com/striderlabsdev/mcp-doordash/issues)
- 💬 [Discussions](https://github.com/striderlabsdev/mcp-doordash/discussions)
- 🌐 [Website](https://striderlabs.ai)
- 📧 [Email](mailto:hello@striderlabs.ai)

## Contributing

We welcome contributions! Areas of interest:
- Bug reports and fixes
- Feature requests (new restaurants, cuisines, etc.)
- Performance improvements
- Documentation enhancements

See [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines.

## License

MIT — Free to use, modify, and distribute. See [LICENSE](./LICENSE) for details.

---

**Built by Strider Labs** — Making AI agents actually useful.

[GitHub](https://github.com/striderlabsdev) | [Website](https://striderlabs.ai) | [Discord](https://discord.gg/openclaw)
