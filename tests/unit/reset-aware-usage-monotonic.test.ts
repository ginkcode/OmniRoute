/**
 * Reset-aware must never reward usage itself.
 *
 * The reset-pressure term used to be `urgency * used`, which outweighs the
 * remaining-quota term once a weekly reset is under ~4.6 days away. From then
 * on every request made the serving account score HIGHER than its siblings in
 * the same reset cohort, so the strategy drained one account to its limit and
 * only moved on after an upstream error.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { scoreResetAwareQuota, resolveResetAwareConfig } =
  await import("../../open-sse/services/combo/quotaScoring.ts");

const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

function quota(sessionUsed: number, weeklyUsed: number, weeklyResetMs: number) {
  return {
    percentUsed: weeklyUsed,
    window5h: { percentUsed: sessionUsed, resetAt: iso(4 * 3600_000) },
    window7d: { percentUsed: weeklyUsed, resetAt: iso(weeklyResetMs) },
    limitReached: false,
  };
}

test("more weekly usage never scores higher within the same reset cohort", () => {
  const cfg = resolveResetAwareConfig({});
  for (const resetMs of [3600_000, 24 * 3600_000, 3 * 86_400_000, 6 * 86_400_000]) {
    let previous = Infinity;
    for (const used of [0, 0.2, 0.4, 0.6, 0.8]) {
      const score = scoreResetAwareQuota(quota(0.1, used, resetMs), cfg).score;
      assert.ok(
        score <= previous + 1e-12,
        `weekly reset in ${resetMs}ms: ${used * 100}% used scored ${score} > ${previous}`
      );
      previous = score;
    }
  }
});

test("more session usage never scores higher when the 5h window is about to reset", () => {
  const cfg = resolveResetAwareConfig({});
  const near = (used: number) => ({
    percentUsed: 0.2,
    window5h: { percentUsed: used, resetAt: iso(20 * 60_000) },
    window7d: { percentUsed: 0.2, resetAt: iso(6 * 86_400_000) },
    limitReached: false,
  });
  assert.ok(
    scoreResetAwareQuota(near(0.3), cfg).score >= scoreResetAwareQuota(near(0.7), cfg).score
  );
});

test("sooner weekly reset still outranks a fresh account that resets later", () => {
  const cfg = resolveResetAwareConfig({});
  const soon = scoreResetAwareQuota(quota(0.1, 0.6, 24 * 3600_000), cfg).score;
  const fresh = scoreResetAwareQuota(quota(0.1, 0, 7 * 86_400_000), cfg).score;
  assert.ok(soon > fresh, `soon ${soon} should beat fresh ${fresh}`);
});
