/**
 * Regression: the vision-bridge SELF-LOOP must authenticate with a real
 * DB-backed API key, not the `sk_omniroute` sentinel.
 *
 * Root cause on runtime v3.8.49: `callVisionModelSingle` used
 * `resolvedApiKey || "sk_omniroute"` for the Authorization header of the
 * OmniRoute self-loop request. On instances with REQUIRE_API_KEY enabled the
 * runtime rejects `sk_omniroute` with 401 "Missing API key", so EVERY
 * vision-bridge describe call failed and image requests were never processed.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { resolveSelfLoopApiKey } =
  await import("../../../src/lib/guardrails/visionBridgeHelpers.ts");

test("does not reuse an upstream VISION_BRIDGE_API_KEY for self-loop auth", async () => {
  const previousVisionKey = process.env.VISION_BRIDGE_API_KEY;
  const previousOmniRouteKey = process.env.OMNIROUTE_API_KEY;
  const previousRouterKey = process.env.ROUTER_API_KEY;
  delete process.env.OMNIROUTE_API_KEY;
  delete process.env.ROUTER_API_KEY;
  process.env.VISION_BRIDGE_API_KEY = "sk-upstream-provider-key";
  try {
    const key = await resolveSelfLoopApiKey(async () => "sk-db-key");
    assert.strictEqual(key, "sk-db-key");
  } finally {
    if (previousVisionKey === undefined) delete process.env.VISION_BRIDGE_API_KEY;
    else process.env.VISION_BRIDGE_API_KEY = previousVisionKey;
    if (previousOmniRouteKey === undefined) delete process.env.OMNIROUTE_API_KEY;
    else process.env.OMNIROUTE_API_KEY = previousOmniRouteKey;
    if (previousRouterKey === undefined) delete process.env.ROUTER_API_KEY;
    else process.env.ROUTER_API_KEY = previousRouterKey;
  }
});

test("prefers OMNIROUTE_API_KEY for authenticated self-loop requests", async () => {
  const previousOmniRouteKey = process.env.OMNIROUTE_API_KEY;
  const previousVisionKey = process.env.VISION_BRIDGE_API_KEY;
  process.env.OMNIROUTE_API_KEY = "sk-omniroute-env";
  process.env.VISION_BRIDGE_API_KEY = "sk-upstream-vision";
  try {
    assert.strictEqual(await resolveSelfLoopApiKey(async () => "sk-db-key"), "sk-omniroute-env");
  } finally {
    if (previousOmniRouteKey === undefined) delete process.env.OMNIROUTE_API_KEY;
    else process.env.OMNIROUTE_API_KEY = previousOmniRouteKey;
    if (previousVisionKey === undefined) delete process.env.VISION_BRIDGE_API_KEY;
    else process.env.VISION_BRIDGE_API_KEY = previousVisionKey;
  }
});

test("falls back to the injected resolver (DB key) when no env key is set", async () => {
  const previousOmniRouteKey = process.env.OMNIROUTE_API_KEY;
  const previousRouterKey = process.env.ROUTER_API_KEY;
  delete process.env.OMNIROUTE_API_KEY;
  delete process.env.ROUTER_API_KEY;
  try {
    const key = await resolveSelfLoopApiKey(async () => "sk-real-db-key");
    assert.strictEqual(key, "sk-real-db-key");
  } finally {
    if (previousOmniRouteKey === undefined) delete process.env.OMNIROUTE_API_KEY;
    else process.env.OMNIROUTE_API_KEY = previousOmniRouteKey;
    if (previousRouterKey === undefined) delete process.env.ROUTER_API_KEY;
    else process.env.ROUTER_API_KEY = previousRouterKey;
  }
});

test("never returns the sk_omniroute sentinel when a real key is resolvable", async () => {
  const previousOmniRouteKey = process.env.OMNIROUTE_API_KEY;
  const previousRouterKey = process.env.ROUTER_API_KEY;
  delete process.env.OMNIROUTE_API_KEY;
  delete process.env.ROUTER_API_KEY;
  try {
    const key = await resolveSelfLoopApiKey(async () => "sk-db-key");
    assert.notStrictEqual(key, "sk_omniroute");
  } finally {
    if (previousOmniRouteKey === undefined) delete process.env.OMNIROUTE_API_KEY;
    else process.env.OMNIROUTE_API_KEY = previousOmniRouteKey;
    if (previousRouterKey === undefined) delete process.env.ROUTER_API_KEY;
    else process.env.ROUTER_API_KEY = previousRouterKey;
  }
});

test("falls back to sk_omniroute only when nothing else is available", async () => {
  const previousOmniRouteKey = process.env.OMNIROUTE_API_KEY;
  const previousRouterKey = process.env.ROUTER_API_KEY;
  delete process.env.OMNIROUTE_API_KEY;
  delete process.env.ROUTER_API_KEY;
  try {
    const key = await resolveSelfLoopApiKey(async () => "");
    assert.strictEqual(key, "sk_omniroute");
  } finally {
    if (previousOmniRouteKey === undefined) delete process.env.OMNIROUTE_API_KEY;
    else process.env.OMNIROUTE_API_KEY = previousOmniRouteKey;
    if (previousRouterKey === undefined) delete process.env.ROUTER_API_KEY;
    else process.env.ROUTER_API_KEY = previousRouterKey;
  }
});
