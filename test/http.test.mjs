/**
 * Smoke test for the HTTP transport: the bearer-token boundary, a real
 * tools/list over Streamable HTTP, and the mutex that keeps concurrent
 * callers from interleaving on the single browser tab.
 *
 * Requires a build first: npm run build
 * Usage: node test/http.test.mjs
 */

import assert from "node:assert/strict";

const PORT = 39217;
const TOKEN = "test-token";
const URL = `http://127.0.0.1:${PORT}/mcp`;

process.env.MCP_HTTP_PORT = String(PORT);
process.env.MCP_HTTP_TOKEN = TOKEN;

const { serialize, startHeartbeat, noteToolActivity } = await import("../dist/index.js");
const { isAuthedUrl } = await import("../dist/browser.js");

// --- session probe ----------------------------------------------------------
// Real URLs: the second is where /orders lands with a dead session (prompt=none
// silent SSO falls through to the login form).
assert.ok(isAuthedUrl("https://www.doordash.com/orders/"));
assert.ok(!isAuthedUrl("https://identity.doordash.com/auth?client_id=1666519390426295040&prompt=none&redirect_uri=https%3A%2F%2Fwww.doordash.com%2Fpost-login%2F"));
assert.ok(!isAuthedUrl("https://www.doordash.com/consumer/login/"));
assert.ok(!isAuthedUrl("https://doordash.com.evil.example/orders/"));

// --- mutex -----------------------------------------------------------------
const log = [];
const slow = () =>
  serialize(async () => {
    log.push("a-start");
    await new Promise((r) => setTimeout(r, 50));
    log.push("a-end");
  });
const fast = () =>
  serialize(async () => {
    log.push("b");
  });
await Promise.all([slow(), fast()]);
assert.deepEqual(log, ["a-start", "a-end", "b"], "second call ran before the first finished");

// A rejected task must not wedge the queue for everyone after it.
await assert.rejects(serialize(async () => {
  throw new Error("boom");
}));
assert.equal(await serialize(async () => "alive"), "alive");

// --- heartbeat --------------------------------------------------------------
// 0.0005h = 1.8s nominal, so a couple of beats land inside the test.
const HOURS = 0.0005;
const NOMINAL_MS = HOURS * 3600_000;
const beatAt = [];
let beats = 0;
startHeartbeat(HOURS, async () => {
  beats++;
  beatAt.push(Date.now());
  return { isLoggedIn: true };
});

const t0 = Date.now();
while (beats < 3 && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 25));
assert.ok(beats >= 3, `heartbeat did not fire while idle (beats=${beats})`);

// Jitter keeps the beat off a fixed cadence, within +/-25% of nominal.
// 250ms of slack for timer and probe overhead.
const gaps = beatAt.slice(1).map((t, i) => t - beatAt[i]);
for (const gap of gaps) {
  assert.ok(
    gap >= NOMINAL_MS * 0.75 && gap <= NOMINAL_MS * 1.25 + 250,
    `beat gap ${gap}ms outside +/-25% of ${NOMINAL_MS}ms`
  );
}
assert.ok(new Set(gaps).size > 1, "beats arrived on a fixed cadence - jitter is not applied");

// A tool call during the interval must suppress the next beat: checkAuth
// navigates the shared tab and would strand a caller mid-flow.
const before = beats;
const busyUntil = Date.now() + 4000;
while (Date.now() < busyUntil) {
  noteToolActivity();
  await new Promise((r) => setTimeout(r, 100));
}
assert.equal(beats, before, `heartbeat fired while tools were active (${beats - before} beats)`);

// ...and resumes once things go quiet again.
const afterBusy = beats;
const quietUntil = Date.now() + 8000;
while (beats === afterBusy && Date.now() < quietUntil) await new Promise((r) => setTimeout(r, 50));
assert.ok(beats > afterBusy, "heartbeat did not resume after the tools went quiet");

// --- heartbeat backoff ------------------------------------------------------
// A failing probe must not keep beating at full rate: nothing a beat does fixes
// a stale session, so each consecutive failure doubles the wait.
const FAIL_HOURS = 0.0002; // 0.72s nominal
const failAt = [];
startHeartbeat(FAIL_HOURS, async () => {
  failAt.push(Date.now());
  return { isLoggedIn: false };
});
const failStart = Date.now();
while (failAt.length < 4 && Date.now() - failStart < 20000) await new Promise((r) => setTimeout(r, 25));
assert.ok(failAt.length >= 4, `backoff heartbeat did not beat enough (${failAt.length})`);

// The first beat fires at 1x, so the observed gaps are already 2x, 4x, 4x.
// Jitter is +/-25%, so the 2x and 4x bands cannot overlap: the growth is real,
// and the cap holding is what stops a blocked container backing off to never.
const FAIL_NOMINAL = FAIL_HOURS * 3600_000;
const failGaps = failAt.slice(1, 4).map((t, i) => t - failAt[i]);
assert.ok(failGaps[1] > failGaps[0], `failing beats did not back off: ${failGaps}`);
assert.ok(
  failGaps.every((g) => g <= FAIL_NOMINAL * 4 * 1.25 + 500),
  `backoff blew past the 4x cap: ${failGaps}`
);

// --- http ------------------------------------------------------------------
const post = (body, token) =>
  fetch(URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const init = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  },
};

// Wait for listen().
for (let i = 0; ; i++) {
  try {
    await post(init, TOKEN);
    break;
  } catch (e) {
    if (i > 50) throw e;
    await new Promise((r) => setTimeout(r, 100));
  }
}

assert.equal((await post(init)).status, 401, "unauthenticated request was not rejected");
assert.equal((await post(init, "wrong")).status, 401, "bad token was not rejected");
assert.equal((await post(init, TOKEN)).status, 200);

const health = await fetch(`http://127.0.0.1:${PORT}/healthz`);
assert.equal(health.status, 200, "health probe should not need a token");

const res = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, TOKEN);
assert.equal(res.status, 200);
const tools = (await res.json()).result.tools.map((t) => t.name);
assert.ok(tools.includes("doordash_checkout"), `unexpected tool list: ${tools}`);

console.log(
  `ok - mutex serializes, heartbeat beat ${beats}x and idled correctly, ` +
    `token enforced, healthz open, ${tools.length} tools served over HTTP`
);
process.exit(0);
