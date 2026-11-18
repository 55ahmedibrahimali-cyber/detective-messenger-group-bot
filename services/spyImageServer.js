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
