const test = require("node:test");
const assert = require("node:assert/strict");
const messenger = require("./messenger");

test("user info normalization supports FCA keyed objects, direct objects, and lists", () => {
  const user = { id: "123", name: "Player", firstName: "Player" };
  assert.equal(messenger.normalizeUserInfo("123", { 123: user }), user);
  assert.equal(messenger.normalizeUserInfo("123", user), user);
  assert.equal(messenger.normalizeUserInfo("123", [user]), user);
  assert.equal(messenger.normalizeUserInfo("456", [user]), null);
});

test("profile normalization returns a safe name and avatar URL", () => {
  assert.deepEqual(
    messenger.normalizeUserProfile("123", {
      123: {
        id: "123",
        name: "Player\nName",
        thumbSrc: "https://scontent.xx.fbcdn.net/avatar.jpg",
      },
    }),
    {
      name: "PlayerName",
      avatarUrls: ["https://scontent.xx.fbcdn.net/avatar.jpg"],
    },
  );
  assert.equal(messenger.normalizeUserProfile("456", {}), null);
});

test("outgoing command examples omit slash prefixes without changing URLs", () => {
  assert.equal(
    messenger.formatDisplayedCommands(
      "اكتب /رسم أو /drawinghelp، ثم رد على بطاقة القدرة برقم اللاعب.",
    ),
    "اكتب رسم أو drawinghelp، ثم رد على بطاقة القدرة برقم اللاعب.",
  );
  assert.equal(
    messenger.formatDisplayedCommands("الرابط https://example.com/draw"),
    "الرابط https://example.com/draw",
  );
});
