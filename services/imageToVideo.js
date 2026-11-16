// أمر «فيديو» (أو «حرك»): يحرّك الصورة التي يرد عليها المستخدم عبر Hugging Face Space.
// مستقل عن خدمة الإيديت؛ يحتاج HF_TOKEN اختيارياً للاستفادة من حصة ZeroGPU المجانية.
"use strict";

const designAssistant = require("./designAssistant");

const DEFAULT_SPACE_URL =
  "https://upsampler-wan-2-2-14b-image-to-video.hf.space";
const API_NAME = "/generate_video";
const MOTION_PROMPT = [
  "Animate the supplied still image into a natural, polished short video.",
  "Bring the existing subject and scene to life with subtle, coherent movement and gentle cinematic camera motion.",
  "Preserve the subject's identity, appearance, clothing, colors, and original scene; do not add characters, change the scene, or use cuts.",
  "Keep motion smooth and avoid visual distortions, readable text, captions, logos, or watermarks.",
].join(" ");
const NEGATIVE_PROMPT =
  "flicker, jitter, distorted face, deformed hands, extra limbs, scene change, text, logo, watermark";
const MAX_REFERENCE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
const MAX_REQUESTS_PER_USER_HOUR = 2;
const MAX_REQUESTS_PER_HOUR = 20;
const MAX_WAIT_MS = 5 * 60 * 1000;
const requestTimesByUser = new Map();
const activeUsers = new Set();
const backgroundRequests = new Set();
let globalRequestTimes = [];

function normalize(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .trim();
}

const COMMAND_WORDS = ["فيديو", "حرك", "حرك الصورة", "video", "animate"];

function parseCommand(text) {
  const command = String(text || "")
    .trim()
    .replace(/^[/!]\s*/, "")
    .trim();
  return COMMAND_WORDS.includes(normalize(command)) ? { action: "animate" } : null;
}

function isCommand(text) {
  return Boolean(parseCommand(text));
}

function hasReferenceSource(context) {
  if (context.designReference) return true;
  const attachments = [
    ...(Array.isArray(context.attachments) ? context.attachments : []),
    ...(Array.isArray(context.messageReply?.attachments)
      ? context.messageReply.attachments
      : []),
  ];
  return attachments.some((attachment) =>
    /image|photo/i.test(String(attachment?.type || "")),
  );
}

function getReference(context) {
  if (context.designReference) return Promise.resolve(context.designReference);
  const attachments = [
    ...(Array.isArray(context.attachments) ? context.attachments : []),
    ...(Array.isArray(context.messageReply?.attachments)
      ? context.messageReply.attachments
      : []),
  ];
  return designAssistant.getReplyImage({ attachments });
}

function getSpaceUrl() {
  const configuredUrl =
    process.env.HF_IMAGE_TO_VIDEO_SPACE_URL?.trim() || DEFAULT_SPACE_URL;
  let url;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new Error(
      "HF_IMAGE_TO_VIDEO_SPACE_URL يجب أن يكون رابط HTTPS صالحاً لـ Hugging Face Space.",
    );
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname.toLowerCase().endsWith(".hf.space") ||
    url.port ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      "HF_IMAGE_TO_VIDEO_SPACE_URL يجب أن يكون رابط HTTPS أساسياً ينتهي بـ .hf.space.",
    );
  }
  return url.origin;
}

function imageExtension(contentType) {
  if (contentType === "image/png") return "png";
  if (contentType === "image/jpeg") return "jpg";
  throw new Error("يدعم تحويل الصورة إلى فيديو حالياً الصور بصيغة PNG أو JPEG فقط.");
}

function validateReference(reference) {
  const buffer = Buffer.isBuffer(reference) ? reference : reference?.buffer;
  const actualType =
    Buffer.isBuffer(buffer) &&
    buffer.subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    )
      ? "image/png"
      : Buffer.isBuffer(buffer) &&
          buffer[0] === 0xff &&
          buffer[1] === 0xd8 &&
          buffer[2] === 0xff
        ? "image/jpeg"
        : null;
  const contentType = reference?.contentType || actualType;
  if (
    !Buffer.isBuffer(buffer) ||
    !["image/png", "image/jpeg"].includes(contentType)
  ) {
    throw new Error("أرسل صورة PNG أو JPEG صالحة لتحويلها إلى فيديو.");
  }
  if (actualType !== contentType)
    throw new Error("نوع الصورة لا يطابق محتوى ملفها.");
  if (!buffer.length || buffer.length > MAX_REFERENCE_BYTES)
    throw new Error("يجب ألا يتجاوز حجم الصورة المرجعية 5 ميغابايت.");
  return { buffer, contentType };
}

async function loadGradioClient() {
  return import("@gradio/client");
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("انتهت مهلة انتظار معالجة الفيديو على Hugging Face.")),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function extractVideoUrl(output) {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const url = extractVideoUrl(item);
      if (url) return url;
    }
  }
  if (output && typeof output === "object") {
    for (const key of ["url", "path", "video"]) {
      if (typeof output[key] === "string") return output[key];
    }
    if (output.data) return extractVideoUrl(output.data);
  }
  return null;
}

async function createVideo(reference, clientLoader = loadGradioClient) {
  const prepared = validateReference(reference);
  const { Client, handle_file: handleFile } = await clientLoader();
  if (!Client?.connect || typeof handleFile !== "function")
    throw new Error("تعذر تحميل عميل Hugging Face Gradio.");

  const token = process.env.HF_TOKEN?.trim();
  const app = await Client.connect(
    getSpaceUrl(),
    token ? { token } : undefined,
  );
  const image = new File(
    [prepared.buffer],
    `reference.${imageExtension(prepared.contentType)}`,
    { type: prepared.contentType },
  );
  const prediction = app.predict(
    API_NAME,
    [
      handleFile(image),
      MOTION_PROMPT,
      4,
      NEGATIVE_PROMPT,
      3.5,
      5,
      5,
      0,
      true,
      null,
    ],
  );
  const result = await withTimeout(prediction, MAX_WAIT_MS);
  const videoUrl = extractVideoUrl(result?.data?.[0] ?? result?.data);
  if (!videoUrl) throw new Error("لم يُرجع Hugging Face رابطاً صالحاً للفيديو.");
  const safeUrl = allowedVideoUrl(videoUrl);
  if (!safeUrl) throw new Error("رابط الفيديو الناتج غير آمن أو غير مدعوم.");
  return safeUrl.toString();
}

function allowedVideoUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let url;
  let spaceUrl;
  try {
    spaceUrl = new URL(getSpaceUrl());
    url = new URL(value, spaceUrl);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== spaceUrl.origin ||
    url.username ||
    url.password
  )
    return null;
  return url;
}

function isMp4(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 12 &&
    buffer.toString("ascii", 4, 8) === "ftyp"
  );
}

async function readLimited(response) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_VIDEO_BYTES)
    throw new Error("حجم الفيديو الناتج يتجاوز 25 ميغابايت.");
  if (!response.body) throw new Error("استجابة الفيديو فارغة.");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_VIDEO_BYTES) {
      await reader.cancel();
      throw new Error("حجم الفيديو الناتج يتجاوز 25 ميغابايت.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function downloadVideo(value) {
  let currentUrl = value;
  const token = process.env.HF_TOKEN?.trim();
  for (let redirects = 0; redirects <= 2; redirects++) {
    const url = allowedVideoUrl(currentUrl);
    if (!url) throw new Error("رابط الفيديو الناتج غير آمن أو غير مدعوم.");
    let response;
    try {
      response = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      throw new Error(`تعذر تنزيل الفيديو الناتج: ${error.message}`, {
        cause: error,
      });
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === 2)
        throw new Error("تعذر الوصول إلى ملف الفيديو الناتج.");
      currentUrl = new URL(location, url).toString();
      continue;
    }
    if (!response.ok)
      throw new Error(`فشل تنزيل الفيديو الناتج (HTTP ${response.status}).`);
    const contentType = (response.headers.get("content-type") || "")
      .split(";", 1)[0]
      .toLowerCase();
    if (contentType !== "video/mp4")
      throw new Error("صيغة الفيديو الناتج ليست MP4.");
    const buffer = await readLimited(response);
    if (!isMp4(buffer)) throw new Error("ملف الفيديو الناتج غير صالح.");
    return { buffer, contentType: "video/mp4" };
  }
  throw new Error("تعذر الوصول إلى ملف الفيديو الناتج.");
}

async function generateVideo(reference) {
  const videoUrl = await createVideo(reference);
  return downloadVideo(videoUrl);
}

function safeErrorMessage(error) {
  const token = process.env.HF_TOKEN?.trim();
  const message = String(error?.message || error || "خطأ غير معروف");
  return (token ? message.split(token).join("[hidden]") : message).slice(
    0,
    300,
  );
}

function checkLimits(userId) {
  if (activeUsers.has(userId)) return "busy";
  const now = Date.now();
  globalRequestTimes = globalRequestTimes.filter(
    (time) => now - time < 60 * 60 * 1000,
  );
  const userTimes = (requestTimesByUser.get(userId) || []).filter(
    (time) => now - time < 60 * 60 * 1000,
  );
  if (
    userTimes.length >= MAX_REQUESTS_PER_USER_HOUR ||
    globalRequestTimes.length >= MAX_REQUESTS_PER_HOUR
  )
    return "hourly";
  userTimes.push(now);
  requestTimesByUser.set(userId, userTimes);
  globalRequestTimes.push(now);
  return null;
}

async function tryHandle(context, deps) {
  if (!isCommand(context?.text)) return false;
  if (!hasReferenceSource(context)) {
    await deps.sendText(
      context.threadId,
      "ردّ على صورة بالأمر «فيديو» (أو «حرك») لتحويلها إلى مقطع فيديو قصير.",
      context.isGroup,
    );
    return true;
  }
  const userId = String(context.userId);
  const limited = checkLimits(userId);
  if (limited) {
    await deps.sendText(
      context.threadId,
      limited === "busy"
        ? "لديك طلب تحويل إلى فيديو قيد التنفيذ؛ انتظر حتى ينتهي."
        : "وصلنا لحد طلبات تحويل الصور إلى فيديو؛ حاول بعد قليل.",
      context.isGroup,
    );
    return true;
  }

  activeUsers.add(userId);
  await deps.sendText(
    context.threadId,
    "⏳ بحرّك الصورة وبحوّلها لفيديو؛ قد يستغرق ده بضع دقائق.",
    context.isGroup,
  );
  const request = Promise.resolve()
    .then(async () => {
      const loadReference = deps.getReference || getReference;
      const reference = await loadReference(context);
      if (!reference)
        throw new Error("لم أجد صورة للرد عليها؛ أرسل صورة أو ردّ عليها بالأمر.");
      const create = deps.generateVideo || generateVideo;
      const video = await create(reference);
      if (!isMp4(video?.buffer) || video.contentType !== "video/mp4")
        throw new Error("مولّد الفيديو لم يُرجع ملف MP4 صالحاً.");
      const sent = await deps.sendVideo(
        context.threadId,
        video.buffer,
        video.contentType,
        "🎞️ الصورة بعد تحويلها لفيديو قصير.",
        context.isGroup,
      );
      if (!sent) throw new Error("تعذر إرسال الفيديو إلى المحادثة.");
    })
    .catch(async (error) => {
      const message = safeErrorMessage(error);
      console.error(`[image-to-video] request failed: ${message}`);
      await deps.sendText(
        context.threadId,
        `⚠️ تعذّر تحويل الصورة إلى فيديو: ${message}`,
        context.isGroup,
      );
    })
    .finally(() => activeUsers.delete(userId));
  backgroundRequests.add(request);
  request.then(
    () => backgroundRequests.delete(request),
    () => backgroundRequests.delete(request),
  );
  return true;
}

function createDeps(messenger) {
  return {
    sendText: (threadId, text, isGroup) =>
      isGroup
        ? messenger.sendGroup(threadId, text)
        : messenger.sendPrivate(threadId, text),
    sendVideo: async (threadId, buffer, contentType, caption, isGroup) => {
      if (isGroup)
        return Boolean(
          await messenger.sendGroupVideoBufferTracked(
            threadId,
            buffer,
            contentType,
            caption,
          ),
        );
      const result = await messenger.sendPrivateVideoBufferWithResult(
        threadId,
        buffer,
        contentType,
        caption,
      );
      return Boolean(result?.ok);
    },
  };
}

module.exports = {
  tryHandle,
  isCommand,
  createDeps,
  idle: () => Promise.all([...backgroundRequests]),
  _internal: {
    parseCommand,
    validateReference,
    getSpaceUrl,
    allowedVideoUrl,
    isMp4,
    createVideo,
    downloadVideo,
    extractVideoUrl,
    reset() {
      requestTimesByUser.clear();
      activeUsers.clear();
      backgroundRequests.clear();
      globalRequestTimes = [];
    },
  },
};
