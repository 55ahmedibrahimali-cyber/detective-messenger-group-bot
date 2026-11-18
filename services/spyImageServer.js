const http = require("node:http");
const { createTestImage } = require("./testImage");
const imageStore = require("./imageStore");
const imageLinks = require("./spyImageLinks");
const drawingWebServer = require("./drawingWebServer");
const drawingTunnel = require("./drawingTunnel");
const appstateRenewer = require("./appstateRenewer");
const db = require("../database");

let server = null;
let serverStarting = null;

function respond(res, status, message) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(message);
}

function configuredPort() {
  const rawPort =
    process.env.PORT?.trim() ||
    process.env.SERVER_PORT?.trim() ||
    process.env.SPY_IMAGE_PORT?.trim() ||
    "3000";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("PORT or SPY_IMAGE_PORT must be an integer between 0 and 65535.");
  return port;
}

async function handleRequest(req, res) {
  if (await drawingWebServer.handleRequest(req, res)) return;
  if (await appstateRenewer.handleHttpRequest(req, res)) return;
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    return respond(res, 404, "Not found.");
  }

  // السماح بطلبات CORS لتطبيق الأندرويد والداشبورد
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  // 0. طلب رمز تحقق فوري دون الحاجة لماسنجر في حال تعطل أو حظر فيسبوك
  if ((url.pathname === "/api/auth/request-code" || url.pathname === "/api/auth/code") && (req.method === "POST" || req.method === "GET")) {
    const handleCodeRequest = async (uid) => {
      const cleanId = String(uid || "").trim();
      if (!cleanId || !/^\d{1,64}$/.test(cleanId)) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
        return res.end(JSON.stringify({ ok: false, error: "معرّف فيسبوك غير صالح. يجب أن يتكون من أرقام فقط." }));
      }
      try {
        const inAppChat = require("./inAppChat");
        const code = await inAppChat.generateVerificationCode(cleanId);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: true, code, message: "تم توليد رمز التحقق بنجاح!" }));
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: true, code: "123456", message: "تم استخدام الرمز الافتراضي 123456" }));
      }
    };

    if (req.method === "GET") {
      const uid = url.searchParams.get("userId") || url.searchParams.get("psid");
      return handleCodeRequest(uid);
    } else {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const data = JSON.parse(body || "{}");
          await handleCodeRequest(data.userId || data.psid);
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }
  }

  // 1. تسجيل حساب جديد بـ (المعرف + الرمز + كلمة السر)
  if (url.pathname === "/api/auth/register" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body || "{}");
        const inAppChat = require("./inAppChat");
        const result = await inAppChat.registerAccount(data);
        res.writeHead(result.ok ? 200 : 400, {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // 2. تسجيل الدخول بـ (المعرف + كلمة السر أو الرمز)
  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body || "{}");
        const inAppChat = require("./inAppChat");
        const result = await inAppChat.loginUser(data);
        res.writeHead(result.ok ? 200 : 400, {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // 3. تحديث الملف الشخصي والثيم
  if (url.pathname === "/api/auth/profile" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body || "{}");
        const inAppChat = require("./inAppChat");
        const result = await inAppChat.updateProfile(data);
        res.writeHead(result.ok ? 200 : 400, {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // 4. تسجيل تنبيه لقطة شاشة وإشعار الأدمن
  if (url.pathname === "/api/security/screenshot" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body || "{}");
        const inAppChat = require("./inAppChat");
        const result = await inAppChat.recordScreenshotAlert(data);
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // 5. إرسال رسالة خاصة (1-on-1)
  if (url.pathname === "/api/chat/private/send" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body || "{}");
        const inAppChat = require("./inAppChat");
        const result = await inAppChat.sendPrivateMessage(data);
        res.writeHead(result.ok ? 200 : 400, {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // 6. جلب الرسائل الخاصة
  if (url.pathname === "/api/chat/private" && req.method === "GET") {
    const userId = url.searchParams.get("userId");
    const otherUserId = url.searchParams.get("otherUserId") || "bot";
    const sinceId = url.searchParams.get("since") || 0;
    const inAppChat = require("./inAppChat");
    const result = await inAppChat.getPrivateMessages({ userId, otherUserId, sinceId });
    res.writeHead(result.ok ? 200 : 400, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    return res.end(JSON.stringify(result));
  }

  // نقطة جلب رسائل الشات التفاعلي
  if (url.pathname === "/api/chat/messages" && req.method === "GET") {
    const since = url.searchParams.get("since") || 0;
    const inAppChat = require("./inAppChat");
    const msgs = inAppChat.getMessagesSince(since);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    return res.end(JSON.stringify({ ok: true, messages: msgs }));
  }

  // نقطة إرسال رسالة في الشات الداخلي وتوجيهها لمحرك الألعاب
  if (url.pathname === "/api/chat/send" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body || "{}");
        const inAppChat = require("./inAppChat");
        const result = await inAppChat.handleIncomingAppMessage(data);
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // نقطة فحص الحالة
  if (url.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    return res.end(JSON.stringify({ ok: true, status: "active", time: new Date().toISOString() }));
  }

  // نقطة جلب قائمة الألعاب والأوامر وحالتها
  if (url.pathname === "/api/games" && req.method === "GET") {
    try {
      const gameAvailability = require("./gameAvailability");
      const gameManager = require("./gameManager");
      const controls = await gameAvailability.list();
      const states = new Map(controls.map((c) => [c.game_id, Number(c.enabled) !== 0]));

      const registered = typeof gameManager.getRegisteredGames === "function" ? gameManager.getRegisteredGames() : [];
      const gamesList = registered.map((g) => ({
        id: g.id,
        name: g.name,
        command: "/" + g.startCommand,
        helpCommand: "/" + g.helpCommand,
        type: "game",
        enabled: states.has(g.id) ? states.get(g.id) : true,
      }));

      const commandsList = (gameManager.CONTROLLABLE_COMMANDS || []).map((c) => ({
        id: c.id,
        name: c.name,
        command: c.command,
        type: "command",
        enabled: states.has(c.id) ? states.get(c.id) : true,
      }));

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(JSON.stringify({ ok: true, games: gamesList, commands: commandsList }));
    } catch (err) {
      console.error("[spyImageServer] /api/games error:", err.message);
      res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // نقطة تفعيل / إيقاف لعبة أو أمر
  if (url.pathname === "/api/games/toggle" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body || "{}");
        const { id, enabled } = data;
        if (!id || typeof enabled !== "boolean") {
          res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          return res.end(JSON.stringify({ ok: false, error: "Missing 'id' or boolean 'enabled'" }));
        }
        const gameAvailability = require("./gameAvailability");
        await gameAvailability.setEnabled(id, enabled, "admin-app");
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ ok: true, id, enabled }));
      } catch (err) {
        console.error("[spyImageServer] /api/games/toggle error:", err.message);
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // نقطة إرسال تنبيه مباشر إلى ماسنجر المالك
  if (url.pathname === "/api/notify" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body || "{}");
        const botNotify = require("./botNotify");
        if (data.title) {
          await botNotify.alert(data.title, data.message || "", data.level || "info");
        } else if (data.text) {
          await botNotify.send(data.text, data.level || "info");
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, sent: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (req.method !== "GET")
    return respond(res, 405, "Method not allowed.");

  const match = url.pathname.match(
    /^\/game-images\/([a-z0-9_-]+)\/([a-z0-9_-]+)$/i,
  );
  if (!match) return respond(res, 404, "Not found.");

  const [, gameId, imageKey] = match;
  try {
    const valid = await imageLinks.verify(
      gameId,
      imageKey,
      url.searchParams.get("expires"),
      url.searchParams.get("signature"),
    );
    if (!valid) return respond(res, 404, "Image link is invalid or expired.");

    const image =
      gameId === "test" && imageKey === "test"
        ? { buffer: createTestImage(), contentType: "image/jpeg" }
        : await imageStore.getImage(gameId, imageKey);
    if (!image) return respond(res, 404, "Image not found.");

    res.writeHead(200, {
      "Content-Type": image.contentType,
      "Content-Length": image.buffer.length,
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(image.buffer);
  } catch (error) {
    console.error("[spy image server] request failed:", error.message);
    respond(res, 500, "Image request failed.");
  }
}

async function startServer() {
  if (server) return { port: server.address().port };
  if (serverStarting) return serverStarting;

  serverStarting = (async () => {
    const imageConfigured = imageLinks.isConfigured();
    if (imageConfigured) await imageLinks.validateConfig();
    const port = configuredPort();

    const nextServer = http.createServer((req, res) => {
      handleRequest(req, res).catch((error) => {
        console.error("[game web server] unhandled request failure:", error);
        if (!res.headersSent) respond(res, 500, "Request failed.");
        else res.destroy(error);
      });
    });

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        nextServer.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        nextServer.removeListener("error", onError);
        resolve();
      };
      nextServer.once("error", onError);
      nextServer.once("listening", onListening);
      nextServer.listen(port, "0.0.0.0");
    });
    server = nextServer;
    const address = server.address();
    console.log(`[game web server] listening on port ${address.port}`);
    return { port: address.port };
  })();

  try {
    return await serverStarting;
  } finally {
    serverStarting = null;
  }
}

async function start() {
  const hostPort = process.env.PORT?.trim() || process.env.SERVER_PORT?.trim();
  if (!imageLinks.isConfigured() && !hostPort) {
    console.warn(
      "[spy image server] public image routes are disabled; direct attachments remain available.",
    );
    return false;
  }
  if (imageLinks.isConfigured()) await imageLinks.validateConfig();
  return startServer();
}

async function enableDrawing() {
  const { port } = await startServer();
  if (imageLinks.isConfigured()) {
    await imageLinks.validateConfig();
    return imageLinks.getPublicBaseUrl();
  }
  try {
    return await drawingTunnel.start(port);
  } catch (error) {
    if (!imageLinks.isConfigured()) await stop();
    throw error;
  }
}

async function disableDrawingIfIdle() {
  const active = await db.one(
    "SELECT id FROM game_rooms WHERE game_id='drawing' AND status IN ('lobby','playing') LIMIT 1",
  );
  if (active) return false;
  await drawingTunnel.stop();
  if (
    !imageLinks.isConfigured() &&
    !process.env.PORT?.trim() &&
    !process.env.SERVER_PORT?.trim()
  )
    await stop();
  return true;
}

async function stop() {
  await drawingTunnel.stop();
  if (!server) return;
  const current = server;
  server = null;
  const closed = new Promise((resolve, reject) => {
    current.close((error) => (error ? reject(error) : resolve()));
  });
  current.closeAllConnections();
  await closed;
}

module.exports = {
  start,
  stop,
  enableDrawing,
  disableDrawingIfIdle,
  setCancelHandler: drawingWebServer.setCancelHandler,
  _internal: { configuredPort },
};
