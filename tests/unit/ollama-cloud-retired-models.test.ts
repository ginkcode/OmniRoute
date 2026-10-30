import { test } from "node:test";
import assert from "node:assert/strict";
import { ollama_cloudProvider } from "../../open-sse/config/providers/registry/ollama-cloud/index.ts";
import { FREE_MODEL_BUDGETS } from "../../open-sse/config/freeModelCatalog.data.ts";

// Ollama Cloud retired these on 2026-09-25 — requests now fail with
// "<model> was retired on September 25, 2026". Keeping them in the static
// catalog advertises models no key can reach.
const RETIRED = ["deepseek-v4-flash", "glm-5.1", "qwen3.5:397b"];

test("ollama-cloud static registry no longer lists retired models", () => {
  const ids = new Set(ollama_cloudProvider.models.map((m) => m.id));
  for (const id of RETIRED) {
    assert.ok(!ids.has(id), `${id} is retired upstream but still in the registry`);
  }
});

test("ollama-cloud free catalog no longer lists retired models", () => {
  const ids = new Set(
    FREE_MODEL_BUDGETS.filter((e) => e.provider === "ollama-cloud").map((e) => e.modelId)
  );
  for (const id of RETIRED) {
    assert.ok(!ids.has(id), `${id} is retired upstream but still in the free catalog`);
  }
});

test("ollama-cloud registry carries the current successor models", () => {
  const ids = new Set(ollama_cloudProvider.models.map((m) => m.id));
  for (const id of ["deepseek-v4.1-flash", "glm-5.3", "glm-5.3-flash", "kimi-k3"]) {
    assert.ok(ids.has(id), `${id} should be in the ollama-cloud registry`);
  }
});
