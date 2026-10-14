import test from "node:test";
import assert from "node:assert/strict";

const utils =
  await import("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.tsx");

const GEMINI_RESET = "2026-10-14T17:22:36.000Z";
const CLAUDE_RESET = "2026-10-14T20:15:14.000Z";

function geminiQuota(remainingPercentage = 97.2) {
  return {
    used: Math.round(1000 - remainingPercentage * 10),
    total: 1000,
    resetAt: GEMINI_RESET,
    remainingPercentage,
    fractionReported: true,
    quotaSource: "retrieveUserQuota",
  };
}

function claudeQuota() {
  return {
    used: 0,
    total: 1000,
    resetAt: CLAUDE_RESET,
    remainingPercentage: 100,
    fractionReported: true,
    quotaSource: "fetchAvailableModels",
  };
}

// Shape of a live Pro-tier Antigravity account: one Gemini pool, one Claude + GPT-OSS pool,
// the two weekly buckets and the credit balance.
function liveAccount() {
  return {
    quotas: {
      "gemini-3.8-flash-tiered": geminiQuota(),
      "gemini-3.5-flash-lite": geminiQuota(),
      "gemini-3.1-flash-image": geminiQuota(),
      "gemini-3-flash": geminiQuota(),
      "claude-opus-5-5-high": claudeQuota(),
      "claude-sonnet-5-5-low": claudeQuota(),
      "gpt-oss-120b-medium": claudeQuota(),
      gemini_weekly: { used: 204, total: 1000, remainingPercentage: 79.6, resetAt: GEMINI_RESET },
      claude_gpt_weekly: { used: 0, total: 1000, remainingPercentage: 100, resetAt: CLAUDE_RESET },
      credits: { remaining: 42 },
    },
  };
}

const rowKey = (q: { modelKey?: string; name: string }) => q.modelKey || q.name;

test("Antigravity models that share an upstream pool render as one row per pool", () => {
  const quotas = utils.parseQuotaData("antigravity", liveAccount());

  assert.deepEqual(quotas.map(rowKey).sort(), [
    "claude_gpt_models",
    "claude_gpt_weekly",
    "credits",
    "gemini_models",
    "gemini_weekly",
  ]);

  const gemini = quotas.find((q) => q.name === "gemini_models");
  assert.equal(gemini.remainingPercentage, 97.2);
  assert.equal(gemini.resetAt, GEMINI_RESET);
  assert.deepEqual(gemini.memberModelKeys, [
    "gemini-3.8-flash-tiered",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-image",
    "gemini-3-flash",
  ]);

  const claude = quotas.find((q) => q.name === "claude_gpt_models");
  assert.equal(claude.remainingPercentage, 100);
  assert.deepEqual(claude.memberModelKeys, [
    "claude-opus-5-5-high",
    "claude-sonnet-5-5-low",
    "gpt-oss-120b-medium",
  ]);

  assert.equal(utils.formatQuotaLabel("gemini_models"), "Gemini Models");
  assert.equal(utils.formatQuotaLabel("claude_gpt_models"), "Claude & GPT Models");
});

test("the agy provider groups its per-model rows the same way", () => {
  const quotas = utils.parseQuotaData("agy", liveAccount());
  assert.ok(quotas.some((q) => q.name === "gemini_models"));
  assert.ok(!quotas.some((q) => q.modelKey === "gemini-3-flash"));
});

test("a family whose models report different quotas keeps one row per model", () => {
  const data = liveAccount();
  data.quotas["gemini-3-flash"] = geminiQuota(40);
  const quotas = utils.parseQuotaData("antigravity", data);

  assert.ok(!quotas.some((q) => q.name === "gemini_models"));
  assert.ok(quotas.some((q) => q.modelKey === "gemini-3-flash" && q.remainingPercentage === 40));
  assert.ok(quotas.some((q) => q.modelKey === "gemini-3.5-flash-lite"));
  // The Claude pool is unaffected by the Gemini split.
  assert.ok(quotas.some((q) => q.name === "claude_gpt_models"));
});

test("a family with a single model keeps its own per-model row", () => {
  const quotas = utils.parseQuotaData("antigravity", {
    quotas: { "gemini-3-flash": geminiQuota(), "gpt-oss-120b-medium": claudeQuota() },
  });
  assert.deepEqual(quotas.map(rowKey).sort(), ["gemini-3-flash", "gpt-oss-120b-medium"]);
});

test("a pool row inherits the least-trusted quota source of its members", () => {
  const data = liveAccount();
  data.quotas["gemini-3-flash"] = { ...geminiQuota(), quotaSource: "fetchAvailableModels" };
  const gemini = utils.parseQuotaData("antigravity", data).find((q) => q.name === "gemini_models");
  assert.equal(gemini.quotaSource, "fetchAvailableModels");
});

test("hiding a model removes it from its pool; hiding every member removes the pool", () => {
  const quotas = utils.parseQuotaData("antigravity", liveAccount());
  const hidden = utils.collectHiddenQuotaModelIds("antigravity", {
    models: [{ id: "antigravity/gpt-oss-120b-medium", isHidden: true }],
    modelCompatOverrides: [
      { id: "gemini-3.8-flash-tiered", isHidden: true },
      { id: "gemini-3.5-flash-lite", isHidden: true },
      { id: "gemini-3.1-flash-image", isHidden: true },
      { id: "gemini-3-flash", isHidden: true },
    ],
  });
  const visible = utils.filterHiddenModelQuotas("antigravity", quotas, hidden);

  assert.ok(!visible.some((q) => q.name === "gemini_models"));
  const claude = visible.find((q) => q.name === "claude_gpt_models");
  assert.deepEqual(claude.memberModelKeys, ["claude-opus-5-5-high", "claude-sonnet-5-5-low"]);
  assert.ok(visible.some((q) => q.name === "gemini_weekly"));
});

test("cutoff windows expand pool rows back into the per-model keys routing enforces", () => {
  const quotas = utils.parseQuotaData("antigravity", liveAccount());
  const keys = utils.expandQuotaCutoffWindows(quotas).map((q) => q.name);

  assert.ok(keys.includes("gemini-3-flash"));
  assert.ok(keys.includes("gpt-oss-120b-medium"));
  assert.ok(keys.includes("gemini_weekly"));
  assert.ok(!keys.includes("gemini_models"));
  assert.ok(!keys.includes("claude_gpt_models"));
});
