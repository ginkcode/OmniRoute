// @ts-nocheck
/**
 * Claude Code sessions in a combo that switch from a non-Anthropic leg (Codex,
 * Gemini/Antigravity, GLM, Kimi, DeepSeek) to native Claude hit:
 *
 *   400 messages.N.content.0: Invalid `signature` in `thinking` block
 *
 * The non-Anthropic legs are translated back to the Claude shape with
 * `thinking` blocks but never a `signature_delta`, so Claude Code stores them
 * with an empty/missing signature and replays them. Anthropic always rejects a
 * thinking block with an empty signature, and the one-shot signature recovery
 * protects the active tool cycle, which is exactly where the switch happens.
 * Such blocks carry nothing Anthropic can use, so the native passthrough drops
 * them; genuine signed blocks stay byte-identical.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-unsigned-thinking-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
const { dropUnsignedThinkingBlocks } =
  await import("../../open-sse/handlers/chatCore/passthroughHelpers.ts");

const originalFetch = globalThis.fetch;

test.after(async () => {
  globalThis.fetch = originalFetch;
  // Let the call-log write settle before the DB handle closes.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const SIGNED = { type: "thinking", thinking: "", signature: "EosnCkYICxIMgenuine" };

// History as Claude Code stores it: a genuine Claude turn, then a Codex turn
// (thinking without signature) that opened the still-active tool cycle.
function switchedConversation() {
  return [
    { role: "user", content: [{ type: "text", text: "inspect the repo" }] },
    {
      role: "assistant",
      content: [structuredClone(SIGNED), { type: "text", text: "Sure." }],
    },
    { role: "user", content: [{ type: "text", text: "now list files" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "codex reasoning", signature: "" },
        { type: "thinking", thinking: "more codex reasoning" },
        { type: "redacted_thinking", data: "" },
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.ts" }],
    },
  ];
}

test("drops thinking blocks without a signature and keeps signed ones", () => {
  const out = dropUnsignedThinkingBlocks(switchedConversation());

  assert.deepEqual(out[1].content, [SIGNED, { type: "text", text: "Sure." }]);
  assert.deepEqual(out[3].content, [
    { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
  ]);
});

test("returns the same reference when every thinking block is signed", () => {
  const messages = [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [
        SIGNED,
        { type: "redacted_thinking", data: "ENCRYPTED" },
        { type: "text", text: "x" },
      ],
    },
  ];
  assert.equal(dropUnsignedThinkingBlocks(messages), messages);
  assert.equal(dropUnsignedThinkingBlocks(undefined), undefined);
});

test("keeps a message whose only content is an unsigned thinking block", () => {
  // Emptying it would trade one 400 for another (non-empty content required).
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "thinking", thinking: "only", signature: "" }] },
  ];
  assert.equal(dropUnsignedThinkingBlocks(messages), messages);
});

test("native claude passthrough strips unsigned thinking before dispatch", async () => {
  let captured = null;
  globalThis.fetch = async (_url, init = {}) => {
    captured = JSON.parse(String(init.body || "{}"));
    return new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "text", text: "OK" }],
        usage: { input_tokens: 4, output_tokens: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const body = {
    model: "claude-opus-5",
    max_tokens: 64,
    thinking: { type: "adaptive" },
    messages: switchedConversation(),
    stream: false,
  };

  const result = await handleChatCore({
    body: structuredClone(body),
    modelInfo: { provider: "claude", model: "claude-opus-5", extendedContext: false },
    credentials: { apiKey: "test-claude-key", providerSpecificData: {} },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    clientRawRequest: {
      endpoint: "/v1/messages",
      body: structuredClone(body),
      headers: new Headers({
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "claude-code/2.1.154",
      }),
    },
    userAgent: "claude-code/2.1.154",
  });

  assert.equal(result.success, true);
  assert.ok(captured, "fetch was not called");
  const thinkingBlocks = captured.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block.type === "thinking" || block.type === "redacted_thinking");
  assert.deepEqual(thinkingBlocks, [SIGNED]);
  const toolTurn = captured.messages.find(
    (message) =>
      Array.isArray(message.content) && message.content.some((b) => b.type === "tool_use")
  );
  assert.equal(toolTurn.content[0].type, "tool_use");
});
