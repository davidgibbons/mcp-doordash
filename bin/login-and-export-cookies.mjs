#!/usr/bin/env node

/**
 * Local helper for headless/k8s deployments.
 *
 * Opens a real, visible browser on your machine, lets you log in to DoorDash
 * once, then saves the session cookies to the same file the MCP server reads
 * (~/.config/striderlabs-mcp-doordash/cookies.json) and prints a ready-to-run
 * `kubectl` command to ship that file into your cluster as a Secret.
 *
 * Requires a build first: `npm run build`
 * Usage: node bin/login-and-export-cookies.mjs [--secret-name NAME] [--namespace NS]
 */

// Forced headed: this flow only works if you can see the browser, whatever
// the environment says. Both are read when the browser launches, below, not
// at import - ESM hoists the imports above these assignments.
process.env.DOORDASH_HEADLESS = "0";
// Own profile, because Chrome locks one to a single process and a server
// already running on this machine holds the default.
process.env.DOORDASH_PROFILE_DIR ||= join(
  dirname(getCookiesPath()),
  "chrome-profile-login"
);

import { dirname, join } from "node:path";
import { getCookiesPath } from "../dist/auth.js";
import { getPage, sessionIsLive, isAuthedUrl, cleanup } from "../dist/browser.js";

const DOORDASH_BASE_URL = "https://www.doordash.com";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

function parseArgs(argv) {
  const opts = { secretName: "doordash-cookies", namespace: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--secret-name") opts.secretName = argv[++i];
    else if (argv[i] === "--namespace") opts.namespace = argv[++i];
  }
  return opts;
}

// Weak on purpose: used only to spot that the login form is gone, so polling
// never navigates and never interrupts an in-progress email/OTP entry.
// sessionIsLive() is what actually decides, once below.
async function signInGone(page) {
  const signInVisible = await page
    .locator('button:has-text("Sign In"), a:has-text("Sign In"), text="Sign in or Sign up"')
    .first()
    .isVisible()
    .catch(() => false);
  return !signInVisible;
}

async function main() {
  const { secretName, namespace } = parseArgs(process.argv.slice(2));
  const cookiesPath = getCookiesPath();

  // The server's own launcher, so you log in through the same stealth setup
  // it uses. cookies.json is the handoff; the profile stays separate.
  const page = await getPage();

  await page.goto(`${DOORDASH_BASE_URL}/consumer/login`, { waitUntil: "domcontentloaded" });
  console.log("Log in to DoorDash in the browser window that just opened...");

  const start = Date.now();
  let loggedIn = false;
  // Poll the live page without forcing navigation, so an in-progress email/OTP
  // entry never gets interrupted mid-flow.
  while (Date.now() - start < LOGIN_TIMEOUT_MS) {
    await page.waitForTimeout(4000);
    // /consumer/login redirects to identity.doordash.com, so "are we still on
    // the login URL?" has to ask about the host, not a fixed path.
    loggedIn = isAuthedUrl(page.url()) && (await signInGone(page));
    if (loggedIn) break;
  }

  if (!loggedIn) {
    console.error("Timed out waiting for login.");
    await cleanup();
    process.exit(1);
  }

  // Then prove the session actually works, rather than trusting a missing button.
  if (!(await sessionIsLive(page))) {
    console.error("Login did not persist - please try again.");
    await cleanup();
    process.exit(1);
  }

  // cleanup() saves the cookies on its way out.
  await cleanup();

  console.log(`\nLogged in. Cookies saved to: ${cookiesPath}\n`);
  console.log("Run this to create/update the k8s Secret:\n");
  const nsFlag = namespace ? ` --namespace ${namespace}` : "";
  console.log(
    `kubectl create secret generic ${secretName}${nsFlag} --from-file=cookies.json=${cookiesPath} --dry-run=client -o yaml | kubectl apply -f -\n`
  );
  console.log(
    "DoorDash sessions expire - re-run this script and re-run the command above whenever the container's session goes stale."
  );

  process.exit(0);
}

main().catch((error) => {
  console.error("Failed to export cookies:", error);
  process.exit(1);
});
