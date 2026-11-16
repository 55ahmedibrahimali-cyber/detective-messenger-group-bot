"use strict";

const sharp = require("sharp");
const { setTimeout: delay } = require("node:timers/promises");
const cloudflareDesign = require("./cloudflareDesign");

const API_BASE = "https://aihorde.net/api/v2";
const CLIENT_AGENT = "detective-messenger-group-bot:2.0.0";
const MAX_WAIT_MS = 8 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_DIMENSION = 768;

function getApiKey() {
  const apiKey = process.env.AI_HORDE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "البديل AI Horde غير مضبوط؛ أضف AI_HORDE_API_KEY من حساب مجاني في stablehorde.net إلى ملف البيئة.",
    );
  }
  return apiKey;
}

function imageDimensions(reference) {
  if (!reference) return { width: MAX_DIMENSION, height: MAX_DIMENSION };
  const scale = Math.min(1, MAX_DIMENSION / Math.max(reference.width, reference.height));
  const roundDimension = (value) =>
    Math.min(
      MAX_DIMENSION,
      Math.max(256, Math.round((value * scale) / 64) * 64),
    );
  return {
    width: roundDimension(reference.width),
    height: roundDimension(reference.height),
  };
}

async function requestJson(path, apiKey, options = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method || "GET",
      headers: {
        "Client-Agent": CLIENT_AGENT,
        ...(apiKey ? { apikey: apiKey } : {}),
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`تعذر الاتصال بـAI Horde: ${error.message}`, {
      cause: error,
    });
  }

  let result;
  try {
    result = await response.json();
  } catch (error) {
    throw new Error(`تعذرت قراءة استجابة AI Horde: ${error.message}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    const rawDetail = String(
      result?.message || result?.detail || response.statusText || "",
    );
    const detail = (apiKey ? rawDetail.split(apiKey).join("[hidden]") : rawDetail)
      .slice(0, 300);
    const error = new Error(
      `تعذر استخدام AI Horde (${response.status})${detail ? `: ${detail}` : ""}.`,
    );
    error.status = response.status;
    throw error;
  }
  return result;
}

function decodeImage(encoded) {
  if (typeof encoded !== "string") {
    throw new Error("لم يُرجع AI Horde صورة صالحة.");
  }
  const dataUri = encoded.match(/^data:image\/webp;base64,(.+)$/s);
  const base64 = dataUri ? dataUri[1] : encoded;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 === 1) {
    throw new Error("استجابة AI Horde ليست صورة WebP صالحة.");
  }
  const buffer = Buffer.from(base64, "base64");
  if (
    buffer.length < 12 ||
    buffer.length > MAX_OUTPUT_BYTES ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    throw new Error("حجم أو صيغة الصورة الناتجة من AI Horde غير صالحة.");
  }
  return buffer;
}

async function cancelRequest(id) {
  try {
    await requestJson(
      `/generate/status/${encodeURIComponent(id)}`,
      null,
      { method: "DELETE" },
    );
  } catch (error) {
    console.warn("[AI Horde] unable to cancel expired request:", error.message);
  }
}

async function waitForImage(id) {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const status = await requestJson(
      `/generate/check/${encodeURIComponent(id)}`,
      null,
    );
    if (status.faulted) {
      throw new Error("تعذر إكمال طلب الصورة لدى AI Horde.");
    }
    if (status.is_possible === false) {
      throw new Error("لا يوجد حالياً عامل متوافق لتوليد الصورة في AI Horde.");
    }
    if (status.done) {
      const result = await requestJson(
        `/generate/status/${encodeURIComponent(id)}`,
        null,
      );
      const generation = result.generations?.[0];
      if (!generation || generation.censored || generation.state !== "ok") {
        throw new Error("لم يُرجع AI Horde صورة مكتملة.");
      }
      return {
        buffer: decodeImage(generation.img),
        contentType: "image/webp",
        model: `AI Horde${generation.model ? ` — ${generation.model}` : ""}`,
      };
    }
    await delay(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
  await cancelRequest(id);
  throw new Error("انتهت مهلة انتظار الصورة من AI Horde (8 دقائق).");
}

async function generateImage(prompt, reference) {
  const apiKey = getApiKey();
  const prepared = reference
    ? cloudflareDesign._internal.resizeReference(reference)
    : null;
  const dimensions = imageDimensions(prepared);
  const body = {
    prompt,
    params: {
      width: dimensions.width,
      height: dimensions.height,
      steps: 20,
      n: 1,
      sampler_name: "k_euler_a",
      ...(prepared ? { denoising_strength: 0.62 } : {}),
    },
    nsfw: false,
    censor_nsfw: true,
    trusted_workers: false,
    validated_backends: true,
    slow_workers: true,
    extra_slow_workers: true,
    r2: false,
    shared: false,
  };
  if (prepared) {
    const sourceImage = await sharp(prepared.buffer, {
      limitInputPixels: 16_000_000,
    })
      .webp({ quality: 82 })
      .toBuffer();
    body.source_image = sourceImage.toString("base64");
    body.source_processing = "img2img";
  }

  const queued = await requestJson("/generate/async", apiKey, {
    method: "POST",
    body,
  });
  if (!queued.id) {
    throw new Error("لم يُرجع AI Horde معرّف طلب الصورة.");
  }
  return waitForImage(queued.id);
}

module.exports = {
  generateImage,
  _internal: {
    decodeImage,
    imageDimensions,
  },
};
