"use strict";

const designAssistant = require("./designAssistant");

const DEFAULT_MODEL = "fal-ai/kling-video/v2.5-turbo/pro/image-to-video";
const MAX_REFERENCE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
const MAX_REQUESTS_PER_USER_HOUR = 2;
const MAX_REQUESTS_PER_HOUR = 20;
const requestTimesByUser = new Map();
const activeUsers = new Set();
const backgroundRequests = new Set();
let globalRequestTimes = [];

const PROMPT = [
  "Create a polished 5-second anime AMV-style motion edit from the supplied image.",
  "Use a general high-energy cinematic anime aesthetic: dramatic high contrast, vivid cyan and violet accent lighting, luminous rim light, restrained glow, atmospheric particles, speed-line accents, subtle motion blur, and smooth dynamic camera push-ins and pans with rhythmic speed changes.",
  "Keep the main subject recognizable and consistent with the supplied image; animate the existing scene without introducing new characters.",
  "Use vertical short-form framing when suitable. Do not add readable text, captions, logos, or watermarks.",
  "Use an original, broadly defined visual treatment; do not imitate any specific creator, channel, or existing video.",
].join(" ");
function normalize(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .trim();
}

function parseCommand(text) {
  const command = String(text || "")
    .trim()
    .replace(/^[/!]\s*/, "")
    .trim();
  const normalized = normalize(command);
  if (["ايديت", "edit"].includes(normalized)) return { action: "animate" };
  return null;
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

function credentials() {
  const apiKey = process.env.FAL_KEY?.trim();
  if (!apiKey)
    throw new Error(
      "أضف FAL_KEY محلياً إلى ملف البيئة لتفعيل توليد الفيديو عبر Fal.ai.",
    );
  return apiKey;
}

function imageExtension(contentType) {
  if (contentType === "image/png") return "png";
  if (contentType === "image/jpeg") return "jpg";
  throw new Error("يدعم توليد الفيديو حالياً الصور بصيغة PNG أو JPEG فقط.");
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
    throw new Error("أرسل صورة PNG أو JPEG صالحة لتوليد الفيديو.");
  }
  if (actualType !== contentType)
    throw new Error("نوع الصورة لا يطابق محتوى ملفها.");
  if (!buffer.length || buffer.length > MAX_REFERENCE_BYTES)
    throw new Error("يجب ألا يتجاوز حجم الصورة المرجعية 5 ميغابايت.");
  return { buffer, contentType };
}

async function loadFalClient() {
  const apiKey = credentials();
  const { fal } = await import("@fal-ai/client");
  fal.config({ credentials: apiKey });
  return fal;
}

function falErrorDetails(error) {
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (Number.isInteger(current.status))
      return {
        status: current.status,
        requestId: current.requestId,
      };
    current = current.cause;
  }
  return {};
}

function falStageError(error, stage) {
  const details = falErrorDetails(error);
  const providerDetail = safeErrorMessage(error);
  const permissionHint =
    stage === "رفع الصورة"
      ? "لم يصل الطلب إلى نموذج الفيديو؛ تحقق من أن المفتاح يملك صلاحية API لرفع الملفات."
      : "تحقق من صلاحية FAL_KEY وإمكانية الوصول إلى نموذج الفيديو.";
  const message =
    details.status === 403
      ? `رفض Fal.ai ${stage} (HTTP 403). ${permissionHint} تفاصيل Fal.ai: ${providerDetail}`
      : `تعذّر ${stage} عبر Fal.ai${details.status ? ` (HTTP ${details.status})` : ""}: ${providerDetail}`;
  const wrapped = new Error(message, { cause: error });
  if (details.status) wrapped.status = details.status;
  if (details.requestId)
    wrapped.requestId = String(details.requestId).slice(0, 100);
  return wrapped;
}

async function createVideo(reference, fal, prompt = PROMPT) {
  const prepared = validateReference(reference);
  const file = new File(
    [prepared.buffer],
    `anime-edit-reference.${imageExtension(prepared.contentType)}`,
    { type: prepared.contentType },
  );
  let imageUrl;
  try {
    imageUrl = await fal.storage.upload(file);
  } catch (error) {
    throw falStageError(error, "رفع الصورة");
  }
  const model = process.env.FAL_ANIME_EDIT_MODEL?.trim() || DEFAULT_MODEL;
  let result;
  try {
    result = await fal.subscribe(model, {
      input: {
        image_url: imageUrl,
        prompt,
        duration: "5",
        enable_safety_checker: true,
      },
    });
  } catch (error) {
    throw falStageError(error, "تشغيل نموذج الفيديو");
  }
  const videoUrl = result?.data?.video?.url;
  if (typeof videoUrl !== "string" || !videoUrl)
    throw new Error("لم يُرجع مولّد الفيديو رابطاً صالحاً.");
  return videoUrl;
}

function allowedVideoUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    (url.port && url.port !== "443") ||
    url.username ||
    url.password ||
    !(host === "fal.media" || host.endsWith(".fal.media") ||
      host === "storage.googleapis.com")
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
  for (let redirects = 0; redirects <= 2; redirects++) {
    const url = allowedVideoUrl(currentUrl);
    if (!url) throw new Error("رابط الفيديو الناتج غير آمن أو غير مدعوم.");
    let response;
    try {
      response = await fetch(url, {
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
  const fal = await loadFalClient();
  const videoUrl = await createVideo(reference, fal, PROMPT);
  return downloadVideo(videoUrl);
}

function safeErrorMessage(error) {
  const apiKey = process.env.FAL_KEY?.trim();
  const messages = [];
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (current.message) messages.push(String(current.message));
    current = current.cause;
  }
  const message = messages.join(" <- ") || String(error || "خطأ غير معروف");
  return (apiKey ? message.split(apiKey).join("[hidden]") : message).slice(
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
  const command = parseCommand(context?.text);
  if (!command) return false;
  if (!process.env.FAL_KEY?.trim()) {
    await deps.sendText(
      context.threadId,
      "أضف FAL_KEY محلياً إلى ملف البيئة لتفعيل إنشاء الإيديت عبر Fal.ai.",
      context.isGroup,
    );
    return true;
  }
  if (!hasReferenceSource(context)) {
    await deps.sendText(
      context.threadId,
      "ردّ على صورة أو أرسلها مع الأمر «ايديت» لإنشاء مقطع أنمي قصير.",
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
        ? "لديك طلب إيديت قيد التنفيذ؛ انتظر حتى ينتهي."
        : "وصلنا لحد طلبات الإيديت؛ حاول بعد قليل.",
      context.isGroup,
    );
    return true;
  }

  activeUsers.add(userId);
  await deps.sendText(
    context.threadId,
    "⏳ أجهّز مقطع الإيديت؛ قد يستغرق التوليد بضع دقائق.",
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
        "🎬 إيديت أنمي قصير بطابع AMV عام.",
        context.isGroup,
      );
      if (!sent) throw new Error("تعذر إرسال الفيديو إلى المحادثة.");
    })
    .catch(async (error) => {
      const message = safeErrorMessage(error);
      const requestId = error?.requestId
        ? ` requestId=${String(error.requestId).slice(0, 100)}`
        : "";
      console.error(
        `[anime edit] request failed: ${message}${requestId}`,
      );
      await deps.sendText(
        context.threadId,
        `⚠️ تعذّر إنشاء الإيديت: ${message}`,
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
    allowedVideoUrl,
    isMp4,
    createVideo,
    downloadVideo,
    prompt: PROMPT,
    defaultModel: DEFAULT_MODEL,
    reset() {
      requestTimesByUser.clear();
      activeUsers.clear();
      backgroundRequests.clear();
      globalRequestTimes = [];
    },
  },
};
