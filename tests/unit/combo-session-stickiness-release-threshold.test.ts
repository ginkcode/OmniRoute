/**
 * Session stickiness release threshold.
 *
 * The pin used to hold until the sticky connection was 85% used, which kept a
 * whole conversation on one account long after its siblings had more quota
 * and defeated balancing strategies such as reset-aware. The default now
 * releases at 50% used, overridable per combo and globally via
 * `sessionStickinessReleasePercent`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { HeadroomSaturation } from "../../open-sse/services/combo/headroomRanking.ts";
import type { ResolvedComboTarget } from "../../open-sse/services/combo/types.ts";

const {
  applySessionStickiness,
  clearAllStickyBindings,
  deriveMessageHash,
  recordStickyBinding,
  resolveStickinessHeadroomThreshold,
  __setStickinessHeadroomFetcherForTests,
  __setStickinessConnectionFetcherForTests,
  __setStickinessQuotaCheckerForTests,
} = await import("../../open-sse/services/combo/sessionStickiness.ts");

function makeTarget(connectionId: string): ResolvedComboTarget {
  return {
    kind: "model",
    stepId: `step-${connectionId}`,
    executionKey: `key-${connectionId}`,
    modelStr: `gpt-4/${connectionId}`,
    provider: "openai",
    providerId: null,
    connectionId,
    weight: 1,
    label: null,
  };
}

function injectSat(sat: HeadroomSaturation): void {
  __setStickinessHeadroomFetcherForTests(async () => sat);
}

async function stickAt(sat: HeadroomSaturation, options?: { headroomThreshold?: number }) {
  injectSat(sat);
  const targets = [makeTarget("conn-A"), makeTarget("conn-B")];
  const messages = [{ role: "user", content: `release ${JSON.stringify(sat)}` }];
  recordStickyBinding(deriveMessageHash(messages)!, "conn-A");
  return applySessionStickiness(targets, messages, undefined, options);
}

test.beforeEach(() => {
  clearAllStickyBindings();
  __setStickinessConnectionFetcherForTests(async () => undefined);
  __setStickinessQuotaCheckerForTests(() => false);
});

test.after(() => {
  clearAllStickyBindings();
  __setStickinessHeadroomFetcherForTests(null);
  __setStickinessConnectionFetcherForTests(null);
  __setStickinessQuotaCheckerForTests(null);
});

test("default releases the pin once the sticky connection is half used", async () => {
  assert.equal((await stickAt({ util5h: 0.55, util7d: 0.1 })).stuck, false);
  assert.equal((await stickAt({ util5h: 0.1, util7d: 0.6 })).stuck, false);
});

test("default keeps the pin while the sticky connection is under half used", async () => {
  const result = await stickAt({ util5h: 0.45, util7d: 0.2 });
  assert.equal(result.stuck, true);
  assert.equal(result.targets[0].connectionId, "conn-A");
});

test("an explicit headroom threshold overrides the default", async () => {
  assert.equal((await stickAt({ util5h: 0.7, util7d: 0 }, { headroomThreshold: 0.2 })).stuck, true);
  assert.equal(
    (await stickAt({ util5h: 0.3, util7d: 0 }, { headroomThreshold: 0.75 })).stuck,
    false
  );
});

test("resolveStickinessHeadroomThreshold: per-combo → global → 50% default", () => {
  assert.equal(resolveStickinessHeadroomThreshold(null, null), 0.5);
  assert.equal(
    resolveStickinessHeadroomThreshold({}, { sessionStickinessReleasePercent: 80 }),
    0.2
  );
  assert.equal(
    resolveStickinessHeadroomThreshold(
      { sessionStickinessReleasePercent: 30 },
      { sessionStickinessReleasePercent: 80 }
    ),
    0.7
  );
});

test("resolveStickinessHeadroomThreshold ignores out-of-range values", () => {
  assert.equal(resolveStickinessHeadroomThreshold({ sessionStickinessReleasePercent: 0 }, {}), 0.5);
  assert.equal(
    resolveStickinessHeadroomThreshold({ sessionStickinessReleasePercent: 150 }, {}),
    0.5
  );
  assert.equal(
    resolveStickinessHeadroomThreshold({ sessionStickinessReleasePercent: "abc" }, {}),
    0.5
  );
  assert.equal(
    resolveStickinessHeadroomThreshold(
      { sessionStickinessReleasePercent: null },
      {
        sessionStickinessReleasePercent: 90,
      }
    ),
    0.1
  );
});
