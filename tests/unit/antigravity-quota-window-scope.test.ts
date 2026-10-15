// Which Antigravity quota windows reset-aware routing / quota preflight read for a requested model.
// Window keys are the ones getAntigravityUsage() emits: per-model 5h windows keyed by upstream id
// plus one weekly bucket per upstream group.
import test from "node:test";
import assert from "node:assert/strict";
import {
  remainingPercentFromQuotaWindows,
  selectAntigravityQuotaWindowNames,
} from "../../open-sse/services/antigravityQuotaFamily.ts";

const WINDOWS = [
  "claude-opus-5-5-low",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
  "gemini-3-flash",
  "gemini_weekly",
  "claude_gpt_weekly",
];

test("native Claude 5.5 effort-tier ids read their own window plus the Claude & GPT weekly", () => {
  assert.deepEqual(selectAntigravityQuotaWindowNames(WINDOWS, "claude-opus-5-5-low"), [
    "claude-opus-5-5-low",
    "claude_gpt_weekly",
  ]);
});

test("a synthesized effort variant reads its base model's window", () => {
  assert.deepEqual(selectAntigravityQuotaWindowNames(WINDOWS, "claude-sonnet-4-6-high"), [
    "claude-sonnet-4-6",
    "claude_gpt_weekly",
  ]);
  assert.deepEqual(
    selectAntigravityQuotaWindowNames(WINDOWS, "antigravity/claude-opus-4-6-thinking-low"),
    ["claude-opus-4-6-thinking", "claude_gpt_weekly"]
  );
});

test("GPT-OSS reads its own window plus the shared Claude & GPT weekly bucket", () => {
  assert.deepEqual(selectAntigravityQuotaWindowNames(WINDOWS, "gpt-oss-120b-medium"), [
    "gpt-oss-120b-medium",
    "claude_gpt_weekly",
  ]);
});

test("an exhausted Claude & GPT weekly blocks GPT-OSS even with its 5h window full", () => {
  const windows = {
    "gpt-oss-120b-medium": { percentUsed: 0 },
    claude_gpt_weekly: { percentUsed: 1 },
    gemini_weekly: { percentUsed: 0 },
  };
  assert.equal(
    remainingPercentFromQuotaWindows(windows, {
      provider: "antigravity",
      requestedModel: "gpt-oss-120b-medium",
    }),
    0
  );
});

test("unrelated models outside a known family stay exact-model scoped", () => {
  assert.deepEqual(selectAntigravityQuotaWindowNames(WINDOWS, "some-new-model"), []);
});

test("reset-aware GPT-OSS scoring follows its own window and the Claude & GPT weekly only", async () => {
  const { convertUsageToQuotaInfo } =
    await import("../../open-sse/services/genericQuotaFetcher.ts");
  const resetAt = new Date(Date.now() + 3 * 3600_000).toISOString();
  const quota = (remainingPercentage: number) => ({
    used: 1000 - remainingPercentage * 10,
    total: 1000,
    remainingPercentage,
    resetAt,
  });
  const usage = {
    quotas: {
      "gpt-oss-120b-medium": quota(80),
      "gemini-3-flash": quota(0),
      gemini_weekly: quota(0),
      claude_gpt_weekly: quota(60),
    },
  };

  const info = convertUsageToQuotaInfo(usage, {
    provider: "antigravity",
    requestedModel: "gpt-oss-120b-medium",
  });
  assert.ok(info);
  assert.deepEqual(Object.keys(info.windows ?? {}).sort(), [
    "claude_gpt_weekly",
    "gpt-oss-120b-medium",
  ]);
  assert.equal(info.limitReached, false);
  assert.ok(Math.abs((info.window5h?.percentUsed ?? -1) - 0.2) < 1e-9);
  assert.ok(Math.abs((info.window7d?.percentUsed ?? -1) - 0.4) < 1e-9);
});
