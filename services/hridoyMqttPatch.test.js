"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const createListenMqtt = require("../node_modules/hridoy-fca/src/api/socket/core/connectMqtt");

class FakeMqttClient extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.connected = false;
    this.published = [];
  }

  subscribe(topics, callback) {
    this.subscribedTopics = topics;
    this.subscriptionCallback = callback;
  }

  publish(...args) {
    this.published.push(args);
  }

  end() {
    this.connected = false;
    this.emit("close");
  }
}

function createListener(autoReconnect) {
  let client;
  const events = [];
  const topics = ["/t_ms", "/inbox"];
  const listen = createListenMqtt({
    WebSocket: function () {},
    mqtt: {
      Client: function (_stream, options) {
        client = new FakeMqttClient(options);
        return client;
      }
    },
    HttpsProxyAgent: function () {},
    buildStream: function () {},
    buildProxy: function () {},
    topics,
    parseDelta: function () {},
    getTaskResponseData: function () {},
    logger: function () {},
    emitAuth: function () {}
  });
  const ctx = {
    userID: "123",
    clientId: "client",
    lastSeqId: 7,
    globalOptions: { online: true, autoReconnect, emitReady: false },
    _mqttOpt: { reconnectDelayMs: 2000 }
  };
  listen({}, { getCookies: () => "cookie" }, ctx, (...args) => events.push(args));
  return { client, ctx, events, topics };
}

test("MQTT publishes only after successful SUBACK", t => {
  const previousOnStatus = process.env.OnStatus;
  process.env.OnStatus = "test";
  t.after(() => {
    if (previousOnStatus === undefined) delete process.env.OnStatus;
    else process.env.OnStatus = previousOnStatus;
  });

  const { client, ctx, topics } = createListener(true);
  t.after(() => {
    if (ctx._rTimeout) clearTimeout(ctx._rTimeout);
    if (ctx._reconnectTimer) clearTimeout(ctx._reconnectTimer);
  });

  assert.equal(client.options.connectTimeout, 12000);
  client.connected = true;
  client.emit("connect");
  assert.deepEqual(client.subscribedTopics, topics);
  assert.equal(client.published.length, 0);

  client.subscriptionCallback(null, topics.map(topic => ({ topic, qos: 0 })));
  assert.equal(client.published.length, 3);

  client.emit("message", "/t_ms", Buffer.from("{}"));
  assert.equal(ctx._rTimeout, undefined);
});

test("MQTT does not publish after a rejected subscription", t => {
  const { client, events } = createListener(false);
  client.connected = true;
  client.emit("connect");
  client.subscriptionCallback(null, [{ topic: "/t_ms", qos: 128 }]);

  assert.equal(client.published.length, 0);
  assert.equal(events[0][0].type, "stop_listen");
});
