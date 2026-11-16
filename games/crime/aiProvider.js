"use strict";

const cloudflareAI = require("../../services/cloudflareAI");
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

function getConfig() {
  const provider = (process.env.CRIME_AI_PROVIDER || "cloudflare")
    .trim()
    .toLowerCase();
  if (!["cloudflare", "groq", "gemini"].includes(provider)) {
    throw new Error("CRIME_AI_PROVIDER must be cloudflare, groq, or gemini.");
  }

  const apiKey =
    provider === "cloudflare"
      ? process.env.CLOUDFLARE_API_TOKEN?.trim()
      : provider === "groq"
        ? process.env.GROQ_API_KEY?.trim()
        : process.env.GEMINI_API_KEY?.trim();
  const accountId =
    provider === "cloudflare"
      ? process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
      : undefined;
  const primaryModel =
    process.env.CRIME_AI_MODEL?.trim() ||
    (provider === "cloudflare"
      ? process.env.CLOUDFLARE_AI_MODEL?.trim() || cloudflareAI.DEFAULT_MODEL
      : provider === "groq"
        ? process.env.GROQ_CHAT_MODEL?.trim() || "openai/gpt-oss-20b"
        : process.env.GEMINI_MODEL?.trim() || "gemini-3.8-flash");
  const fallbackModel =
    process.env.CRIME_AI_FALLBACK_MODEL?.trim() ||
    (provider === "cloudflare"
      ? process.env.CLOUDFLARE_AI_FALLBACK_MODEL?.trim() || ""
      : provider === "gemini"
        ? process.env.GEMINI_FALLBACK_MODEL?.trim() || "gemini-3.6-flash"
        : "");
  const models = [...new Set([primaryModel, fallbackModel].filter(Boolean))];
  const envFile =
    process.env.BOT_PLATFORM === "telegram" ? ".env.telegram" : ".env";

  return {
    provider,
    apiKey,
    accountId,
    models,
    setupMessage:
      provider === "cloudflare"
        ? `مولّد قضايا اللعبة يحتاج CLOUDFLARE_ACCOUNT_ID وCLOUDFLARE_API_TOKEN داخل ${envFile}.`
        : provider === "groq"
          ? `مولّد قضايا اللعبة يحتاج مفتاح Groq؛ ضعه في GROQ_API_KEY داخل ${envFile}.`
          : `مولّد قضايا اللعبة يحتاج GEMINI_API_KEY داخل ${envFile}.`,
  };
}

function requireConfig() {
  const config = getConfig();
  if (!config.apiKey || (config.provider === "cloudflare" && !config.accountId)) {
    const error = new Error(config.setupMessage);
    error.code =
      config.provider === "cloudflare"
        ? "MISSING_CRIME_AI_CONFIG"
        : "MISSING_CRIME_AI_KEY";
    throw error;
  }
  return config;
}

function openAIMessages(body) {
  const messages = [];
  const systemText = body.systemInstruction?.parts
    ?.map((part) => part.text)
    .filter(Boolean)
    .join("\n");
  if (systemText) messages.push({ role: "system", content: systemText });

  for (const entry of body.contents || []) {
    const content = entry.parts?.map((part) => part.text).filter(Boolean).join("\n");
    if (!content) continue;
    messages.push({
      role: entry.role === "model" ? "assistant" : "user",
      content,
    });
  }
  return messages;
}

function toOpenAIPayload(model, body) {
  const generation = body.generationConfig || {};
  const payload = {
    model,
    messages: openAIMessages(body),
    stream: false,
  };
  if (Number.isFinite(generation.maxOutputTokens)) {
    payload.max_tokens = generation.maxOutputTokens;
  }
  if (generation.responseMimeType === "application/json") {
    payload.response_format = { type: "json_object" };
  }
  return payload;
}

function normalizeOpenAIResponse(response, provider) {
  const text = response.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error(
      `${provider} returned an empty response for the crime generator.`,
    );
  }
  return {
    candidates: [{ content: { parts: [{ text }] } }],
  };
}

function responseErrorMessage(result) {
  if (result.error?.message) return result.error.message;
  if (Array.isArray(result.errors)) {
    return result.errors
      .map((error) => error.message)
      .filter(Boolean)
      .join("; ");
  }
  return "";
}

function responseHeader(response, name) {
  const headers = response.headers;
  if (typeof headers?.get === "function") return headers.get(name);
  return headers?.[name] || headers?.[name.toLowerCase()] || null;
}

function retryAfterMilliseconds(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : Math.max(0, timestamp - Date.now());
}

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function requestCrimeAIContent(apiKey, models, body, options = {}) {
  const config = getConfig();
  const provider = options.provider || config.provider;
  const accountId = options.accountId || config.accountId;
  const fetchImpl = options.fetchImpl || fetch;
  let lastError;

  for (const [modelIndex, model] of models.entries()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try {
        const isGroq = provider === "groq";
        const isCloudflare = provider === "cloudflare";
        response = await fetchImpl(
          isCloudflare
            ? cloudflareAI.chatCompletionsUrl(accountId)
            : isGroq
              ? GROQ_URL
              : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: "POST",
            headers: isGroq || isCloudflare
              ? {
                  "content-type": "application/json",
                  Authorization: `Bearer ${apiKey}`,
                }
              : {
                  "content-type": "application/json",
                  "x-goog-api-key": apiKey,
                },
            body: JSON.stringify(
              isGroq || isCloudflare ? toOpenAIPayload(model, body) : body,
            ),
            signal: AbortSignal.timeout(45000),
          },
        );
      } catch (error) {
        lastError = new Error(
          `تعذر الاتصال بمزوّد قضايا اللعبة (${provider}): ${error.message}`,
          { cause: error },
        );
        if (attempt === 0) {
          await (options.sleepImpl || sleep)(1000);
          continue;
        }
        break;
      }

      let result;
      try {
        result = await response.json();
      } catch (error) {
        lastError = new Error(
          `تعذرت قراءة استجابة مزوّد قضايا اللعبة (${provider}): ${error.message}`,
          { cause: error },
        );
        if (attempt === 0) {
          await (options.sleepImpl || sleep)(1000);
          continue;
        }
        break;
      }

      if (response.ok) {
        return provider === "groq" || provider === "cloudflare"
          ? normalizeOpenAIResponse(result, provider)
          : result;
      }

      const errorMessage = responseErrorMessage(result);
      const detail = errorMessage ? `: ${errorMessage}` : "";
      const retryAfterMs = retryAfterMilliseconds(
        responseHeader(response, "retry-after"),
      );
      const rateLimitReset =
        responseHeader(response, "x-ratelimit-reset-tokens") ||
        responseHeader(response, "x-ratelimit-reset-requests");
      const rateLimitHint =
        response.status === 429
          ? retryAfterMs !== null
            ? ` أعد المحاولة بعد ${Math.ceil(retryAfterMs / 1000)} ثانية.`
            : rateLimitReset
              ? ` وقت تجدد الحد المعلن: ${rateLimitReset}.`
              : provider === "cloudflare"
                ? " تجاوزت الحصة اليومية أو حدود Workers AI؛ راجع استهلاك Neurons في لوحة Cloudflare."
                : provider === "groq"
                  ? " تجاوزت حدود الطلبات أو الرموز أو الرصيد؛ افحص حدود الحساب في Groq."
                  : ""
          : "";
      lastError = Object.assign(
        new Error(
          `تعذر التوليد عبر ${provider} باستخدام النموذج ${model} (HTTP ${response.status}${detail}).${rateLimitHint}`,
        ),
        {
          status: response.status,
          code:
            result.error?.code ||
            result.error?.type ||
            result.errors?.[0]?.code,
          retryAfterMs,
        },
      );
      const retryable = [404, 500, 502, 503, 504].includes(response.status);
      if (!retryable) throw lastError;
      if (attempt === 0) await (options.sleepImpl || sleep)(1000);
    }

    if (modelIndex < models.length - 1) {
      console.warn(
        `[crime AI] model ${model} unavailable after retries; switching to ${models[modelIndex + 1]}.`,
      );
    }
  }
  throw lastError || new Error("لا تتوفر نماذج لمولّد قضايا اللعبة.");
}

module.exports = {
  getConfig,
  requireConfig,
  requestCrimeAIContent,
  toOpenAIPayload,
};
