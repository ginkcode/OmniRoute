/**
 * usage/claude.ts — Claude (Anthropic OAuth + legacy org) usage fetcher + plan-label helper.
 *
 * Extracted from services/usage.ts (god-file decomposition): the Claude family — the API
 * config, the plan-label picker, the OAuth usage fetcher (getClaudeUsage) with its legacy
 * settings/org fallback (getClaudeUsageLegacy). Depends only on the sibling scalar/quota
 * leaves + Claude identity/cooldown helpers + safePercentage — no host coupling — so it
 * lives as a co-located provider leaf. usage.ts imports getClaudeUsage (dispatcher) +
 * getClaudePlanLabel (__testing). Behavior-preserving move.
 */

import { getClaudeCodeVersion, fetchClaudeBootstrap } from "../../executors/claudeIdentity.ts";
import {
  clearClaudeOauthUsage429,
  getClaudeOauthUsageRetryAt,
  isClaudeOauthUsageCoolingDown,
  markClaudeOauthUsage429,
  parseClaudeRetryAfterMs,
} from "../claudeUsageCooldown.ts";
import { toRecord } from "./scalars.ts";
import { normalizeClaudeUsageQuotas } from "./claudeQuota.ts";

// Claude API config
const CLAUDE_CONFIG = {
  oauthUsageUrl: "https://api.anthropic.com/api/oauth/usage",
  usageUrl: "https://api.anthropic.com/v1/organizations/{org_id}/usage",
  settingsUrl: "https://api.anthropic.com/v1/settings",
  apiVersion: "2023-06-01",
};

export function getClaudePlanLabel(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (
      !trimmed ||
      trimmed.toLowerCase() === "claude code" ||
      trimmed.toLowerCase() === "unknown"
    ) {
      continue;
    }
    return trimmed;
  }
  return null;
}

// Anthropic throttles /api/oauth/usage hard, and it is polled by several independent
// paths (quota fetcher, saturation signals, quota cache refresher, extra-usage sync,
// dashboard). Each one used to hit the endpoint on its own, which kept tokens in a
// permanent 429 loop. Successful results are shared per token for this long; a forced
// (manual dashboard) refresh skips the shared result but still honors the 429 cooldown.
const USAGE_CACHE_TTL_MS = 2 * 60_000;
const USAGE_CACHE_MAX_ENTRIES = 256;
// Upper bound for joining an in-flight request (the request itself aborts after 10s), so a
// request that never settles cannot block every later poll for the token.
const USAGE_INFLIGHT_MAX_AGE_MS = 15_000;

type ClaudeUsageResult = Awaited<ReturnType<typeof fetchClaudeUsage>>;

const usageCache = new Map<string, { data: ClaudeUsageResult; fetchedAt: number }>();
const usageInflight = new Map<string, { request: Promise<ClaudeUsageResult>; startedAt: number }>();

function rememberClaudeUsage(accessToken: string, data: ClaudeUsageResult) {
  usageCache.delete(accessToken);
  usageCache.set(accessToken, { data, fetchedAt: Date.now() });
  if (usageCache.size > USAGE_CACHE_MAX_ENTRIES) {
    const oldest = usageCache.keys().next().value;
    if (oldest !== undefined) usageCache.delete(oldest);
  }
}

function claudeUsageRateLimited(accessToken: string) {
  const retryAt = getClaudeOauthUsageRetryAt(accessToken);
  const when = retryAt ? ` until ${new Date(retryAt).toISOString()}` : "";
  return {
    message: `Claude connected. Usage endpoint is rate-limited by Anthropic; retrying${when}.`,
    bootstrap: null,
  };
}

/**
 * Claude Usage - Try to fetch from Anthropic API
 */
export async function getClaudeUsage(
  accessToken?: string,
  options: { forceRefresh?: boolean } = {}
) {
  if (!accessToken) {
    return { message: "Claude connected. Access token not available.", bootstrap: null };
  }

  if (!options.forceRefresh) {
    const cached = usageCache.get(accessToken);
    if (cached && Date.now() - cached.fetchedAt < USAGE_CACHE_TTL_MS) return { ...cached.data };
  }

  // Concurrent polls for the same token share one upstream request.
  const inflight = usageInflight.get(accessToken);
  if (inflight && Date.now() - inflight.startedAt < USAGE_INFLIGHT_MAX_AGE_MS) {
    return { ...(await inflight.request) };
  }

  const entry = { request: fetchClaudeUsage(accessToken), startedAt: Date.now() };
  entry.request
    .finally(() => {
      if (usageInflight.get(accessToken) === entry) usageInflight.delete(accessToken);
    })
    .catch(() => {});
  usageInflight.set(accessToken, entry);
  return { ...(await entry.request) };
}

async function fetchClaudeUsage(accessToken: string) {
  // Skip OAuth usage call while this token is cooling down from a recent 429
  // (chat with the same token still works — only the quota endpoint is throttled).
  if (isClaudeOauthUsageCoolingDown(accessToken)) {
    return claudeUsageRateLimited(accessToken);
  }

  // Refresh bootstrap in parallel; best-effort, failure non-fatal.
  const bootstrapPromise = fetchClaudeBootstrap(accessToken).catch(() => null);
  try {
    // Real CLI uses axios here, not Stainless — UA is `claude-code/<version>`
    // (not `claude-cli/...`) and the shape is simpler than /v1/messages.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    let oauthResponse;
    try {
      oauthResponse = await fetch(CLAUDE_CONFIG.oauthUsageUrl, {
        method: "GET",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Accept-Encoding": "gzip, compress, deflate, br",
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": `claude-code/${getClaudeCodeVersion()}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (oauthResponse.ok) {
      const data = toRecord(await oauthResponse.json());
      const { quotas, modelQuotas } = normalizeClaudeUsageQuotas(data);

      const bootstrap = await bootstrapPromise;
      const plan =
        getClaudePlanLabel(
          typeof data.tier === "string" ? data.tier : null,
          typeof data.plan === "string" ? data.plan : null,
          typeof data.subscription_type === "string" ? data.subscription_type : null,
          bootstrap?.organization_rate_limit_tier
        ) ?? undefined;

      const usage = {
        ...(plan ? { plan } : {}),
        quotas,
        modelQuotas,
        extraUsage: data.extra_usage ?? null,
        bootstrap,
      };
      clearClaudeOauthUsage429(accessToken);
      rememberClaudeUsage(accessToken, usage);
      return usage;
    }

    // Cool down OAuth usage polling after a 429 (quota endpoint only — chat is unaffected).
    // The legacy settings/org fallback cannot report plan windows for an OAuth token, so
    // surface the throttle instead of its misleading "requires admin access" message.
    if (oauthResponse.status === 429) {
      markClaudeOauthUsage429(
        accessToken,
        Date.now(),
        undefined,
        parseClaudeRetryAfterMs(oauthResponse.headers.get("retry-after"))
      );
      console.warn("[Claude Usage] OAuth endpoint returned 429, cooling down");
      return { ...claudeUsageRateLimited(accessToken), bootstrap: await bootstrapPromise };
    }

    // Fallback: OAuth endpoint returned non-OK, try legacy settings/org endpoint
    console.warn(
      `[Claude Usage] OAuth endpoint returned ${oauthResponse.status}, falling back to legacy`
    );
    const legacy = await getClaudeUsageLegacy(accessToken);
    return { ...legacy, bootstrap: await bootstrapPromise };
  } catch (error) {
    return {
      message: `Claude connected. Unable to fetch usage: ${(error as Error).message}`,
      bootstrap: await bootstrapPromise,
    };
  }
}

/** Test-only: drop shared usage results and in-flight requests. */
export function _resetClaudeUsageCache(): void {
  usageCache.clear();
  usageInflight.clear();
}

/**
 * Legacy Claude usage fetcher for API key / org admin users.
 * Uses /v1/settings + /v1/organizations/{org_id}/usage endpoints.
 */
async function getClaudeUsageLegacy(accessToken?: string) {
  try {
    const settingsResponse = await fetch(CLAUDE_CONFIG.settingsUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-version": CLAUDE_CONFIG.apiVersion,
      },
    });

    if (settingsResponse.ok) {
      const settings = toRecord(await settingsResponse.json());

      const organizationId =
        typeof settings.organization_id === "string" ? settings.organization_id : "";
      if (organizationId) {
        const usageResponse = await fetch(
          CLAUDE_CONFIG.usageUrl.replace("{org_id}", organizationId),
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "anthropic-version": CLAUDE_CONFIG.apiVersion,
            },
          }
        );

        if (usageResponse.ok) {
          const usage = await usageResponse.json();
          return {
            plan: settings.plan || "Unknown",
            organization: settings.organization_name,
            quotas: usage,
          };
        }
      }

      return {
        plan: settings.plan || "Unknown",
        organization: settings.organization_name,
        message: "Claude connected. Usage details require admin access.",
      };
    }

    return { message: "Claude connected. Usage API requires admin permissions." };
  } catch (error) {
    return { message: `Claude connected. Unable to fetch usage: ${(error as Error).message}` };
  }
}
