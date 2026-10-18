/**
 * Per-token cooldown for the Claude OAuth usage endpoint
 * (`https://api.anthropic.com/api/oauth/usage`).
 *
 * Anthropic rate-limits this quota endpoint independently of `/v1/messages`.
 * When polled from multiple connections at once (dashboard auto-refresh + the
 * combo health-scheduler), it spams `429` and that surfaces as noisy provider
 * errors plus increased upstream load. Chat with the same token still works.
 *
 * We track a per-access-token "skip until" timestamp. When we see a `429`,
 * we suppress further OAuth-usage polls for that token until the cooldown
 * expires. The cooldown honors the upstream `Retry-After` hint, and a 429 that
 * arrives right after the previous cooldown expired doubles the window (capped)
 * so a persistently throttled token stops re-probing every 3 minutes. A
 * successful poll clears the backoff.
 *
 * Pure helpers (no fetch, no timers) keep this TDD-friendly.
 *
 * Inspired-by upstream 9router commit `79df34ca`.
 */

export const OAUTH_USAGE_429_COOLDOWN_MS = 180_000; // 3 minutes
export const OAUTH_USAGE_429_MAX_COOLDOWN_MS = 30 * 60_000;

type CooldownEntry = { until: number; strikes: number };

const oauthCooldown = new Map<string, CooldownEntry>();

/** Returns true while `accessToken` is still inside its 429 cooldown window. */
export function isClaudeOauthUsageCoolingDown(
  accessToken: string | undefined,
  now: number = Date.now()
): boolean {
  if (!accessToken) return false;
  const entry = oauthCooldown.get(accessToken);
  if (entry === undefined) return false;
  if (entry.until > now) return true;
  // Lazy GC once the backoff memory is also stale — keeps the Map bounded by active tokens.
  if (now - entry.until > OAUTH_USAGE_429_COOLDOWN_MS) oauthCooldown.delete(accessToken);
  return false;
}

/** Epoch ms when `accessToken` may poll the usage endpoint again, or null when not cooling. */
export function getClaudeOauthUsageRetryAt(
  accessToken: string | undefined,
  now: number = Date.now()
): number | null {
  if (!accessToken || !isClaudeOauthUsageCoolingDown(accessToken, now)) return null;
  return oauthCooldown.get(accessToken)?.until ?? null;
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into a delay in ms. */
export function parseClaudeRetryAfterMs(
  value: string | null | undefined,
  now: number = Date.now()
): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - now);
}

/**
 * Record a 429 from the OAuth usage endpoint for `accessToken`. `retryAfterMs` (from the
 * upstream header) wins when it is longer than the computed backoff.
 */
export function markClaudeOauthUsage429(
  accessToken: string | undefined,
  now: number = Date.now(),
  cooldownMs: number = OAUTH_USAGE_429_COOLDOWN_MS,
  retryAfterMs: number | null = null
): void {
  if (!accessToken) return;
  const previous = oauthCooldown.get(accessToken);
  let strikes = 1;
  if (previous) {
    if (previous.until > now) {
      // Concurrent poll that raced the first 429 — keep the current window.
      strikes = previous.strikes;
    } else if (now - previous.until <= OAUTH_USAGE_429_COOLDOWN_MS) {
      // Throttled again right after the cooldown ended: the window was too short.
      strikes = previous.strikes + 1;
    }
  }
  const backoffMs = Math.min(cooldownMs * 2 ** (strikes - 1), OAUTH_USAGE_429_MAX_COOLDOWN_MS);
  // Cap the upstream hint too, so one bogus header cannot hide usage for hours.
  const hintMs = Math.min(retryAfterMs ?? 0, OAUTH_USAGE_429_MAX_COOLDOWN_MS);
  const until = Math.max(now + Math.max(backoffMs, hintMs), previous?.until ?? 0);
  oauthCooldown.set(accessToken, { until, strikes });
}

/** A successful usage poll ends any cooldown/backoff for `accessToken`. */
export function clearClaudeOauthUsage429(accessToken: string | undefined): void {
  if (accessToken) oauthCooldown.delete(accessToken);
}

/** Test-only: clear all entries. */
export function _resetClaudeOauthUsageCooldown(): void {
  oauthCooldown.clear();
}
