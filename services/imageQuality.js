"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { upscaler } = require("upscayl-node");
const designAssistant = require("./designAssistant");
const msg = require("./messenger");

const MAX_REQUESTS_PER_MINUTE = 4;
const MAX_REQUEST_IMAGE_BYTES = 5 * 1024 * 1024;
const UPSCALE_TIMEOUT_MS = 120_000;
const UPSCALE_MODEL = "realesrgan-x4plus";
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const UPSCAYL_PLATFORM = {
  win32: "win",
  darwin: "mac",
  linux: "linux",
}[process.platform];
const UPSCAYL_EXECUTABLE = path.join(
  path.dirname(require.resolve("upscayl-node")),
  "upscaler",
  "sub-classes",
  "driver",
  "command-upscayl",
  "resources",
  UPSCAYL_PLATFORM || process.platform,
  "bin",
  process.platform === "win32" ? "upscayl-bin.exe" : "upscayl-bin",
);
const requestTimes = new Map();
const inFlight = new Set();
const backgroundRequests = new Set();
let upscalerBusy = false;
const processRunner = { spawn };

function runUpscayl(
  inputPath,
  outputPath,
  model,
  timeoutMs = UPSCALE_TIMEOUT_MS,
) {
  const modelName = path.basename(model);
  const modelDirectory = path.dirname(model);
  const args = [
    "-i",
    inputPath,
    "-o",
    outputPath,
    "-m",
    modelDirectory,
    "-n",
    modelName,
    "-f",
    "png",
    "-c",
    "0",
    "-t",
    "128",
  ];

  return new Promise((resolve, reject) => {
    if (upscalerBusy) {
      reject(new Error("محرك Upscayl ما زال يعالج الطلب السابق."));
      return;
    }

    const child = processRunner.spawn(UPSCAYL_EXECUTABLE, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    upscalerBusy = true;
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        reject(
          new Error(
            "تجاوز Upscayl مهلة التنفيذ (دقيقتان). قد لا تكون بطاقة Vulkan مدعومة أو سريعة بما يكفي.",
          ),
        );
      }
    }, timeoutMs);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.once("error", (error) => {
      upscalerBusy = false;
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (code, signal) => {
      upscalerBusy = false;
      clearTimeout(timer);
      if (settled || timedOut) return;
      settled = true;
      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() ||
              `انتهى Upscayl دون نجاح (code=${code}, signal=${signal || "none"}).`,
          ),
        );
        return;
      }
      resolve({ stderr });
    });
  });
}

const internal = { processRunner, runUpscayl };

async function upscaleImage(reference) {
  if (!Buffer.isBuffer(reference?.buffer) || reference.buffer.length === 0)
    throw new Error("تعذر قراءة الصورة المطلوب تحسينها.");
  if (reference.buffer.length > MAX_REQUEST_IMAGE_BYTES)
    throw new Error("حجم الصورة أكبر من الحد المسموح (5 ميغابايت).");

  const contentType = String(reference.contentType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const extension = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
  }[contentType];
  if (!extension)
    throw new Error("صيغة الصورة غير مدعومة؛ استخدم PNG أو JPEG أو WEBP.");

  const model = upscaler
    .getModels()
    .find((modelPath) => path.basename(modelPath) === UPSCALE_MODEL);
  if (!model)
    throw new Error("ملفات نموذج Upscayl/Real-ESRGAN غير متوفرة.");

  const workDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "detective-quality-"),
  );
  try {
    const inputPath = path.join(workDirectory, `source${extension}`);
    const outputPath = path.join(workDirectory, "upscaled.png");
    await fs.writeFile(inputPath, reference.buffer);
    let processResult;
    try {
      processResult = await internal.runUpscayl(inputPath, outputPath, model);
    } catch (error) {
      const details =
        typeof error === "string" ? error : error?.message || "سبب غير معروف";
      throw new Error(
        `تعذر تشغيل Upscayl/Real-ESRGAN. تأكد من دعم الجهاز لـVulkan وتحديث تعريف الرسوميات. التفاصيل: ${details}`,
      );
    }

    let buffer;
    try {
      buffer = await fs.readFile(outputPath);
    } catch (error) {
      if (error.code === "ENOENT")
        throw new Error(
          `لم ينتج Upscayl صورة. تأكد من دعم الجهاز لـVulkan وتحديث تعريف الرسوميات.${
            processResult?.stderr?.trim()
              ? ` التفاصيل: ${processResult.stderr.trim()}`
              : ""
          }`,
        );
      throw error;
    }
    if (
      buffer.length < PNG_SIGNATURE.length ||
      !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    )
      throw new Error("أنتج Upscayl ملفاً غير صالح بدلاً من صورة PNG.");

    return {
      buffer,
      contentType: "image/png",
      model: "Upscayl / Real-ESRGAN 4×",
    };
  } finally {
    await fs.rm(workDirectory, { recursive: true, force: true });
  }
}

function requestKey(context) {
  return `${context.threadId}:${context.userId}`;
}

function enforceRequestLimit(context) {
  const key = requestKey(context);
  const now = Date.now();
  const recent = (requestTimes.get(key) || []).filter(
    (time) => now - time < 60_000,
  );
  if (recent.length >= MAX_REQUESTS_PER_MINUTE)
    throw new Error("تم بلوغ حد طلبات تحسين الصور؛ انتظر دقيقة ثم حاول مجدداً.");
  recent.push(now);
  requestTimes.set(key, recent);
  if (requestTimes.size > 5000)
    requestTimes.delete(requestTimes.keys().next().value);
  return key;
}

function sendText(context, text) {
  return context.isGroup
    ? msg.sendGroup(context.threadId, text)
    : msg.sendPrivate(context.userId, text);
}

async function sendImage(context, image) {
  const caption = `✅ تم تحسين جودة الصورة باستخدام ${image.model}. قد تختلف بعض التفاصيل بشكل بسيط.`;
  if (context.isGroup) {
    const messageId = await msg.sendGroupImageBufferTracked(
      context.threadId,
      image.buffer,
      image.contentType,
      caption,
    );
    if (!messageId) throw new Error("تعذر إرسال الصورة المحسّنة.");
    return messageId;
  }
  const result = await msg.sendPrivateImageBufferWithResult(
    context.userId,
    image.buffer,
    image.contentType,
    caption,
  );
  if (!result?.ok)
    throw new Error(result?.userMessage || "تعذر إرسال الصورة المحسّنة.");
  return result;
}

async function handle(context) {
  if (!context.messageReply && !context.designReference)
    return sendText(
      context,
      "ردّ على الصورة التي تريد تحسينها بكلمة «جودة». يقبل الأمر صور PNG وJPEG وWEBP.",
    );

  const key = requestKey(context);
  let reserved = false;
  try {
    if (inFlight.has(key))
      throw new Error("هناك طلب تحسين صورة قيد التنفيذ؛ انتظر حتى ينتهي.");
    if (inFlight.size > 0)
      throw new Error("هناك صورة أخرى قيد التحسين؛ انتظر حتى تنتهي.");
    if (upscalerBusy)
      throw new Error("محرك Upscayl ما زال يعالج صورة؛ حاول بعد اكتمالها.");
    enforceRequestLimit(context);
    inFlight.add(key);
    reserved = true;
    await sendText(
      context,
      "⏳ استلمت الصورة؛ جارٍ تحسينها بـUpscayl وسأرسلها هنا عند الانتهاء.",
    );
  } catch (error) {
    if (reserved) inFlight.delete(key);
    return sendText(context, `⚠️ ${error.message || "تعذر تحسين الصورة."}`);
  }

  const request = Promise.resolve()
    .then(async () => {
      const reference =
        context.designReference ||
        (context.messageReply
          ? await designAssistant.getReplyImage(context.messageReply)
          : null);
      if (!reference)
        throw new Error(
          "لم أجد صورة في الرسالة التي رددت عليها. ردّ على الصورة نفسها ثم أرسل «جودة».",
        );
      const image = await upscaleImage(reference);
      await sendImage(context, image);
    })
    .catch(async (error) => {
      console.error("[image-quality] request failed:", error.message);
      try {
        await sendText(context, `⚠️ ${error.message || "تعذر تحسين الصورة."}`);
      } catch (reportError) {
        console.error(
          "[image-quality] unable to report request failure:",
          reportError.message,
        );
      }
    })
    .finally(() => inFlight.delete(key));
  backgroundRequests.add(request);
  request.then(() => backgroundRequests.delete(request));
  return true;
}

module.exports = {
  handle,
  _internal: Object.assign(internal, {
    reset() {
      requestTimes.clear();
      inFlight.clear();
    },
    waitForIdle: () => Promise.all([...backgroundRequests]),
  }),
};
