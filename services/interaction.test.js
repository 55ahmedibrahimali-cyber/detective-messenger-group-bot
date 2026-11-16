const test = require("node:test");
const assert = require("node:assert/strict");
const { lobbyMessage, joinAnnouncement } = require("./interaction");

test("lobby messages explain joining, timing, and that players must message the bot first", () => {
  const message = lobbyMessage({
    title: "لعبة المستذئب",
    tagline: "اكتشفوا الذئاب.",
    min: 4,
    max: 8,
    seconds: 60,
    leaveCommand: "/خروج ذئب",
  });

  assert.match(message, /تفاعل للانضمام/);
  assert.match(message, /4–8 لاعباً/);
  assert.match(message, /ينتهي بعد 60 ثانية/);
  assert.match(message, /راسل البوت في الخاص أولاً/);
  assert.doesNotMatch(message, /دقيقة/);
  assert.match(message, /للمغادرة: \/خروج ذئب/);
});

test("lobby messages require a working game-specific leave command", () => {
  assert.throws(
    () =>
      lobbyMessage({
        title: "لعبة",
        min: 3,
        max: 8,
        seconds: 60,
      }),
    /leaveCommand/,
  );
});

test("join announcements are limited to registration milestones", () => {
  assert.equal(joinAnnouncement({ count: 2, min: 4, max: 8 }), null);
  assert.match(joinAnnouncement({ count: 4, min: 4, max: 8 }), /وصل التسجيل/);
  assert.match(joinAnnouncement({ count: 8, min: 4, max: 8 }), /اكتمل عدد اللاعبين/);
});
