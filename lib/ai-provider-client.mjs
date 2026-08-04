import { cleanText } from "./security.mjs";

function providerUrl(provider, suffix) {
  const fallback = provider.type === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com";
  return `${String(provider.baseUrl || fallback).replace(/\/$/, "")}${suffix}`;
}

async function requestJson(url, options, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error?.message || data?.message || `HTTP ${response.status}`;
      const error = new Error(cleanText(message, 4000));
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function headers(provider, apiKey) {
  if (provider.type === "anthropic") {
    return {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    };
  }
  return { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
}

export async function probeProvider(provider, apiKey) {
  const data = await requestJson(providerUrl(provider, "/v1/models"), {
    method: "GET",
    headers: headers(provider, apiKey)
  }, 15000);
  const models = (data.data || []).map((item) => item.id).filter(Boolean);
  return {
    available: true,
    models: models.slice(0, 200),
    selectedModelAvailable: provider.model ? models.includes(provider.model) : null
  };
}

function openAIText(data) {
  if (data.output_text) return data.output_text;
  return (data.output || []).flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text)
    .join("\n");
}

export async function askProvider(provider, apiKey, prompt) {
  if (!provider.model) throw new Error("Hãy chọn model cho provider.");
  if (provider.type === "anthropic") {
    const data = await requestJson(providerUrl(provider, "/v1/messages"), {
      method: "POST",
      headers: headers(provider, apiKey),
      body: JSON.stringify({
        model: provider.model,
        max_tokens: Math.max(256, Math.min(8192, Number(provider.maxOutputTokens) || 2048)),
        messages: [{ role: "user", content: prompt }]
      })
    }, 120000);
    const usage = {
      inputTokens: Number(data.usage?.input_tokens || 0),
      cachedInputTokens: Number(data.usage?.cache_read_input_tokens || 0),
      cacheWriteTokens: Number(data.usage?.cache_creation_input_tokens || 0),
      outputTokens: Number(data.usage?.output_tokens || 0)
    };
    return {
      text: cleanText((data.content || []).filter((item) => item.type === "text").map((item) => item.text).join("\n"), 100000),
      usage: { ...usage, totalTokens: usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens + usage.outputTokens }
    };
  }
  const data = await requestJson(providerUrl(provider, "/v1/responses"), {
    method: "POST",
    headers: headers(provider, apiKey),
    body: JSON.stringify({
      model: provider.model,
      input: prompt,
      max_output_tokens: Math.max(256, Math.min(8192, Number(provider.maxOutputTokens) || 2048))
    })
  }, 120000);
  const usage = {
    inputTokens: Number(data.usage?.input_tokens || 0),
    cachedInputTokens: Number(data.usage?.input_tokens_details?.cached_tokens || 0),
    cacheWriteTokens: 0,
    outputTokens: Number(data.usage?.output_tokens || 0)
  };
  return {
    text: cleanText(openAIText(data), 100000),
    usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens }
  };
}
