/**
 * Claude OAuth usage throttling — `/api/oauth/usage` is rate-limited by Anthropic and is
 * polled by several independent OmniRoute paths (quota fetcher, saturation signals, quota
 * cache refresher, extra-usage sync, dashboard). Without a shared cache each poller hit the
 * endpoint on its own, so the token sat in a permanent 429 → 3 min cooldown → 429 loop and
 * the dashboard's "Refresh now" kept falling back to the stale cache (clock icon).
 */
import test from "node:test";
import assert from "node:assert/strict";

const { getClaudeUsage, _resetClaudeUsageCache } =
  await import("../../open-sse/services/usage/claude.ts");
const { OAUTH_USAGE_429_COOLDOWN_MS, _resetClaudeOauthUsageCooldown, getClaudeOauthUsageRetryAt } =
  await import("../../open-sse/services/claudeUsageCooldown.ts");

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const calls: string[] = [];
let clock = 1_800_000_000_000;

type UsageReply = { status: number; headers?: Record<string, string> };
let nextUsageReplies: UsageReply[] = [];

function usageBody(sessionPct: number) {
  return {
    five_hour: { utilization: sessionPct, resets_at: "2099-09-10T14:00:00Z" },
    seven_day: { utilization: 34, resets_at: "2099-09-16T13:00:00Z" },
  };
}

function installFetch(sessionPct = 12) {
  globalThis.fetch = (async (url: string | URL) => {
    const href = String(url);
    calls.push(href);
    if (href.endsWith("/api/oauth/usage")) {
      const reply = nextUsageReplies.shift() ?? { status: 200 };
      if (reply.status !== 200) {
        return new Response("rate limited", { status: reply.status, headers: reply.headers });
      }
      return Response.json(usageBody(sessionPct));
    }
    // bootstrap + legacy settings endpoints
    return new Response(null, { status: 503 });
  }) as typeof fetch;
}

const usageCalls = () => calls.filter((href) => href.endsWith("/api/oauth/usage")).length;
const legacyCalls = () => calls.filter((href) => href.endsWith("/v1/settings")).length;

test.beforeEach(() => {
  calls.length = 0;
  nextUsageReplies = [];
  clock = 1_800_000_000_000;
  Date.now = () => clock;
  _resetClaudeUsageCache();
  _resetClaudeOauthUsageCooldown();
  installFetch();
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
});

test("repeated background polls within the TTL share one upstream usage request", async () => {
  const first = await getClaudeUsage("tok-cache");
  clock += 30_000;
  const second = await getClaudeUsage("tok-cache");

  assert.equal(usageCalls(), 1);
  assert.equal(second.quotas["session (5h)"].used, 12);
  assert.deepEqual(second.quotas, first.quotas);
});

test("the shared cache expires and is per token", async () => {
  await getClaudeUsage("tok-a");
  await getClaudeUsage("tok-b");
  assert.equal(usageCalls(), 2);

  clock += 10 * 60_000;
  await getClaudeUsage("tok-a");
  assert.equal(usageCalls(), 3);
});

test("concurrent polls for the same token are collapsed into one request", async () => {
  const results = await Promise.all([
    getClaudeUsage("tok-flight"),
    getClaudeUsage("tok-flight"),
    getClaudeUsage("tok-flight", { forceRefresh: true }),
  ]);
  assert.equal(usageCalls(), 1);
  for (const usage of results) assert.equal(usage.quotas["session (5h)"].used, 12);
});

test("a request that never settles does not block later polls forever", async () => {
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(String(url));
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  void getClaudeUsage("tok-hung");
  await Promise.resolve();

  clock += 20_000;
  installFetch();
  const usage = await getClaudeUsage("tok-hung");
  assert.equal(usage.quotas["session (5h)"].used, 12);
  assert.equal(usageCalls(), 2);
});

test("a forced (manual) refresh bypasses the success cache", async () => {
  await getClaudeUsage("tok-force");
  installFetch(55);
  const forced = await getClaudeUsage("tok-force", { forceRefresh: true });

  assert.equal(usageCalls(), 2);
  assert.equal(forced.quotas["session (5h)"].used, 55);
});

test("a 429 honors Retry-After and is not retried while cooling down, even when forced", async () => {
  nextUsageReplies = [{ status: 429, headers: { "retry-after": "600" } }];
  const limited = await getClaudeUsage("tok-429");

  assert.equal(limited.quotas, undefined);
  assert.match(limited.message, /rate.?limit/i);
  assert.equal(getClaudeOauthUsageRetryAt("tok-429"), clock + 600_000);

  clock += 5 * 60_000; // past the 3 min default, still inside Retry-After
  const forced = await getClaudeUsage("tok-429", { forceRefresh: true });
  assert.equal(usageCalls(), 1, "no upstream usage call during the cooldown");
  assert.match(forced.message, /rate.?limit/i);
  // The legacy settings/org fallback only ever says "requires admin access" for an OAuth
  // token, which hid the real reason from the dashboard.
  assert.equal(legacyCalls(), 0);
});

test("a 429 right after the cooldown expired backs off exponentially; success resets it", async () => {
  nextUsageReplies = [{ status: 429 }];
  await getClaudeUsage("tok-backoff");
  assert.equal(getClaudeOauthUsageRetryAt("tok-backoff"), clock + OAUTH_USAGE_429_COOLDOWN_MS);

  clock += OAUTH_USAGE_429_COOLDOWN_MS + 1_000;
  nextUsageReplies = [{ status: 429 }];
  await getClaudeUsage("tok-backoff");
  assert.equal(getClaudeOauthUsageRetryAt("tok-backoff"), clock + 2 * OAUTH_USAGE_429_COOLDOWN_MS);

  clock += 2 * OAUTH_USAGE_429_COOLDOWN_MS + 1_000;
  const recovered = await getClaudeUsage("tok-backoff");
  assert.equal(recovered.quotas["session (5h)"].used, 12);
  assert.equal(getClaudeOauthUsageRetryAt("tok-backoff"), null);

  clock += 10 * 60_000;
  nextUsageReplies = [{ status: 429 }];
  await getClaudeUsage("tok-backoff");
  assert.equal(getClaudeOauthUsageRetryAt("tok-backoff"), clock + OAUTH_USAGE_429_COOLDOWN_MS);
});

test("an HTTP-date Retry-After is honored too", async () => {
  const retryAt = clock + 20 * 60_000;
  nextUsageReplies = [{ status: 429, headers: { "retry-after": new Date(retryAt).toUTCString() } }];
  await getClaudeUsage("tok-date");
  assert.equal(getClaudeOauthUsageRetryAt("tok-date"), retryAt);
});

test("non-429 failures still fall back to the legacy settings endpoint", async () => {
  nextUsageReplies = [{ status: 500 }];
  await getClaudeUsage("tok-500");
  assert.equal(legacyCalls(), 1);
  assert.equal(getClaudeOauthUsageRetryAt("tok-500"), null);
});
