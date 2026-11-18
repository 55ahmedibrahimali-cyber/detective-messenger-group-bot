const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const db = require("../database");
const CFG = require("../games/drawing/config");

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_IEND = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
const PAGE_PATH = path.join(__dirname, "..", "games", "drawing", "public", "index.html");
let pageTemplate;
let cancelHandler = null;

function setCancelHandler(handler) {
  if (typeof handler !== "function") {
    throw new TypeError("Drawing cancel handler must be a function.");
  }
  const previous = cancelHandler;
  cancelHandler = handler;
  return previous;
}

function respond(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  });
  res.end(body);
}

function jsonResponse(res, status, value) {
  return respond(res, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function encodeScriptValue(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

async function getPageTemplate() {
  if (!pageTemplate) pageTemplate = await fs.readFile(PAGE_PATH, "utf8");
  return pageTemplate;
}

function decodePng(dataURL) {
  if (typeof dataURL !== "string" || !dataURL.startsWith("data:image/png;base64,"))
    throw new Error("يجب إرسال الرسمة بصيغة PNG.");
  const encoded = dataURL.slice("data:image/png;base64,".length);
  if (!encoded || encoded.length > Math.ceil(CFG.IMAGE_MAX_BYTES * 4 / 3) + 8)
    throw new Error("حجم الرسمة أكبر من الحد المسموح.");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    throw new Error("بيانات الصورة غير صالحة.");
  const image = Buffer.from(encoded, "base64");
  if (
    image.length < 45 ||
    image.length > CFG.IMAGE_MAX_BYTES ||
    !image.subarray(0, 8).equals(PNG_SIGNATURE) ||
    image.toString("ascii", 12, 16) !== "IHDR" ||
    !image.includes(PNG_IEND)
  )
    throw new Error("ملف PNG غير صالح أو حجمه أكبر من الحد المسموح.");
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  if (
    width < 1 ||
    width > 2000 ||
    height < 1 ||
    height > 1500 ||
    width * height > 3000000
  )
    throw new Error("أبعاد الرسمة غير صالحة.");
  return image;
}

async function serveDrawingPage(token, res) {
  if (!TOKEN_PATTERN.test(token))
    return respond(res, 404, "الرابط غير صالح أو انتهت صلاحيته.");
  const row = await db.one(
    `SELECT ds.word FROM drawing_submissions ds
     JOIN game_rooms gr ON gr.id=ds.room_id
     WHERE ds.token_hash=?
       AND ds.status IN ('issued','queued','publishing','published','solved','expired')
       AND ds.token_expires_at>NOW() AND gr.game_id='drawing'
       AND gr.status='playing' ORDER BY ds.id DESC LIMIT 1`,
    [crypto.createHash("sha256").update(token).digest("hex")],
  );
  if (!row) return respond(res, 404, "الرابط غير صالح أو انتهت صلاحيته.");

  const html = (await getPageTemplate())
    .replace("__DRAWING_TOKEN_JSON__", encodeScriptValue(token))
    .replace("__DRAWING_WORD_JSON__", encodeScriptValue(row.word))
    .replace(
      "__DRAWING_INTERVAL_SECONDS_JSON__",
      String(CFG.PUBLISH_INTERVAL_SECONDS),
    );
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(html);
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers["content-length"] || 0);
    if (declaredLength > maxBytes) {
      req.resume();
      reject(new Error("BODY_TOO_LARGE"));
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        chunks.length = 0;
        req.resume();
        reject(new Error("BODY_TOO_LARGE"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("INVALID_JSON"));
      }
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function validSameOrigin(req) {
  const origin = req.headers.origin;
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toLowerCase();
  if (!origin) {
    const secFetchSite = req.headers["sec-fetch-site"];
    if (secFetchSite === "same-origin" || secFetchSite === "same-site") return true;
    const referer = req.headers.referer;
    if (referer) {
      try {
        const refUrl = new URL(referer);
        return (
          refUrl.host.toLowerCase() === host ||
          refUrl.hostname.toLowerCase() === host.split(":")[0]
        );
      } catch {
        return false;
      }
    }
    return true;
  }
  try {
    const url = new URL(origin);
    const originHost = url.host.toLowerCase();
    const originHostname = url.hostname.toLowerCase();
    const targetHostname = host.split(":")[0];
    return (
      originHost === host ||
      originHostname === targetHostname ||
      originHostname === "localhost" ||
      originHostname === "127.0.0.1" ||
      originHostname === "::1"
    );
  } catch {
    return false;
  }
}

async function submitDrawing(req, res) {
  if (!validSameOrigin(req)) {
    jsonResponse(res, 403, { error: "مصدر الطلب غير مسموح." });
    return;
  }
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) {
    jsonResponse(res, 415, { error: "يجب إرسال الصورة بتنسيق JSON." });
    return;
  }

  let payload;
  try {
    payload = await readJsonBody(
      req,
      Math.ceil(CFG.IMAGE_MAX_BYTES * 4 / 3) + 8192,
    );
  } catch (error) {
    const tooLarge = error.message === "BODY_TOO_LARGE";
    jsonResponse(res, tooLarge ? 413 : 400, {
      error: tooLarge ? "الرسمة أكبر من الحد المسموح." : "تعذر قراءة الطلب.",
    });
    return;
  }
  if (!payload || !TOKEN_PATTERN.test(payload.token || "")) {
    jsonResponse(res, 400, { error: "رابط الرسم غير صالح." });
    return;
  }
  let image;
  if (!payload.statusOnly && payload.cancel !== true) {
    try {
      image = decodePng(payload.image);
    } catch (error) {
      jsonResponse(res, 400, { error: error.message });
      return;
    }
  }

  const hash = crypto.createHash("sha256").update(payload.token).digest("hex");
  const result = await db.withTransaction(async (query) => {
    const rows = await query(
      `SELECT ds.id, ds.room_id, ds.player_id, ds.word, ds.aliases_json,
             ds.status, gr.thread_id
       FROM drawing_submissions ds
       JOIN game_rooms gr ON gr.id=ds.room_id
       WHERE ds.token_hash=? AND gr.game_id='drawing' AND gr.status='playing'
        AND ds.token_expires_at>NOW()
      ORDER BY ds.id DESC LIMIT 1 FOR UPDATE`,
      [hash],
    );
    const current = rows[0];
    if (!current) return { state: "expired" };

    if (payload.cancel === true) {
      const cancelled = await query(
        "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=? AND game_id='drawing' AND status='playing'",
        [current.room_id],
      );
      if (cancelled.affectedRows) {
        await query(
          "UPDATE drawing_state SET next_publish_at=NULL WHERE room_id=?",
          [current.room_id],
        );
        await query(
          `UPDATE drawing_submissions SET status='cancelled', image_data=NULL, image_content_type=NULL
           WHERE room_id=? AND status IN ('issued','queued','publishing','published')`,
          [current.room_id],
        );
      }
      return {
        state: cancelled.affectedRows ? "cancelled" : "finished",
        threadId: current.thread_id,
      };
    }

    if (payload.statusOnly) {
      if (current.status === "solved" || current.status === "expired")
        return { state: "finished" };
      if (current.status === "issued") return { state: "ready" };
      return { state: "waiting" };
    }

    if (current.status === "issued") {
      const saved = await query(
        `UPDATE drawing_submissions SET status='queued', image_data=?,
           image_content_type='image/png', submitted_at=NOW()
         WHERE id=? AND status='issued'`,
        [image, current.id],
      );
      if (!saved.affectedRows) return { state: "waiting" };
      await query(
        `UPDATE drawing_state SET next_publish_at=COALESCE(next_publish_at,NOW()),
           round_started_at=COALESCE(round_started_at, NOW())
         WHERE room_id=?`,
        [current.room_id],
      );
      await query(
        "UPDATE game_rooms SET updated_at=NOW() WHERE id=? AND status='playing'",
        [current.room_id],
      );
      return { state: "queued" };
    }

    if (current.status === "solved" || current.status === "expired")
      return { state: "finished" };

    return { state: "waiting" };
  });

  if (result.state === "cancelled" && result.threadId) {
    try {
      await cancelHandler?.({ threadId: String(result.threadId) });
    } catch (error) {
      console.error("[drawing] failed to complete page cancellation:", error);
    }
  }
  if (result.state === "expired") {
    jsonResponse(res, 410, { error: "انتهت صلاحية صفحة الرسم أو انتهت اللعبة." });
    return;
  }
  const { threadId: _threadId, ...response } = result;
  jsonResponse(res, 200, response);
}

async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    respond(res, 404, "Not found.");
    return true;
  }
  if (url.pathname === "/draw/probe-healthcheck") {
    if (req.method !== "GET") {
      respond(res, 405, "Method not allowed.");
      return true;
    }
    respond(res, 204, "");
    return true;
  }
  const pageMatch = url.pathname.match(/^\/draw\/([A-Za-z0-9_-]+)$/);
  if (pageMatch) {
    if (req.method !== "GET") {
      respond(res, 405, "Method not allowed.");
      return true;
    }
    await serveDrawingPage(pageMatch[1], res);
    return true;
  }
  if (url.pathname === "/api/draw") {
    if (req.method !== "POST") {
      respond(res, 405, "Method not allowed.");
      return true;
    }
    await submitDrawing(req, res);
    return true;
  }
  return false;
}

module.exports = { handleRequest, decodePng, setCancelHandler };
