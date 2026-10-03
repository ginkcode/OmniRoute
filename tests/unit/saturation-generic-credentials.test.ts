/**
 * Generic saturation must read usage WITH the connection's credentials.
 *
 * The default path used to call getUsageForProvider({ id, provider }) with no
 * apiKey/accessToken, so every provider outside codex/bailian/claude got a
 * "key not available" message back and saturation silently failed open to 0.
 * Session stickiness then never released a draining account and headroom
 * routing could not tell accounts apart.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-saturation-generic-creds-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const coreDb = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const saturation = await import("../../src/lib/quota/saturationSignals.ts");
// Load the usage service up front: its import chain patches globalThis.fetch
// (proxyFetch), which would otherwise replace the mock on the first lazy load.
await import("../../open-sse/services/usage.ts");

const originalFetch = globalThis.fetch;
const seenAuth: string[] = [];

test.beforeEach(() => {
  saturation._clearSaturationCache();
  seenAuth.length = 0;
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
});

test.after(() => {
  globalThis.fetch = originalFetch;
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("getSaturation loads the connection's apiKey for generic providers", async () => {
  const conn = (await providersDb.createProviderConnection({
    provider: "nanogpt",
    authType: "apikey",
    name: "nano saturation",
    apiKey: "sk-nano-saturation",
  })) as { id: string };

  const value = await saturation.getSaturation(conn.id, "nanogpt", {
    unit: "percent",
    window: "5h",
  });

  assert.deepEqual(seenAuth, ["Bearer sk-nano-saturation"]);
  assert.ok(Math.abs(value - 0.7) < 1e-9, `expected 0.7 saturation, got ${value}`);
});

test("5h and weekly reads share one upstream usage call", async () => {
  const conn = (await providersDb.createProviderConnection({
    provider: "nanogpt",
    authType: "apikey",
    name: "nano dedupe",
    apiKey: "sk-nano-dedupe",
  })) as { id: string };

  await Promise.all([
    saturation.getSaturation(conn.id, "nanogpt", { unit: "percent", window: "5h" }),
    saturation.getSaturation(conn.id, "nanogpt", { unit: "percent", window: "weekly" }),
  ]);

  assert.equal(seenAuth.length, 1);
});

test("unknown connection fails open without an upstream call", async () => {
  const value = await saturation.getSaturation("conn-missing", "nanogpt", {
    unit: "percent",
    window: "5h",
  });
  assert.equal(value, 0);
  assert.equal(seenAuth.length, 0);
});
