// Regression: the Codex backend (FastAPI) rejects requests with `{"detail": "..."}`.
// parseUpstreamError() only read error.message / message / error, so a rejected
// model surfaced as the opaque "[400]: Upstream error: 400" with the real reason lost.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUpstreamError } from "../../open-sse/utils/error.ts";

const jsonResponse = (body: unknown, status = 400) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("parseUpstreamError surfaces a FastAPI string detail", async () => {
  const detail =
    "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";
  const parsed = await parseUpstreamError(jsonResponse({ detail }), "codex");
  assert.equal(parsed.message, detail);
});

test("parseUpstreamError surfaces a FastAPI validation detail list", async () => {
  const parsed = await parseUpstreamError(
    jsonResponse({
      detail: [{ loc: ["body", "model"], msg: "unknown model", type: "value_error" }],
    }),
    "codex"
  );
  assert.ok(parsed.message.includes("unknown model"), parsed.message);
});

test("parseUpstreamError still prefers error.message over detail", async () => {
  const parsed = await parseUpstreamError(
    jsonResponse({ error: { message: "primary" }, detail: "secondary" }),
    "codex"
  );
  assert.equal(parsed.message, "primary");
});

test("parseUpstreamError keeps the status fallback for JSON without a message", async () => {
  const parsed = await parseUpstreamError(jsonResponse({ foo: 1 }), "codex");
  assert.equal(parsed.message, "Upstream error: 400");
});
