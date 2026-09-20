/**
 * DoorDash Authentication & Session Management
 * 
 * Handles cookie persistence and login state detection.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { BrowserContext, Cookie } from "patchright";

// Default cookie storage location
const CONFIG_DIR = join(homedir(), ".config", "striderlabs-mcp-doordash");
const COOKIES_FILE = join(CONFIG_DIR, "cookies.json");
const PROFILE_DIR = join(CONFIG_DIR, "chrome-profile");

export interface AuthState {
  isLoggedIn: boolean;
  email?: string;
  firstName?: string;
  lastName?: string;
}

/**
 * Ensure config directory exists
 */
function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * Save cookies from browser context to disk
 */
export async function saveCookies(context: BrowserContext): Promise<void> {
  const cookies = await context.cookies();
  try {
    ensureConfigDir();
    writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
  } catch (error) {
    // Every tool refreshes cookies after it runs. A read-only cookie store (a
    // Secret mounted straight onto the file) must not fail the order that just
    // succeeded - the in-memory session keeps working until the process exits.
    console.error("Could not persist cookies:", error);
  }
}

/**
 * Load cookies from disk and add to browser context
 */
export async function loadCookies(context: BrowserContext): Promise<boolean> {
  if (!existsSync(COOKIES_FILE)) {
    return false;
  }

  try {
    const cookiesData = readFileSync(COOKIES_FILE, "utf-8");
    const cookies: Cookie[] = JSON.parse(cookiesData);
    
    if (cookies.length > 0) {
      await context.addCookies(cookies);
      return true;
    }
  } catch (error) {
    console.error("Failed to load cookies:", error);
  }
  
  return false;
}

/**
 * Clear stored cookies
 */
export function clearCookies(): void {
  if (existsSync(COOKIES_FILE)) {
    writeFileSync(COOKIES_FILE, "[]");
  }
}

/**
 * Check if we have stored cookies
 */
export function hasStoredCookies(): boolean {
  if (!existsSync(COOKIES_FILE)) {
    return false;
  }
  
  try {
    const cookiesData = readFileSync(COOKIES_FILE, "utf-8");
    const cookies = JSON.parse(cookiesData);
    return Array.isArray(cookies) && cookies.length > 0;
  } catch {
    return false;
  }
}

/**
 * Chrome profile directory. Patchright is least detectable driving a real
 * Chrome with a persistent profile, and the profile keeps the session across
 * restarts on its own - cookies.json stays because it is what ships to a
 * container, not because the local browser needs it.
 *
 * Chrome locks a profile to one process, and a second one fails with an
 * unhelpful "target has been closed". DOORDASH_PROFILE_DIR lets a second
 * browser on the same machine - the login helper - keep out of the way.
 */
export function getProfilePath(): string {
  return process.env.DOORDASH_PROFILE_DIR || PROFILE_DIR;
}

/**
 * Get the path where cookies are stored
 */
export function getCookiesPath(): string {
  return COOKIES_FILE;
}
