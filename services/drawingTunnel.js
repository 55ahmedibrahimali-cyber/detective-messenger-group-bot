const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const TAILSCALE_HTTPS_PORT = Number(process.env.TAILSCALE_FUNNEL_PORT || 443);
if (![443, 8443, 10000].includes(TAILSCALE_HTTPS_PORT)) {
  throw new Error("TAILSCALE_FUNNEL_PORT must be 443, 8443, or 10000.");
}
let child = null;
let childProvider = null;
let startPromise = null;
let publicUrl = null;
let tailscalePort = null;
let tailscaleAdopted = false;
let watchdog = null;
let watchdogBusy = false;
let watchdogFailures = 0;
let watchdogGeneration = 0;

function watchdogIntervalMs(value = process.env.DRAWING_TUNNEL_WATCHDOG_SECONDS) {
  if (value === undefined || value === "") return 60000;
  const seconds = Number(value);
  if (
    !Number.isInteger(seconds) ||
    seconds < 0 ||
    seconds > Math.floor(2147483647 / 1000)
  ) {
    throw new Error(
      "DRAWING_TUNNEL_WATCHDOG_SECONDS must be an integer between 0 and 2147483.",
    );
  }
  return seconds * 1000;
}

function fallbackAllowed(value = process.env.DRAWING_TUNNEL_FALLBACK) {
  return value !== "0";
}

function keepTailscaleFunnel(
  adopted,
  value = process.env.DRAWING_TUNNEL_KEEP_ALIVE,
) {
  return adopted || value === "1";
}

function tailscaleStopArgs(port) {
  return [
    "funnel",
    "--yes",
    `--https=${TAILSCALE_HTTPS_PORT}`,
    `http://127.0.0.1:${port}`,
    "off",
  ];
}

function tailscalePublicUrl(value) {
  const url = new URL(value);
  if (TAILSCALE_HTTPS_PORT !== 443 && !url.port) {
    url.port = String(TAILSCALE_HTTPS_PORT);
  }
  return url.toString().replace(/\/$/, "");
}

function configuredProvider() {
  const provider = (process.env.DRAWING_TUNNEL_PROVIDER || "auto")
    .trim()
    .toLowerCase();
  if (!["auto", "tailscale", "cloudflare"].includes(provider))
    throw new Error(
      "DRAWING_TUNNEL_PROVIDER must be auto, tailscale, or cloudflare.",
    );
  return provider;
}

function executableFor(provider) {
  if (provider === "tailscale") {
    const installedExecutable = path.join(
      process.env.ProgramFiles || "C:\\Program Files",
      "Tailscale",
      "tailscale.exe",
    );
    return (
      process.env.TAILSCALE_PATH ||
      (fs.existsSync(installedExecutable) ? installedExecutable : "tailscale")
    );
  }
  const localExecutable = path.join(
    __dirname,
    "..",
    ".nexca",
    "cloudflared.exe",
  );
  return (
    process.env.CLOUDFLARED_PATH ||
    (fs.existsSync(localExecutable) ? localExecutable : "cloudflared")
  );
}

function commandError(provider, error) {
  if (error.code === "ENOENT") {
    let result;
    if (provider === "tailscale")
      result = new Error(
        "Tailscale CLI was not found. Install Tailscale, sign in, enable Funnel for your tailnet, then retry. You can set TAILSCALE_PATH if the CLI is not on PATH.",
      );
    else
      result = new Error(
        "cloudflared was not found. Download https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe and place it at .nexca\\cloudflared.exe, or set CLOUDFLARED_PATH in .env.",
      );
    result.code = error.code;
    return result;
  }
  return new Error(`Could not start ${provider}: ${error.message}`);
}

function existingTailscaleUrl(port) {
  return new Promise((resolve, reject) => {
    const processHandle = spawn(
      executableFor("tailscale"),
      ["funnel", "status", "--json"],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let settled = false;
    const finish = (error, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(url);
    };
    const collect = (chunk) => {
      output = (output + chunk.toString("utf8")).slice(-12000);
    };
    processHandle.stdout.on("data", collect);
    processHandle.stderr.on("data", collect);
    processHandle.once("error", (error) =>
      finish(commandError("tailscale", error)),
    );
    processHandle.once("exit", (code) => {
      if (code !== 0) {
        finish(
          new Error(
            `Could not read Tailscale Funnel status (exit code ${code}).${output ? ` ${output.trim()}` : ""}`,
          ),
        );
        return;
      }

      if (output.trim() === "No serve config") {
        finish(null, null);
        return;
      }
      try {
        const status = JSON.parse(output);
        const webRoutes = Object.entries(status.Web || {}).filter(
          ([address]) => address.endsWith(`:${TAILSCALE_HTTPS_PORT}`),
        );
        if (webRoutes.length === 0) {
          finish(null, null);
          return;
        }

        const expectedTarget = `http://127.0.0.1:${port}`;
        const matchingRoute = webRoutes.find(
          ([, config]) => config.Handlers?.["/"]?.Proxy === expectedTarget,
        );
        if (!matchingRoute) {
          finish(
            new Error(
              `Tailscale Funnel port ${TAILSCALE_HTTPS_PORT} is already configured for another service. Remove or change that route before starting the drawing game.`,
            ),
          );
          return;
        }
        finish(null, tailscalePublicUrl(`https://${matchingRoute[0]}`));
      } catch (error) {
        finish(
          new Error(
            `Could not parse Tailscale Funnel status: ${error.message}`,
          ),
        );
      }
    });

    const timer = setTimeout(() => {
      processHandle.kill();
      finish(new Error("Timed out reading Tailscale Funnel status."));
    }, 10000);
    timer.unref?.();
  });
}

async function waitForReachableUrl(
  url,
  timeoutMs = 30000,
  probePath = "/draw/probe-healthcheck",
) {
  const probeUrl = new URL(probePath, url);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(probeUrl, {
        method: "GET",
        signal: AbortSignal.timeout(2500),
      });
      if (response.status >= 200 && response.status < 300) return;
    } catch {
      // The tunnel may still be warming up; retry until the public URL becomes reachable.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for the public drawing page to become reachable at ${url}.`);
}

function resetState() {
  if (child && child.exitCode === null) child.kill();
  child = null;
  childProvider = null;
  publicUrl = null;
  tailscalePort = null;
  tailscaleAdopted = false;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetries(fn, attempts = 2, delayMs = 3000) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (error.code === "ENOENT") throw error;
      if (attempt < attempts - 1) await sleep(delayMs);
    }
  }
  throw lastError;
}

function startProvider(provider, port) {
  return new Promise((resolve, reject) => {
    const executable = executableFor(provider);
    const args =
      provider === "tailscale"
        ? [
            "funnel",
            "--yes",
            `--https=${TAILSCALE_HTTPS_PORT}`,
            `http://127.0.0.1:${port}`,
          ]
        : ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`];
    const processHandle = spawn(executable, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    child = processHandle;
    childProvider = provider;
    if (provider === "tailscale") tailscalePort = port;

    const finish = (error, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        if (processHandle.exitCode === null) processHandle.kill();
        if (child === processHandle) {
          child = null;
          childProvider = null;
        }
        if (provider === "tailscale") tailscalePort = null;
        publicUrl = null;
        reject(error);
      } else {
        publicUrl = url;
        console.log(`[drawing tunnel] ${provider} tunnel is ready.`);
        waitForReachableUrl(url)
          .then(() => resolve(url))
          .catch((probeError) => {
            publicUrl = null;
            if (child === processHandle) {
              child = null;
              childProvider = null;
            }
            if (provider === "tailscale") tailscalePort = null;
            if (processHandle.exitCode === null) processHandle.kill();
            reject(probeError);
          });
      }
    };

    const readOutput = (chunk) => {
      output = (output + chunk.toString("utf8")).slice(-12000);
      const pattern =
        provider === "tailscale"
          ? /https:\/\/[a-z0-9][a-z0-9.-]*\.ts\.net(?::(?:443|8443|10000))?/i
          : /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
      const match = output.match(pattern);
      if (match) {
        finish(
          null,
          provider === "tailscale" ? tailscalePublicUrl(match[0]) : match[0],
        );
      }
    };
    processHandle.stdout.on("data", readOutput);
    processHandle.stderr.on("data", readOutput);
    processHandle.once("error", (error) =>
      finish(commandError(provider, error)),
    );
    processHandle.once("exit", (code) => {
      if (child === processHandle) {
        child = null;
      }
      if (!settled) {
        childProvider = null;
        if (provider === "tailscale") tailscalePort = null;
        publicUrl = null;
        finish(
          new Error(
            `${provider} exited before the public URL was ready (exit code ${code}).${output ? ` ${output.trim()}` : ""}`,
          ),
        );
      } else if (provider !== "tailscale" || code !== 0) {
        childProvider = null;
        publicUrl = null;
      }
    });

    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `Timed out waiting for the ${provider} public URL. Check the installation, internet connection, and tunnel configuration.`,
          ),
        ),
      30000,
    );
    timer.unref?.();
  });
}

async function startTailscale(port) {
  const currentUrl = await existingTailscaleUrl(port);
  if (!currentUrl) return startProvider("tailscale", port);
  try {
    await waitForReachableUrl(currentUrl, 8000);
  } catch {
    console.warn(
      "[drawing tunnel] existing Tailscale Funnel route is not reachable; re-applying it.",
    );
    return startProvider("tailscale", port);
  }
  child = null;
  childProvider = "tailscale";
  tailscalePort = port;
  tailscaleAdopted = true;
  publicUrl = currentUrl;
  return currentUrl;
}

function startWatchdog(port, intervalMs) {
  if (watchdog) return;
  if (intervalMs === 0) return;

  const generation = ++watchdogGeneration;
  const timer = setInterval(async () => {
    if (watchdog !== timer || generation !== watchdogGeneration || watchdogBusy) {
      return;
    }
    watchdogBusy = true;
    try {
      if (!publicUrl) {
        await start(port);
        return;
      }

      try {
        await waitForReachableUrl(publicUrl, 6000);
        if (watchdog !== timer || generation !== watchdogGeneration) return;
        watchdogFailures = 0;
      } catch {
        if (watchdog !== timer || generation !== watchdogGeneration) return;
        watchdogFailures += 1;
        console.warn(
          `[drawing tunnel] health check failed (${watchdogFailures}/2)`,
        );
        if (watchdogFailures >= 2) {
          watchdogFailures = 0;
          const oldUrl = publicUrl;
          resetState();
          const newUrl = await start(port);
          if (newUrl !== oldUrl) {
            console.warn(
              `[drawing tunnel] public URL changed to ${newUrl}; links already sent keep the old address.`,
            );
          }
        }
      }
    } catch (error) {
      if (watchdog === timer && generation === watchdogGeneration) {
        console.error("[drawing tunnel] recovery failed:", error.message);
      }
    } finally {
      watchdogBusy = false;
    }
  }, intervalMs);
  watchdog = timer;
  watchdog.unref?.();
}

function stopWatchdog() {
  if (watchdog) clearInterval(watchdog);
  watchdog = null;
  watchdogGeneration += 1;
  watchdogFailures = 0;
}

async function start(port) {
  const intervalMs = watchdogIntervalMs();
  if (
    publicUrl &&
    (childProvider === "tailscale" || (child && child.exitCode === null))
  ) {
    try {
      await waitForReachableUrl(publicUrl, 5000);
      startWatchdog(port, intervalMs);
      return publicUrl;
    } catch {
      console.warn(
        "[drawing tunnel] cached public URL is dead; re-establishing the tunnel.",
      );
      resetState();
    }
  }
  if (startPromise) return startPromise;

  startPromise = (async () => {
    const provider = configuredProvider();
    const allowFallback = fallbackAllowed();
    let url = null;
    let tailscaleError = null;

    if (provider !== "cloudflare") {
      try {
        url = await withRetries(() => startTailscale(port));
      } catch (error) {
        tailscaleError = error;
        if (provider === "tailscale" && !allowFallback) throw error;
        console.warn(
          `[drawing tunnel] Tailscale unavailable (${error.message.slice(0, 160)}); trying Cloudflare.`,
        );
      }
    }

    if (!url) {
      try {
        url = await withRetries(() => startProvider("cloudflare", port));
      } catch (error) {
        if (tailscaleError && tailscaleError.code !== "ENOENT") {
          throw new Error(
            `Tailscale: ${tailscaleError.message} | Cloudflare: ${error.message}`,
          );
        }
        if (error.code === "ENOENT") {
          throw new Error(
            "No drawing tunnel is installed. Install and configure Tailscale Funnel, or install cloudflared. See the drawing setup instructions in README.md.",
          );
        }
        throw error;
      }
    }

    startWatchdog(port, intervalMs);
    return url;
  })().finally(() => {
    startPromise = null;
  });
  return startPromise;
}

async function stop() {
  stopWatchdog();
  const current = child;
  const provider = childProvider;
  const activeTailscalePort = tailscalePort;
  const keepFunnel = keepTailscaleFunnel(tailscaleAdopted);
  child = null;
  childProvider = null;
  publicUrl = null;
  tailscalePort = null;
  tailscaleAdopted = false;

  if (
    provider === "tailscale" &&
    activeTailscalePort !== null &&
    !keepFunnel
  ) {
    try {
      await new Promise((resolve, reject) => {
        const stopProcess = spawn(
          executableFor("tailscale"),
          tailscaleStopArgs(activeTailscalePort),
          { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        let output = "";
        const collectOutput = (chunk) => {
          output = (output + chunk.toString("utf8")).slice(-4000);
        };
        stopProcess.stdout.on("data", collectOutput);
        stopProcess.stderr.on("data", collectOutput);
        const timer = setTimeout(() => {
          stopProcess.kill();
          reject(
            new Error(
              `Timed out stopping Tailscale Funnel.${output ? ` ${output.trim()}` : ""}`,
            ),
          );
        }, 10000);
        timer.unref?.();
        stopProcess.once("error", (error) => {
          clearTimeout(timer);
          reject(commandError("tailscale", error));
        });
        stopProcess.once("exit", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else
            reject(
              new Error(
                `Tailscale Funnel stop failed (exit code ${code}).${output ? ` ${output.trim()}` : ""}`,
              ),
            );
        });
      });
    } catch (error) {
      console.warn("[drawing tunnel] Could not stop Tailscale Funnel:", error.message);
    }
  }

  if (current && current.exitCode === null) current.kill();
}

process.on("exit", () => {
  if (child && child.exitCode === null) child.kill();
});

module.exports = {
  start,
  stop,
  configuredProvider,
  waitForReachableUrl,
  tailscaleStopArgs,
  publicHttpsPort: TAILSCALE_HTTPS_PORT,
  _internal: {
    watchdogIntervalMs,
    fallbackAllowed,
    keepTailscaleFunnel,
    tailscalePublicUrl,
  },
};
