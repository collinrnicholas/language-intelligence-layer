// ─── Loupe Client Configuration ──────────────────────────────────
//
// The client authenticates to the Loupe gateway only. It never reads model
// provider credentials — those exist solely inside the gateway process.
// Configuration resolves from ~/.loupe/config/client.json, with env fallback
// (dev only) for LOUPE_API_URL and LOUPE_DEV_TOKEN.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface LoupeClientConfig {
  apiUrl: string;
  authToken?: string;
  mode: 'cloud' | 'local';
}

const DEFAULT_API_URL = 'https://api.loupe.dev';
const CONFIG_PATH = join(homedir(), '.loupe', 'config', 'client.json');

/**
 * Resolve client config.
 *
 * Order (first wins):
 *   1. ~/.loupe/config/client.json  → { apiUrl, authToken, mode }
 *   2. env fallback (local dev only): LOUPE_API_URL, LOUPE_DEV_TOKEN
 *   3. built-in default cloud endpoint
 */
export function loadClientConfig(): LoupeClientConfig {
  let file: Partial<LoupeClientConfig> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      file = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Partial<LoupeClientConfig>;
    } catch {
      // Malformed config — fall through to env/defaults rather than crash.
    }
  }

  const apiUrl = (file.apiUrl || process.env.LOUPE_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
  const authToken = file.authToken || process.env.LOUPE_DEV_TOKEN || undefined;
  const mode: 'cloud' | 'local' = file.mode || (isLocal(apiUrl) ? 'local' : 'cloud');

  return { apiUrl, authToken, mode };
}

function isLocal(url: string): boolean {
  return /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
}
