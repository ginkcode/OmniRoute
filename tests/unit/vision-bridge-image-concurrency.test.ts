/**
 * Regression: Claude Code resends historical tool_result images on every turn.
 * Vision Bridge must not materialize every base64 self-call concurrently because
 * JSON serialization + Undici request buffers amplify native memory outside V8.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { VisionBridgeGuardrail } from "../../src/lib/guardrails/visionBridge.ts";

test("Vision Bridge describes image-heavy histories serially", async () => {
  let active = 0;
  let maxActive = 0;
  const started: string[] = [];

  const guardrail = new VisionBridgeGuardrail({
    deps: {
      getSettings: async () => ({
        modalityBridgeCacheEnabled: false,
        modalityBridgeVisionMode: "describe",
      }),
      checkModelHasComboMapping: async () => true,
      callVisionModel: async (imageDataUri) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        started.push(imageDataUri);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return `description ${started.length}`;
      },
    },
  });

  const images = ["first", "second", "third"].map(
    (value) => `data:image/png;base64,${Buffer.from(value).toString("base64")}`
  );
  const payload = {
    model: "combo/image-history",
    messages: [
      {
        role: "user",
        content: images.map((url) => ({ type: "image_url", image_url: { url } })),
      },
    ],
  };

  const result = await guardrail.preCall(payload, { model: payload.model });

  assert.equal(result.block, false);
  assert.equal((result.meta ?? {}).imagesProcessed, 3);
  assert.equal(maxActive, 1, "large image request bodies must never overlap in memory");
  assert.deepEqual(started, images, "serial processing must preserve source order");
});

test("Vision Bridge bounds image work across concurrent parent requests", async () => {
  let active = 0;
  let maxActive = 0;
  const guardrail = new VisionBridgeGuardrail({
    deps: {
      getSettings: async () => ({
        modalityBridgeCacheEnabled: false,
        modalityBridgeVisionMode: "describe",
      }),
      checkModelHasComboMapping: async () => true,
      callVisionModel: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return "description";
      },
    },
  });
  const makePayload = (value: string) => ({
    model: "combo/concurrent-image-history",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${Buffer.from(value).toString("base64")}` },
          },
        ],
      },
    ],
  });

  await Promise.all(
    [makePayload("parent-one"), makePayload("parent-two")].map((payload) =>
      guardrail.preCall(payload, { model: payload.model })
    )
  );

  assert.equal(maxActive, 1, "concurrent parents must share one native-memory-heavy slot");
});
