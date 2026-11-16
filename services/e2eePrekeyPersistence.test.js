const test = require("node:test");
const assert = require("node:assert/strict");
const { E2EEClient } = require("facebook-chat-api/src/e2ee/client");

test("E2EE signed prekeys are persisted before upload", async () => {
  const operations = [];
  const client = Object.create(E2EEClient.prototype);
  client.store = {
    registrationId: 4,
    generatePreKeys() {
      operations.push("generate");
      return [{ id: 1, pub: Buffer.alloc(32), priv: Buffer.alloc(32) }];
    },
    rotateSignedPreKey() {
      operations.push("rotate");
      return {
        id: 2,
        pub: Buffer.alloc(32).toString("base64"),
        signature: Buffer.alloc(64).toString("base64"),
      };
    },
    save() {
      operations.push("save");
    },
    identityPublic() {
      return Buffer.alloc(32);
    },
  };
  client.nextId = () => "test-prekey";
  client.socket = {
    sendFrame: async () => {
      operations.push("upload");
    },
  };

  await client.uploadPreKeys(1);
  assert.deepEqual(operations, ["generate", "rotate", "save", "upload"]);
});

test("E2EE sync repairs a previously unpersisted signed-prekey rotation", async () => {
  const client = Object.create(E2EEClient.prototype);
  client.store = {
    nextPreKeyId: 66,
    signedPreKeys: { 1: {} },
  };
  let uploaded = 0;
  client.getServerPreKeyCount = async () => 40;
  client.uploadPreKeys = async () => {
    uploaded++;
  };

  await client.syncPreKeys();
  assert.equal(uploaded, 1);
});

test("E2EE sync does not rotate a fresh device when server keys are sufficient", async () => {
  const client = Object.create(E2EEClient.prototype);
  client.store = {
    nextPreKeyId: 1,
    signedPreKeys: { 1: {} },
  };
  let uploaded = false;
  client.getServerPreKeyCount = async () => 40;
  client.uploadPreKeys = async () => {
    uploaded = true;
  };

  await client.syncPreKeys();
  assert.equal(uploaded, false);
});
