const axios = require("axios");

function imageModels() {
  const primary =
    process.env.GEMINI_IMAGE_MODEL?.trim() || "gemini-nano-banana-2.1";
  const fallbackModels = (
    process.env.GEMINI_IMAGE_FALLBACK_MODELS ||
    "gemini-3.1-flash-image,gemini-3.1-flash-lite-image,gemini-3-pro-image,gemini-2.5-flash-image"
  )
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  return [...new Set([primary, ...fallbackModels])];
}

function apiError(error, apiKey) {
  const status = error.response?.status;
  const apiMessage = error.response?.data?.error?.message;
  const detail = status
    ? `HTTP ${status}${apiMessage ? `: ${apiMessage}` : ""}`
    : error.message || "unknown error";
  return {
    status,
    detail: detail.split(apiKey).join("[hidden]").slice(0, 500),
  };
}

function imageDataFrom(response) {
  const parts = response.data?.candidates?.[0]?.content?.parts;
  const imagePart = parts?.find((part) => part.inlineData || part.inline_data);
  const image = imagePart?.inlineData || imagePart?.inline_data;
  const contentType = image?.mimeType || image?.mime_type;
  if (!image?.data || !/^image\/(?:png|jpeg|webp)$/.test(contentType || ""))
    throw new Error("Gemini did not return a supported image.");
  const buffer = Buffer.from(image.data, "base64");
  if (!buffer.length) throw new Error("Gemini returned an empty image.");
  return { buffer, contentType };
}

async function requestImage(model, prompt, apiKey, referenceImage, timeout) {
  let response;
  try {
    const parts = [];
    if (referenceImage) {
      parts.push({
        inlineData: {
          mimeType: referenceImage.contentType,
          data: referenceImage.buffer.toString("base64"),
        },
      });
    }
    parts.push({ text: prompt });
    response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        contents: [{ parts }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        safetySettings: [
          {
            category: "HARM_CATEGORY_HARASSMENT",
            threshold: "BLOCK_LOW_AND_ABOVE",
          },
          {
            category: "HARM_CATEGORY_HATE_SPEECH",
            threshold: "BLOCK_LOW_AND_ABOVE",
          },
          {
            category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
            threshold: "BLOCK_LOW_AND_ABOVE",
          },
          {
            category: "HARM_CATEGORY_DANGEROUS_CONTENT",
            threshold: "BLOCK_LOW_AND_ABOVE",
          },
        ],
      },
      { params: { key: apiKey }, timeout },
    );
  } catch (error) {
    const failure = apiError(error, apiKey);
    throw Object.assign(new Error(failure.detail), { status: failure.status });
  }
  return imageDataFrom(response);
}

async function generateImage(prompt, referenceImage = null) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured.");
  if (!prompt?.trim()) throw new Error("Gemini image prompt is empty.");
  if (
    referenceImage &&
    (!Buffer.isBuffer(referenceImage.buffer) ||
      !/^image\/(?:png|jpeg|webp)$/.test(referenceImage.contentType || "") ||
      referenceImage.buffer.length === 0)
  ) {
    throw new TypeError("Gemini reference image must be a supported image buffer.");
  }
  if (referenceImage?.buffer.length > 5 * 1024 * 1024)
    throw new Error("Gemini reference image exceeds the 5 MB limit.");

  const failures = [];
  const deadline = Date.now() + 120_000;
  for (const model of imageModels()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const image = await requestImage(
        model,
        prompt,
        apiKey,
        referenceImage,
        Math.min(90_000, remaining),
      );
      if (failures.length)
        console.warn(
          `[Gemini image] generated with fallback model "${model}" after ${failures.length} earlier model failure(s).`,
        );
      return { ...image, model };
    } catch (error) {
      const status = error.status || error.response?.status;
      const detail = String(error.message || "unknown error")
        .split(apiKey)
        .join("[hidden]")
        .slice(0, 500);
      failures.push({ model, status, detail });
      console.error(
        `[Gemini image] model "${model}" failed${status ? ` (HTTP ${status})` : ""}: ${detail}`,
      );
      if (status === 401 || status === 403 || status === 429) break;
    }
  }

  if (failures.some(({ status }) => status === 429))
    throw new Error(
      "[Gemini image] HTTP 429: image generation quota is exhausted or unavailable for this project. Check billing and image-generation quotas in Google AI Studio; fallback models are covered by the same project quota.",
    );

  throw new Error(
    `[Gemini image] all models failed: ${failures
      .map(
        ({ model, status, detail }) =>
          `${model}${status ? ` (${status})` : ""}: ${detail}`,
      )
      .join(" | ")}`,
  );
}

module.exports = { generateImage, imageModels };
