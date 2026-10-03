/**
 * The quota cache background refresh must keep API-key connections fresh.
 *
 * refreshEntry used to delete every non-OAuth entry on its first refresh tick,
 * so quota data synced for API-key accounts (NanoGPT, GLM, Kimi, ...) vanished
 * five minutes after it was written and quota-aware routing ran blind until the
 * next providerLimits sync, long after the account had drained.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-quota-cache-apikey-refresh-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const coreDb = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");

const originalFetch = globalThis.fetch;
const seenAuth: string[] = [];

globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url).includes("nano-gpt.com/api/subscription/v1/usage")) {
    seenAuth.push(String(new Headers(init?.headers).get("authorization")));
    return new Response(
      JSON.stringify({
        active: true,
        dailyInputTokens: {
          used: 70,
          remaining: 30,
          percentUsed: 0.7,
          resetAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  throw new Error(`unexpected fetch ${String(url)}`);
}) as typeof fetch;

test.after(() => {
  quotaCache.stopBackgroundRefresh();
  mock.timers.reset();
  globalThis.fetch = originalFetch;
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function runOneRefreshTick(done: () => boolean) {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    quotaCache.startBackgroundRefresh();
    mock.timers.tick(60_000);
  } finally {
    quotaCache.stopBackgroundRefresh();
    mock.timers.reset();
  }
  for (let i = 0; i < 100 && !done(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function ageEntry(connectionId: string) {
  const entry = quotaCache.getQuotaCache(connectionId);
  assert.ok(entry, "entry should be cached before the refresh");
  entry.fetchedAt = Date.now() - 6 * 60 * 1000;
}

test("API-key connection with a usage API is refreshed, not dropped", async () => {
  const conn = (await providersDb.createProviderConnection({
    provider: "nanogpt",
    authType: "apikey",
    name: "nano refresh",
    apiKey: "sk-nano-refresh",
  })) as { id: string };

  quotaCache.setQuotaCache(conn.id, "nanogpt", {
    "Daily Tokens": { remainingPercentage: 90, resetAt: null },
  });
  ageEntry(conn.id);

  await runOneRefreshTick(
    () => quotaCache.getQuotaCache(conn.id)?.quotas["Daily Tokens"]?.remainingPercentage === 30
  );

  assert.deepEqual(seenAuth, ["Bearer sk-nano-refresh"]);
  const entry = quotaCache.getQuotaCache(conn.id);
  assert.ok(entry, "API-key entry must survive the refresh");
  assert.equal(entry.quotas["Daily Tokens"].remainingPercentage, 30);
  assert.ok(Date.now() - entry.fetchedAt < 60_000, "refresh must update fetchedAt");
});

test("API-key connection without usage data is still dropped", async () => {
  const conn = (await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "openai no usage",
    apiKey: "sk-openai-no-usage",
  })) as { id: string };

  quotaCache.markAccountExhaustedFrom429(conn.id, "openai");
  ageEntry(conn.id);

  await runOneRefreshTick(() => quotaCache.getQuotaCache(conn.id) === null);

  assert.equal(quotaCache.getQuotaCache(conn.id), null);
});
