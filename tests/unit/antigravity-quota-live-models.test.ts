/**
 * Provider Limits must keep quota for every chat model Antigravity's live
 * `fetchAvailableModels` catalog reports, not only the ids in the static
 * fallback catalog.
 *
 * The usage fetcher already filters with isUserVisibleAntigravityQuotaModelId so
 * newly launched models surface before the static catalog learns about them.
 * The post-fetch sanitizer used the stricter static-catalog check, so it threw
 * those quotas away again before they were cached: with Claude 5.5 and Gemini
 * 3.8 Flash Tiered live, the Provider Quota page showed only the two models
 * that happened to be in the static list.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isUsageQuotaKeyAllowed,
  normalizeUsageQuotasForProvider,
} from "../../src/lib/usage/providerLimits/quotaNormalize.ts";

const quota = { used: 0, total: 1000, quotaSource: "retrieveUserQuota" };

describe("Antigravity provider-limits sanitizer follows the live catalog", () => {
  it("keeps quota for live chat models absent from the static catalog", () => {
    for (const modelId of ["gemini-3.8-flash-tiered", "claude-opus-9-9-high"]) {
      assert.equal(isUsageQuotaKeyAllowed("antigravity", modelId), true, modelId);
    }
  });

  it("still drops non-chat and retired buckets", () => {
    for (const modelId of ["tab_flash_lite_preview", "gemini-2.5-pro", "gemini-3.5-flash-low"]) {
      assert.equal(isUsageQuotaKeyAllowed("antigravity", modelId), false, modelId);
    }
  });

  it("keeps image models that expose their own quota bucket", () => {
    assert.equal(isUsageQuotaKeyAllowed("antigravity", "gemini-3.1-flash-image"), true);
  });

  it("normalizes a mixed live quota map without losing the new models", () => {
    const normalized = normalizeUsageQuotasForProvider("antigravity", {
      credits: quota,
      "gemini-3.1-flash-lite": quota,
      "gemini-3.8-flash-tiered": quota,
      "claude-opus-9-9-high": quota,
      tab_flash_lite_preview: quota,
      "gemini-2.5-pro": quota,
    });

    assert.deepEqual(Object.keys(normalized ?? {}).sort(), [
      "claude-opus-9-9-high",
      "credits",
      "gemini-3.1-flash-lite",
      "gemini-3.8-flash-tiered",
    ]);
  });
});
