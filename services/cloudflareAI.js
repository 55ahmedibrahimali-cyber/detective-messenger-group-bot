"use strict";

const DEFAULT_MODEL = "@cf/openai/gpt-oss-20b";
const DEFAULT_VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

function chatCompletionsUrl(accountId) {
  if (!accountId) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID is not configured.");
  }
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
    accountId,
  )}/ai/v1/chat/completions`;
}

function runUrl(accountId, model) {
  if (!accountId) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID is not configured.");
  }
  if (!/^@cf\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(model || "")) {
    throw new Error("Workers AI model ID is invalid.");
  }
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
    accountId,
  )}/ai/run/${model}`;
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_VISION_MODEL,
  chatCompletionsUrl,
  runUrl,
};
