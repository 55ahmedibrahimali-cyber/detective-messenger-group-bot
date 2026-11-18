const db = require("../database");
const msg = require("../services/messenger");
const leaderboard = require("../services/leaderboard");
const { answerHint, answerText } = require("./puzzleHelpers");
const humanReplies = require("../services/humanReplies");

function normalize(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640\u200c\u200d]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/["'«»“”‘’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function normalizeEmoji(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\s\u200b\u200d\ufe0e\ufe0f]/gu, "");
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

function isCloseMatch(answer, candidate) {
  if (answer === candidate) return true;
  const longestLength = Math.max(answer.length, candidate.length);
  const allowedDistance = longestLength >= 8 ? 2 : longestLength >= 3 ? 1 : 0;
  return allowedDistance > 0 && editDistance(answer, candidate) <= allowedDistance;
}

function normalizeOrderPart(value) {
  let text = String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/^(?:ثم|بعدها|اولا|اولاً)\s*/u, "")
    .replace(/^و(?=ال)/u, "");
  const forms = new Set([normalize(text)]);
  if (/^ال/u.test(text)) forms.add(normalize(text.slice(2)));
  return [...forms].filter(Boolean);
}

function isCloseOrderPart(answer, candidate) {
  return normalizeOrderPart(answer).some((answerForm) =>
    normalizeOrderPart(candidate).some((candidateForm) =>
      isCloseMatch(answerForm, candidateForm),
    ),
  );
}

function splitOrder(answer, prompt) {
  const separated = String(answer || "")
    .trim()
    .split(/[,،;؛|>→]+|\s+(?:ثم|وبعدها|بعدها)\s+|\s+و\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (separated.length === prompt.answers.length) return separated;

  const words = String(answer || "")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (words.length === prompt.answers.length) return words;
  return separated;
}

function lyricWords(value) {
  return String(value || "")
    .normalize("NFKC")
    .split(/\s+/u)
    .map(normalize)
    .filter(Boolean);
}

// يطابق سطراً مكتوباً بكلمات اللاعب مع السطر الصحيح: يتسامح مع الأخطاء الإملائية
// الصغيرة ونقص كلمة أو كلمتين، لكن يحافظ على ترتيب الكلمات.
function lyricMatches(answer, candidate) {
  const given = lyricWords(answer);
  const expected = lyricWords(candidate);
  if (!given.length || !expected.length) return false;
  if (given.length > expected.length) return false;

  let previous = new Array(expected.length + 1).fill(0);
  for (let row = 1; row <= given.length; row++) {
    const current = [0];
    for (let column = 1; column <= expected.length; column++) {
      current[column] = isCloseMatch(given[row - 1], expected[column - 1])
        ? previous[column - 1] + 1
        : Math.max(previous[column], current[column - 1]);
    }
    previous = current;
  }
  const allowedMissingWords =
    expected.length <= 2
      ? 0
      : Math.min(2, Math.max(1, Math.floor(expected.length * 0.25)));
  const needed = expected.length - allowedMissingWords;
  return previous[expected.length] >= needed;
}

function shuffled(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function promptText(kind, prompt, promptQuestion = "من صاحب العبارة؟") {
  if (kind === "quote")
    return `${promptQuestion}\n«${prompt.quote}»`;
  if (kind === "emoji")
    return `🧩 خمنوا الإجابة من الإيموجي:\n${prompt.clue}\nأول إجابة صحيحة تحصل على نقطة.`;
  if (kind === "emoji-description")
    return `🧩 خمنوا الإيموجي من الوصف:\n${prompt.description}\nأسرع لاعب يرسل الإيموجي الصحيح يحصل على نقطة.`;
  if (kind === "lyric") {
    const source = prompt.show ? ` من «${prompt.show}»` : "";
    return `🎤 كمّلوا الأغنية${source}:\n«${prompt.line} ...»\nاكتبوا السطر اللي بعده. أول إجابة صحيحة تفوز بنقطة.`;
  }
  if (kind === "ordering") {
    const choices = shuffled(prompt.items);
    return `رتّب ${prompt.direction}:\n${choices.join(" — ")}`;
  }
  return `سوق الكلمات: ${prompt.category}، حرف ${prompt.letter}. أرسل كلمة.`;
}

function isCorrect(kind, prompt, answer) {
  if (kind === "emoji-description") {
    const emoji = normalizeEmoji(answer);
    return (
      Boolean(emoji) &&
      prompt.answers.some((candidate) => emoji === normalizeEmoji(candidate))
    );
  }
  if (kind === "ordering") {
    const parts = splitOrder(answer, prompt);
    return (
      parts.length === prompt.answers.length &&
      parts.every((part, index) =>
        prompt.answers[index].some((candidate) =>
          isCloseOrderPart(part, candidate),
        ),
      )
    );
  }
  if (kind === "lyric")
    return prompt.answers.some((candidate) => lyricMatches(answer, candidate));
  const normalized = normalize(answer);
  if (!normalized) return false;
  return prompt.answers.some((candidate) =>
    isCloseMatch(normalized, normalize(candidate)),
  );
}

function createPromptRaceEngine({
  id,
  name,
  kind,
  startAliases,
  helpAliases,
  prompts,
  allowEmpty = false,
  emptyMessage = "",
  promptQuestion,
  customHelpText,
}) {
  if (
    ![
      "quote",
      "ordering",
      "wordmarket",
      "lyric",
      "emoji",
      "emoji-description",
    ].includes(kind)
  )
    throw new Error(`Unknown prompt game kind "${kind}".`);
  if (!prompts.length && !allowEmpty)
    throw new Error(`Prompt game "${id}" needs prompts.`);

  const starts = new Set(startAliases.map((alias) => alias.toLowerCase()));
  const helps = new Set(helpAliases.map((alias) => alias.toLowerCase()));
  const hints = new Set(["تلميح", "hint"]);
  const skips = new Set(["تخطي", "تخطى", "تجاوز", "skip"]);
  const activeRooms = new Map();
  const controlInstructions =
    "أثناء السؤال اكتب تلميح لطلب تلميح أو تخطي لكشف الإجابة.";
  const gameHelpText =
    customHelpText ||
    (kind === "lyric"
      ? `${name}: اكتبوا ${startAliases[0]}، وبيطلع لكم سطر من أغنية. كمّلوا السطر، وأول إجابة صحيحة تفوز بنقطة.`
      : kind === "quote"
        ? `${name}: اكتب ${startAliases[0]}، ثم خمّن صاحب العبارة. أول إجابة صحيحة تفوز بنقطة.`
        : kind === "ordering"
          ? `${name}: اكتب ${startAliases[0]}، ورتّب العناصر. أول ترتيب صحيح يفوز بنقطة.`
          : kind === "emoji"
            ? `${name}: اكتب ${startAliases[0]}، ثم خمّن العبارة أو الاسم من الإيموجي. أول إجابة صحيحة تفوز بنقطة.`
            : kind === "emoji-description"
              ? `${name}: اكتب ${startAliases[0]}، ثم أرسل الإيموجي المطابق للوصف. أسرع إجابة صحيحة تفوز بنقطة.`
              : `${name}: اكتب ${startAliases[0]}، ثم أرسل كلمة مناسبة للحرف. أول إجابة صحيحة تفوز بنقطة.`);
  const helpText = `${gameHelpText}\n${controlInstructions}`;

  async function assertSchema() {
    await db.query(
      `CREATE TABLE IF NOT EXISTS bot_game_prompt_usage (
        game_id VARCHAR(40) NOT NULL,
        thread_id VARCHAR(64) NOT NULL,
        prompt_index INT UNSIGNED NOT NULL,
        used_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (game_id, thread_id, prompt_index),
        KEY idx_prompt_usage_thread (thread_id, game_id)
      ) ENGINE=InnoDB`,
    );
  }

  async function nextPromptAndRoom(threadId, userId) {
    return db.withTransaction(async (query) => {
      const active = await query(
        "SELECT id FROM game_rooms WHERE thread_id=? AND game_id=? AND status IN ('lobby','playing') ORDER BY id DESC LIMIT 1 FOR UPDATE",
        [threadId, id],
      );
      if (active.length) return { activeRoom: true };

      let usedRows = await query(
        "SELECT prompt_index FROM bot_game_prompt_usage WHERE game_id=? AND thread_id=?",
        [id, threadId],
      );
      let used = new Set(usedRows.map((row) => Number(row.prompt_index)));
      if (used.size >= prompts.length) {
        await query(
          "DELETE FROM bot_game_prompt_usage WHERE game_id=? AND thread_id=?",
          [id, threadId],
        );
        used = new Set();
      }

      const available = prompts
        .map((_, index) => index)
        .filter((index) => !used.has(index));
      const promptIndex = available[Math.floor(Math.random() * available.length)];
      const prompt = prompts[promptIndex];
      await query(
        "INSERT INTO bot_game_prompt_usage (game_id, thread_id, prompt_index) VALUES (?,?,?)",
        [id, threadId, promptIndex],
      );
      const room = await query(
        "INSERT INTO game_rooms (game_id, thread_id, host_psid, status, phase) VALUES (?, ?, ?, 'playing', 'discussion')",
        [id, threadId, String(userId)],
      );
      return { prompt, roomId: room.insertId };
    });
  }

  async function finish(threadId, room, winnerId = null) {
    room.finished = true;
    if (winnerId != null)
      await leaderboard.recordPoints(id, room.roomId, [
        {
          psid: String(winnerId),
          display_name: String((await msg.getUserName(winnerId)) || "لاعب").slice(0, 100),
        },
      ]);
    await db.query(
      "UPDATE game_rooms SET status='finished', phase='finished' WHERE id=? AND status='playing'",
      [room.roomId],
    );
    activeRooms.delete(threadId);
  }

  async function handleMessage(context) {
    if (!context.isGroup)
      return msg.sendPrivate(context.userId, `استخدم لعبة ${name} داخل المجموعة.`);

    const text = String(context.text || "")
      .trim()
      .replace(/^[/!]\s*/, "");
    const commandName = text.split(/\s+/, 1)[0].toLowerCase();
    if (helps.has(commandName)) return msg.sendGroup(context.threadId, helpText);

    if (starts.has(commandName)) {
      if (!prompts.length)
        return msg.sendGroup(context.threadId, emptyMessage || `لعبة ${name} لا تحتوي على أسئلة بعد.`);
      const current = activeRooms.get(context.threadId);
      if (current && !current.finished)
        return msg.sendGroup(context.threadId, current.promptMessage);

      const started = await nextPromptAndRoom(context.threadId, context.userId);
      if (started.activeRoom)
        return msg.sendGroup(
          context.threadId,
          `لعبة ${name} نشطة بالفعل. ألغها أولاً إن كانت عالقة.`,
        );
      const room = {
        roomId: started.roomId,
        prompt: started.prompt,
        promptMessage: `${promptText(kind, started.prompt, promptQuestion)}\n${controlInstructions}`,
        finished: false,
      };
      activeRooms.set(context.threadId, room);
      return msg.sendGroup(context.threadId, room.promptMessage);
    }

    const room = activeRooms.get(context.threadId);
    if (!room || room.finished) {
      if (hints.has(commandName) || skips.has(commandName))
        return msg.sendGroup(context.threadId, `ℹ️ لا يوجد سؤال نشط في لعبة ${name}.`);
      return;
    }
    if (hints.has(commandName)) {
      if (room.hintUsed)
        return msg.sendGroup(context.threadId, "💡 استُخدم تلميح هذا السؤال بالفعل.", { fast: true });
      room.hintUsed = true;
      return msg.sendGroup(context.threadId, `💡 ${answerHint(room.prompt)}`, { fast: true });
    }
    if (skips.has(commandName)) {
      const answer = answerText(room.prompt.answers);
      await finish(context.threadId, room);
      return msg.sendGroup(
        context.threadId,
        `⏭️ تم تخطي السؤال. الإجابة الصحيحة: ${answer}.`,
        { fast: true },
      );
    }
    const answerMatch = isCorrect(kind, room.prompt, text);

    // --- الإجابة صحيحة (أول شخص فقط) ---
    if (answerMatch) {
      if (room.finished) return; // سبق لشخص آخر الفوز
      room.finished = true;

      if (context.messageId && typeof msg.reactToMessage === "function") {
        msg.reactToMessage(context.threadId, context.messageId, "✅").catch(() => {});
      }

      const winnerName = String((await msg.getUserName(context.userId)) || "صاحبنا").slice(0, 60);
      humanReplies.registerPlayer(String(context.userId), winnerName);

      await finish(context.threadId, room, context.userId);
      const answer =
        kind === "ordering"
          ? room.prompt.answers.map((item) => item[0]).join("، ")
          : room.prompt.answers[0];

      const praise = humanReplies.correctReply(String(context.userId), winnerName);
      return msg.sendGroup(
        context.threadId,
        `${praise}\n✅ الإجابة: ${answer}`,
        { fast: true },
      );
    }

    // --- الإجابة خاطئة ---
    const wrongName = String((await msg.getUserName(context.userId)) || "أخوي").slice(0, 60);
    humanReplies.registerPlayer(String(context.userId), wrongName);

    if (!room.wrongAnswerers) room.wrongAnswerers = new Map();
    room.wrongAnswerers.set(String(context.userId), wrongName);

    // عند وجود أكثر من إجابة خاطئة (كل 3 محاولات خاطئة)، نختار أحدهم عشوائياً ونرد عليه بتهكم مرح
    room.wrongCount = (room.wrongCount || 0) + 1;
    if (room.wrongCount % 3 === 0 && room.wrongAnswerers.size > 0) {
      const entries = [...room.wrongAnswerers.entries()];
      const [randomId, randomName] = entries[Math.floor(Math.random() * entries.length)];
      const sarcasticReply = humanReplies.wrongReply(randomId, randomName);
      await msg.sendGroup(context.threadId, sarcasticReply, { fast: true });
    }
  }

  async function cancelActiveGame(userId, threadId, isAdmin = false) {
    const room = await db.one(
      "SELECT id, host_psid FROM game_rooms WHERE thread_id=? AND game_id=? AND status IN ('lobby','playing') ORDER BY id DESC LIMIT 1",
      [threadId, id],
    );
    if (!room)
      return msg.sendGroup(threadId, `ℹ️ لا يوجد تحدٍ نشط في لعبة ${name}.`);
    if (String(room.host_psid) !== String(userId) && !isAdmin)
      return msg.sendGroup(threadId, `⛔ مضيف اللعبة فقط يستطيع إلغاء ${name}.`);
    const result = await db.query(
      "UPDATE game_rooms SET status='cancelled', phase='finished' WHERE id=? AND status IN ('lobby','playing')",
      [room.id],
    );
    if (!result.affectedRows)
      return msg.sendGroup(threadId, `ℹ️ لا يوجد تحدٍ نشط في لعبة ${name}.`);
    if (activeRooms.get(threadId)?.roomId === room.id)
      activeRooms.delete(threadId);
    return msg.sendGroup(threadId, `🚫 أُلغيت لعبة ${name}.`);
  }

  return {
    handleMessage,
    handleReaction: async () => null,
    cancelActiveGame,
    startTicker: async () => null,
    assertSchema,
  };
}

createPromptRaceEngine._internal = {
  lyricMatches,
  isCorrect,
  promptText,
  normalizeEmoji,
};

module.exports = createPromptRaceEngine;
