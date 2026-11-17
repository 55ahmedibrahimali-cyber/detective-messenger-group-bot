const test = require("node:test");
const assert = require("node:assert/strict");
const imageLinks = require("./spyImageLinks");
const imageServer = require("./spyImageServer");

async function withEnvironment(values, callback) {
  const previous = new Map(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("the host PORT takes precedence over the configured spy image port", async () => {
  await withEnvironment(
    { PORT: "4100", SERVER_PORT: "4200", SPY_IMAGE_PORT: "3000" },
    () => assert.equal(imageServer._internal.configuredPort(), 4100),
  );
});

test("uses SERVER_PORT when the host does not provide PORT", async () => {
  await withEnvironment(
    { PORT: undefined, SERVER_PORT: "4200", SPY_IMAGE_PORT: "3000" },
    () => assert.equal(imageServer._internal.configuredPort(), 4200),
  );
});

test("starts the drawing health endpoint on the host-assigned port", async () => {
  await withEnvironment(
    {
      PORT: "0",
      SERVER_PORT: undefined,
      SPY_IMAGE_PORT: "3000",
      SPY_IMAGE_PUBLIC_BASE_URL: "",
      PUBLIC_URL: undefined,
      RENDER_EXTERNAL_URL: undefined,
      RAILWAY_PUBLIC_DOMAIN: undefined,
    },
    async () => {
      let started;
      try {
        started = await imageServer.start();
        assert.ok(started.port > 0);
        assert.notEqual(started.port, 3000);
        const response = await fetch(
          `http://127.0.0.1:${started.port}/draw/probe-healthcheck`,
        );
        assert.equal(response.status, 204);
      } finally {
        await imageServer.stop();
      }
    },
  );
});

test("uses a platform public URL when no explicit image URL is set", () => {
  withEnvironment(
    {
      SPY_IMAGE_PUBLIC_BASE_URL: "",
      PUBLIC_URL: "https://public.example.test",
      RENDER_EXTERNAL_URL: "https://render.example.test",
      RAILWAY_PUBLIC_DOMAIN: "railway.example.test",
    },
    () =>
      assert.equal(
        imageLinks.getPublicBaseUrl(),
        "https://public.example.test",
      ),
  );
});
