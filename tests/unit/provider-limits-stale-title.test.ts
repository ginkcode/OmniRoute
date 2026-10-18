import test from "node:test";
import assert from "node:assert/strict";
import { formatStaleQuotaTitle } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils";

const base = "Last refresh failed — showing cached data";

test("stale quota tooltip explains why the last refresh failed", () => {
  assert.equal(
    formatStaleQuotaTitle(base, "Usage endpoint is rate-limited by Anthropic"),
    `${base}: Usage endpoint is rate-limited by Anthropic`
  );
});

test("stale quota tooltip falls back to the generic text without a reason", () => {
  for (const reason of [undefined, null, "", "   "]) {
    assert.equal(formatStaleQuotaTitle(base, reason), base);
  }
});
