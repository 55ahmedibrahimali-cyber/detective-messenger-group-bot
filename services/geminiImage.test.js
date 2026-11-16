"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const geminiImage = require("./geminiImage");

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

test("Gemini image generation includes a validated reference image", async () => {
  const originalPost = axios.post;
  const originalEnvironment = {
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_IMAGE_MODEL,
    fallback: process.env.GEMINI_IMAGE_FALLBACK_MODELS,
  };
  let request;
  process.env.GEMINI_API_KEY = "image-test-key";
  process.env.GEMINI_IMAGE_MODEL = "image-test-model";
  process.env.GEMINI_IMAGE_FALLBACK_MODELS = "";
  axios.post = async (url, body, options) => {
    request = { url, body, options };
    return {
      data: {
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: png.toString("base64"),
                  },
                },
              ],
            },
          },
        ],
      },
    };
  };

  try {
    const result = await geminiImage.generateImage("Create an original poster.", {
      buffer: png,
      contentType: "image/png",
    });
    assert.match(request.url, /image-test-model:generateContent$/);
    assert.deepEqual(request.body.contents[0].parts[0], {
      inlineData: {
        mimeType: "image/png",
        data: png.toString("base64"),
      },
    });
    assert.equal(request.body.contents[0].parts[1].text, "Create an original poster.");
    assert.deepEqual(result.buffer, png);
  } finally {
    axios.post = originalPost;
    if (originalEnvironment.apiKey === undefined)
      delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalEnvironment.apiKey;
    if (originalEnvironment.model === undefined)
      delete process.env.GEMINI_IMAGE_MODEL;
    else process.env.GEMINI_IMAGE_MODEL = originalEnvironment.model;
    if (originalEnvironment.fallback === undefined)
      delete process.env.GEMINI_IMAGE_FALLBACK_MODELS;
    else
      process.env.GEMINI_IMAGE_FALLBACK_MODELS =
        originalEnvironment.fallback;
  }
});
