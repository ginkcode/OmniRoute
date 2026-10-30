import type { RegistryEntry } from "../../shared.ts";

export const ollama_cloudProvider: RegistryEntry = {
  id: "ollama-cloud",
  alias: "ollamacloud",
  format: "openai",
  executor: "default",
  baseUrl: "https://ollama.com/v1/chat/completions",
  modelsUrl: "https://ollama.com/api/tags",
  authType: "apikey",
  authHeader: "bearer",
  defaultSupportedThinkingEfforts: ["none", "low", "medium", "high", "max"],
  // Note: rate limits vary by plan (free = "Light usage", Pro = more, Max = 5x Pro).
  // Users can generate API keys at https://ollama.com/settings/keys
  models: [
    {
      id: "gpt-oss:20b",
      name: "GPT-OSS 20B",
      supportsReasoning: true,
      supportedThinkingEfforts: ["low", "medium", "high"],
    },
    {
      id: "gpt-oss:120b",
      name: "GPT-OSS 120B",
      supportsReasoning: true,
      supportedThinkingEfforts: ["low", "medium", "high"],
    },
    // #10788: these models accept none|low|medium|high|max. Keep their explicit
    // declarations aligned with the provider fallback so the static and synced
    // catalog paths expose the same native vocabulary.
    {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      supportsReasoning: true,
      supportedThinkingEfforts: ["none", "low", "medium", "high", "max"],
    },
    // deepseek-v4-flash, glm-5.1 and qwen3.5:397b were retired upstream on
    // 2026-09-25 (Ollama now answers them with a "was retired" error).
    {
      id: "deepseek-v4.1-flash",
      name: "DeepSeek V4.1 Flash",
      contextLength: 1048576,
      supportsVision: true,
      supportsReasoning: true,
      supportedThinkingEfforts: ["none", "low", "medium", "high", "max"],
    },
    { id: "kimi-k2.6", name: "Kimi K2.6" },
    { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", contextLength: 262144, supportsVision: true },
    { id: "kimi-k3", name: "Kimi K3", contextLength: 1048576, supportsVision: true },
    // Ollama Cloud accepts low|medium|high|max|none and rejects xhigh, so the
    // explicit supportsXHighEffort:false makes the sanitizer map xhigh → max.
    {
      id: "glm-5.2",
      name: "GLM 5.2",
      supportsReasoning: true,
      supportsXHighEffort: false,
      supportedThinkingEfforts: ["none", "low", "medium", "high", "max"],
    },
    {
      id: "glm-5.3",
      name: "GLM 5.3",
      contextLength: 1048576,
      supportsReasoning: true,
      supportsXHighEffort: false,
      supportedThinkingEfforts: ["none", "low", "medium", "high", "max"],
    },
    {
      id: "glm-5.3-flash",
      name: "GLM 5.3 Flash",
      contextLength: 1048576,
      supportsVision: true,
      supportsReasoning: true,
      supportsXHighEffort: false,
      supportedThinkingEfforts: ["none", "low", "medium", "high", "max"],
    },
    // #3110: MiniMax M3 via Ollama (Ollama serves it with a 512K window)
    { id: "minimax-m3", name: "MiniMax M3", contextLength: 512000, supportsVision: true },
    {
      id: "minimax-m3.1-flash",
      name: "MiniMax M3.1 Flash",
      contextLength: 1000000,
      supportsVision: true,
    },
    { id: "minimax-m2.7", name: "MiniMax M2.7" },
    {
      id: "mistral-large-3:675b",
      name: "Mistral Large 3 675B",
      contextLength: 262144,
      supportsVision: true,
    },
    {
      id: "mistral-large-4",
      name: "Mistral Large 4",
      contextLength: 1048576,
      supportsVision: true,
    },
    { id: "gemma4:31b", name: "Gemma 4 31B" },
    { id: "nemotron-3-nano:30b", name: "NVIDIA Nemotron 3 Nano 30B", contextLength: 262144 },
    { id: "nemotron-3-super", name: "NVIDIA Nemotron 3 Super" },
    { id: "nemotron-3-ultra", name: "NVIDIA Nemotron 3 Ultra", contextLength: 262144 },
    { id: "beam", name: "Beam", contextLength: 1048576 },
    {
      id: "muse-spark-open",
      name: "Muse Spark Open",
      contextLength: 1048576,
      supportsVision: true,
    },
  ],
  passthroughModels: true,
};
