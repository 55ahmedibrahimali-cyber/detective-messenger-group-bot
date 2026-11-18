const db = require("../database");
const msg = require("../services/messenger");
const leaderboard = require("../services/leaderboard");
const { answerHint, answerText } = require("./puzzleHelpers");
const humanReplies = require("../services/humanReplies");

function normalizeAnswer(value) {
  const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
  return String(value || "")
    .normalize("NFKC")
    .replace(/[٠-٩]/g, (digit) => String(arabicDigits.indexOf(digit)))
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase();
}

function editDistance(left, right) {
  if (Math.abs(left.length - right.length) > 2) return 3;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function isCloseAnswer(answer, candidate) {
  if (answer === candidate) return true;
  const longestLength = Math.max(answer.length, candidate.length);
  const allowedDistance = longestLength >= 8 ? 2 : longestLength >= 4 ? 1 : 0;
  return allowedDistance > 0 && editDistance(answer, candidate) <= allowedDistance;
}

function createQuizEngine({ id, name, startAliases, helpAliases, questions }) {
  const activeRooms = new Map();
  const remainingQuestions = new Map();
  const starts = new Set(startAliases.map((alias) => alias.toLowerCase()));
  const help = new Set(helpAliases.map((alias) => alias.toLowerCase()));
  const controlInstructions =
    "اكتب تلميح لطلب تلميح أو تخطي لكشف الإجابة.";
  const helpText = `${name}: اكتب ${startAliases[0]}، ثم أرسل الإجابة. أول إجابة صحيحة تفوز بنقطة. أثناء السؤال ${controlInstructions}`;
  const hints = new Set(["تلميح", "hint"]);
  const skips = new Set(["تخطي", "تخطى", "تجاوز", "skip"]);

  function chooseQuestion(threadId) {
    let remaining = remainingQuestions.get(threadId);
    if (!remaining?.length) {
      remaining = questions.map((_, index) => index);
      for (let index = remaining.length - 1; index > 0; index--) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [remaining[index], remaining[swapIndex]] = [remaining[swapIndex], remaining[index]];
      }
    }

    const questionIndex = remaining.pop();
    remainingQuestions.set(threadId, remaining);
    return questions[questionIndex];
  }

  async function ensureRoom(threadId, userId) {
    const existing = await db.one(
      "SELECT id FROM game_rooms WHERE thread_id=? AND game_id=? AND status IN ('lobby','playing') ORDER BY id DESC LIMIT 1",
      [threadId, id],
    );
    if (existing) return existing.id;

    const result = await db.query(
      "INSERT INTO game_rooms (game_id, thread_id, host_psid, status, phase) VALUES (?, ?, ?, 'playing', 'discussion')",
      [id, threadId, String(userId)],
    );
    const roomId = result.insertId;
    const displayName = String((await msg.getUserName(userId)) || "لاعب").slice(0, 100);
    await db.query(
      "INSERT IGNORE INTO room_players (room_id, psid, display_name) VALUES (?, ?, ?)",
      [roomId, String(userId), displayName],
    );
    return roomId;
  }

  async function finishRoom(threadId, room, winnerId = null) {
    room.finished = true;
    activeRooms.delete(threadId);

    if (winnerId) {
      const displayName = String((await msg.getUserName(winnerId)) || "لاعب").slice(0, 100);
      await leaderboard.recordPoints(id, room.roomId, [
        { psid: String(winnerId), display_name: displayName },
      ]);
    }

    await db.query(
      "UPDATE game_rooms SET status='finished', phase='finished' WHERE id=? AND status IN ('lobby','playing')",
      [room.roomId],
    );
  }

  async function handleMessage(context) {
    if (!context.isGroup)
      return msg.sendPrivate(context.userId, `استخدم لعبة ${name} داخل المجموعة.`);

    const command = String(context.text || "")
      .trim()
      .replace(/^[/!]\s*/, "");
    const commandName = command.split(/\s+/, 1)[0].toLowerCase();
    if (help.has(commandName)) return msg.sendGroup(context.threadId, helpText);

    if (starts.has(commandName)) {
      const current = activeRooms.get(context.threadId);
      if (current && !current.finished)
        return msg.sendGroup(
          context.threadId,
          `الجولة قائمة:\n${current.question.text}\n${controlInstructions}`,
        );

      const question = chooseQuestion(context.threadId);
      const roomId = await ensureRoom(context.threadId, context.userId);
      const room = { roomId, question, finished: false };
      activeRooms.set(context.threadId, room);
      return msg.sendGroup(
        context.threadId,
        `${name}: ${question.text}\nأرسل الإجابة. ${controlInstructions}`,
      );
    }

    const room = activeRooms.get(context.threadId);
    if (!room || room.finished)
      return msg.sendGroup(context.threadId, `ℹ️ لا توجد جولة نشطة. اكتب ${startAliases[0]} لبدء اللعبة.`);

    if (hints.has(commandName)) {
      if (room.hintUsed)
        return msg.sendGroup(context.threadId, "💡 استُخدم تلميح هذا السؤال بالفعل.", { fast: true });
      room.hintUsed = true;
      return msg.sendGroup(
        context.threadId,
        `💡 ${answerHint(room.question)}`,
        { fast: true },
      );
    }

    if (skips.has(commandName)) {
      const answer = answerText(room.question.answers);
      await finishRoom(context.threadId, room);
      return msg.sendGroup(
        context.threadId,
        `⏭️ تم تخطي السؤال. الإجابة الصحيحة: ${answer}.`,
        { fast: true },
      );
    }

    const answer = normalizeAnswer(command);
    if (!answer) return;
    const isCorrect = room.question.answers.some(
      (candidate) => isCloseAnswer(answer, normalizeAnswer(candidate)),
    );

    // --- الإجابة صحيحة ---
    if (isCorrect) {
      // تفاعل فوري بـ ✅
      if (context.messageId && typeof msg.reactToMessage === "function") {
        msg.reactToMessage(context.threadId, context.messageId, "✅").catch(() => {});
      }

      // تسجيل اللاعب وجلب اسمه من الماسنجر مباشرة
      const winnerName = String((await msg.getUserName(context.userId)) || "صاحبنا").slice(0, 60);
      humanReplies.registerPlayer(String(context.userId), winnerName);

      // في حالة أكثر من شخص أجاب صح — نختار الأول فقط (أول من أرسل)
      if (room.finished) return; // شخص آخر سبقه
      room.finished = true;

      await finishRoom(context.threadId, room, context.userId);
      const correctAnswer = room.question.answers[0];
      const replyText = humanReplies.correctReply(String(context.userId), winnerName);
      return msg.sendGroup(
        context.threadId,
        `${replyText}\n✅ الإجابة: ${correctAnswer}`,
        { fast: true },
      );
    }

    // --- الإجابة خاطئة ---
    // نسجّل الاسم في الخلفية بدون رد فوري (لتجميع المخطئين)
    const wrongName = String((await msg.getUserName(context.userId)) || "أخوي").slice(0, 60);
    humanReplies.registerPlayer(String(context.userId), wrongName);

    // نضيف المخطئ لقائمة المخطئين في الجولة
    if (!room.wrongAnswerers) room.wrongAnswerers = new Map();
    room.wrongAnswerers.set(String(context.userId), wrongName);

    // رد تهكمي عشوائي على واحد منهم كل 3 إجابات خاطئة (لتجنب الإزعاج)
    room.wrongCount = (room.wrongCount || 0) + 1;
    if (room.wrongCount % 3 === 0 && room.wrongAnswerers.size > 0) {
      const entries = [...room.wrongAnswerers.entries()];
      const [randomId, randomName] = entries[Math.floor(Math.random() * entries.length)];
      const wrongReply = humanReplies.wrongReply(randomId, randomName);
      await msg.sendGroup(context.threadId, wrongReply, { fast: true });
    }
  }

  async function cancelActiveGame(userId, threadId, isAdmin = false) {
    const room = await db.one(
      "SELECT id, host_psid FROM game_rooms WHERE thread_id=? AND game_id=? AND status IN ('lobby','playing') ORDER BY id DESC LIMIT 1",
      [threadId, id],
    );
    if (!room)
      return msg.sendGroup(threadId, `ℹ️ لا توجد جولة نشطة في لعبة ${name}.`);
    if (String(room.host_psid) !== String(userId) && !isAdmin)
      return msg.sendGroup(
        threadId,
        `⛔ مضيف اللعبة فقط يستطيع إلغاء لعبة ${name}.`,
      );

    const cancelled = await db.query(
      "UPDATE game_rooms SET status='cancelled', phase='finished' WHERE id=? AND status IN ('lobby','playing')",
      [room.id],
    );
    if (!cancelled.affectedRows)
      return msg.sendGroup(threadId, `ℹ️ لا توجد جولة نشطة في لعبة ${name}.`);

    const activeRoom = activeRooms.get(threadId);
    if (activeRoom?.roomId === room.id) {
      activeRoom.finished = true;
      activeRooms.delete(threadId);
    }
    return msg.sendGroup(threadId, `🚫 أُلغيت لعبة ${name}.`);
  }

  return {
    handleMessage,
    handleReaction: async () => null,
    cancelActiveGame,
    startTicker: async () => null,
  };
}

module.exports = createQuizEngine;
