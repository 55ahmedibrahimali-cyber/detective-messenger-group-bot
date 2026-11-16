"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crimeAI = require("./aiProvider");
const logRedactor = require("../../services/logRedactor");

async function withEnv(values, callback) {
  const previous = new Map(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("crime AI defaults to Cloudflare Workers AI", async () => {
  await withEnv(
    {
      CRIME_AI_PROVIDER: "",
      CRIME_AI_MODEL: "",
      CRIME_AI_FALLBACK_MODEL: "",
      CLOUDFLARE_AI_MODEL: "",
      CLOUDFLARE_AI_FALLBACK_MODEL: "",
      CLOUDFLARE_API_TOKEN: "cloudflare-test-token",
      CLOUDFLARE_ACCOUNT_ID: "test-account",
    },
    () => {
      const config = crimeAI.requireConfig();
      assert.equal(config.provider, "cloudflare");
      assert.equal(config.apiKey, "cloudflare-test-token");
      assert.equal(config.accountId, "test-account");
      assert.deepEqual(config.models, ["@cf/openai/gpt-oss-20b"]);
    },
  );
});

test("Cloudflare crime requests use the account endpoint and normalize the reply", async () => {
  let request;
  const response = await withEnv(
    {
      CRIME_AI_PROVIDER: "cloudflare",
      CLOUDFLARE_ACCOUNT_ID: "test-account",
    },
    () =>
      crimeAI.requestCrimeAIContent(
        "cloudflare-test-token",
        ["@cf/openai/gpt-oss-20b"],
        {
          systemInstruction: { parts: [{ text: "أنت مولّد قضايا فقط." }] },
          contents: [
            { role: "user", parts: [{ text: "أنشئ قضية خيالية." }] },
          ],
          generationConfig: {
            maxOutputTokens: 4096,
            responseMimeType: "application/json",
          },
        },
        {
          provider: "cloudflare",
          fetchImpl: async (url, options) => {
            request = { url, options, body: JSON.parse(options.body) };
            return {
              ok: true,
              json: async () => ({
                choices: [{ message: { content: '{"title":"قضية اختبار"}' } }],
              }),
            };
          },
        },
      ),
  );

  assert.equal(
    request.url,
    "https://api.cloudflare.com/client/v4/accounts/test-account/ai/v1/chat/completions",
  );
  assert.equal(
    request.options.headers.Authorization,
    "Bearer cloudflare-test-token",
  );
  assert.equal(request.body.model, "@cf/openai/gpt-oss-20b");
  assert.deepEqual(request.body.messages, [
    { role: "system", content: "أنت مولّد قضايا فقط." },
    { role: "user", content: "أنشئ قضية خيالية." },
  ]);
  assert.equal(request.body.max_tokens, 4096);
  assert.deepEqual(request.body.response_format, { type: "json_object" });
  assert.equal(
    response.candidates[0].content.parts[0].text,
    '{"title":"قضية اختبار"}',
  );
});

test("Groq crime requests convert the game JSON prompt and normalize the reply", async () => {
  let request;
  const response = await withEnv(
    { CRIME_AI_PROVIDER: "groq" },
    () =>
      crimeAI.requestCrimeAIContent(
        "crime-test-key",
        ["crime-model"],
        {
          systemInstruction: { parts: [{ text: "أنت مولّد قضايا فقط." }] },
          contents: [
            { role: "user", parts: [{ text: "أنشئ قضية خيالية." }] },
          ],
          generationConfig: {
            maxOutputTokens: 4096,
            responseMimeType: "application/json",
          },
        },
        {
          fetchImpl: async (url, options) => {
            request = { url, options, body: JSON.parse(options.body) };
            return {
              ok: true,
              json: async () => ({
                choices: [{ message: { content: '{"title":"قضية اختبار"}' } }],
              }),
            };
          },
        },
      ),
  );

  assert.equal(request.url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(request.options.headers.Authorization, "Bearer crime-test-key");
  assert.deepEqual(request.body.messages, [
    { role: "system", content: "أنت مولّد قضايا فقط." },
    { role: "user", content: "أنشئ قضية خيالية." },
  ]);
  assert.equal(request.body.max_tokens, 4096);
  assert.deepEqual(request.body.response_format, { type: "json_object" });
  assert.equal(
    response.candidates[0].content.parts[0].text,
    '{"title":"قضية اختبار"}',
  );
});

test("Groq rate limits expose the retry delay without sending another request", async () => {
  let calls = 0;
  await assert.rejects(
    crimeAI.requestCrimeAIContent(
      "crime-test-key",
      ["openai/gpt-oss-20b"],
      { contents: [{ role: "user", parts: [{ text: "اختبر" }] }] },
      {
        provider: "groq",
        fetchImpl: async () => {
          calls++;
          return {
            ok: false,
            status: 429,
            headers: { get: (name) => name === "retry-after" ? "5" : null },
            json: async () => ({
              error: { code: "rate_limit_exceeded", message: "Rate limit reached" },
            }),
          };
        },
      },
    ),
    (error) =>
      error.status === 429 &&
      error.retryAfterMs === 5000 &&
      error.message.includes("أعد المحاولة بعد 5 ثانية"),
  );
  assert.equal(calls, 1);
});

test("Cloudflare quota errors are reported without an immediate retry", async () => {
  let calls = 0;
  await assert.rejects(
    crimeAI.requestCrimeAIContent(
      "cloudflare-test-token",
      ["@cf/openai/gpt-oss-20b"],
      { contents: [{ role: "user", parts: [{ text: "اختبر" }] }] },
      {
        provider: "cloudflare",
        accountId: "test-account",
        fetchImpl: async () => {
          calls++;
          return {
            ok: false,
            status: 429,
            headers: { get: () => null },
            json: async () => ({
              errors: [{ code: 429, message: "Daily quota exceeded" }],
            }),
          };
        },
      },
    ),
    (error) =>
      error.status === 429 &&
      error.message.includes("الحصة اليومية") &&
      error.message.includes("Workers AI"),
  );
  assert.equal(calls, 1);
});

test("crime AI reports the selected provider's missing key explicitly", async () => {
  await withEnv(
    {
      CRIME_AI_PROVIDER: "cloudflare",
      CLOUDFLARE_API_TOKEN: "cloudflare-test-token",
      CLOUDFLARE_ACCOUNT_ID: "",
      BOT_PLATFORM: "messenger",
    },
    () => {
      assert.throws(
        () => crimeAI.requireConfig(),
        (error) =>
          error.code === "MISSING_CRIME_AI_CONFIG" &&
          error.message.includes("CLOUDFLARE_ACCOUNT_ID") &&
          error.message.includes(".env."),
      );
    },
  );
  await withEnv(
    { CRIME_AI_PROVIDER: "groq", GROQ_API_KEY: "", BOT_PLATFORM: "messenger" },
    () => {
      assert.throws(
        () => crimeAI.requireConfig(),
        (error) =>
          error.code === "MISSING_CRIME_AI_KEY" &&
          error.message.includes("GROQ_API_KEY") &&
          error.message.includes(".env."),
      );
    },
  );
  await withEnv(
    { CRIME_AI_PROVIDER: "groq", GROQ_API_KEY: "", BOT_PLATFORM: "telegram" },
    () => {
      assert.throws(
        () => crimeAI.requireConfig(),
        (error) =>
          error.code === "MISSING_CRIME_AI_KEY" &&
          error.message.includes(".env.telegram"),
      );
    },
  );
});

test("Gemini remains available as an explicitly selected crime provider", async () => {
  let request;
  const body = {
    contents: [{ role: "user", parts: [{ text: "اختبر" }] }],
    generationConfig: { responseMimeType: "application/json" },
  };
  await withEnv(
    { CRIME_AI_PROVIDER: "gemini", GEMINI_API_KEY: "gemini-test-key" },
    () =>
      crimeAI.requestCrimeAIContent("gemini-test-key", ["gemini-test-model"], body, {
        fetchImpl: async (url, options) => {
          request = { url: String(url), options, body: JSON.parse(options.body) };
          return {
            ok: true,
            json: async () => ({
              candidates: [{ content: { parts: [{ text: '{"title":"اختبار"}' }] } }],
            }),
          };
        },
      }),
  );
  assert.match(request.url, /gemini-test-model:generateContent/);
  assert.equal(request.options.headers["x-goog-api-key"], "gemini-test-key");
  assert.deepEqual(request.body, body);
});

test("Groq API keys are included in log redaction", async () => {
  await withEnv({ GROQ_API_KEY: "groq-private-test-key" }, () => {
    const redacted = logRedactor.redact(
      "Authorization: Bearer groq-private-test-key",
    );
    assert.doesNotMatch(redacted, /groq-private-test-key/);
    assert.match(redacted, /\[hidden\]/);
  });
});

test("Cloudflare API tokens are included in log redaction", async () => {
  await withEnv(
    { CLOUDFLARE_API_TOKEN: "cloudflare-private-test-token" },
    () => {
      const redacted = logRedactor.redact(
        "Authorization: Bearer cloudflare-private-test-token",
      );
      assert.doesNotMatch(redacted, /cloudflare-private-test-token/);
      assert.match(redacted, /\[hidden\]/);
    },
  );
});
