const db = require("../database");
const msg = require("./messenger");
const adminAuth = require("./adminAuth");
const { createTestImage } = require("./testImage");
const phaseReminders = require("./phaseReminders");
const leaderboard = require("./leaderboard");
const gameAvailability = require("./gameAvailability");
const { findActiveGameForPlayer } = require("./activeGameLookup");
const pointStore = require("./pointStore");
const fixedReplies = require("./fixedReplies");
const stormLogo = require("./stormLogo");
const imageQuality = require("./imageQuality");
const { createIdlePause, IDLE_TIMEOUT_MS } = require("./idlePause");
const { createCommandCooldown } = require("./commandCooldown");
const safety = require("./safety");

const registeredGames = [
  require("../games/crime"),
  require("../games/storm"),
  require("../games/spy"),
  require("../games/feign"),
  require("../games/werewolf"),
  require("../games/drawing"),
  require("../games/culture"),
  require("../games/religion"),
  require("../games/flags"),
  require("../games/quote"),
  require("../games/ordering"),
  require("../games/wordmarket"),
  require("../games/footballAuction"),
  require("../games/spacetoon"),
  require("../games/cartoonMovies"),
  require("../games/emojiGuess"),
  require("../games/animeGuess"),
  require("../games/emojiFilm"),
  require("../games/tryEscape"),
  require("../games/treasureHunt"),
  require("../games/shadowMarket"),
  require("../games/rescueCode"),
];
const games = new Map();
const aliases = new Map();
let botPaused = false;
const pauseNotifiedThreads = new Set();
let idleCheckTimer = null;
let idleClock = () => Date.now();
const idlePause = createIdlePause({
  timeoutMs: IDLE_TIMEOUT_MS,
  now: () => idleClock(),
  isPaused: () => botPaused,
  onIdle: () => {
    botPaused = true;
    pauseNotifiedThreads.clear();
    console.info(
      "[bot] دخل وضع الخمول بعد 15 دقيقة بلا نشاط؛ أرسل /تشغيل البوت في الخاص للاستئناف.",
    );
    try {
      if (adminAuth.ownerId) {
        msg.sendPrivate(
          adminAuth.ownerId,
          "⏸️ دخل البوت في وضع السكون بعد 15 دقيقة من عدم النشاط لتوفير نشاط الحساب وحمايته.\nأرسل /تشغيل البوت للاستئناف في أي وقت.",
        ).catch(() => {});
      }
    } catch (_) {}
  },
});
const isGlobalCommandCoolingDown = createCommandCooldown({
  defaultCooldownMs: 3000,
  cooldowns: new Map([
    ["test-image", 15_000],
    ["image-quality", 15_000],
    ["storm-logo", 10_000],
    ["pause-bot", 0],
    ["resume-bot", 0],
    ["idle-status", 3000],
    ["shutdown", 0],
  ]),
});
const globalCommandEntries = [
  ["help", "help"],
  ["مساعدة", "help"],
  ["الاوامر", "help"],
  ["الأوامر", "help"],
  ["شرح", "game-help"],
  ["explain", "game-help"],
  ["games", "games"],
  ["العاب", "games"],
  ["الألعاب", "games"],
  ["الالعاب", "games"],
  ["ترتيب النقاط", "leaderboard"],
  ["التصنيف", "leaderboard"],
  ["leaderboard", "leaderboard"],
  ["top", "leaderboard"],
  ["شعار", "storm-logo"],
  ["جودة", "image-quality"],
  ["quality", "image-quality"],
  ["رفع_الجودة", "image-quality"],
  ["رفع الجودة", "image-quality"],
  ["نقاطي", "my-points"],
  ["mypoints", "my-points"],
  ["متجر", "point-store"],
  ["shop", "point-store"],
  ["المنتجات", "point-store"],
  ["منتجات", "point-store"],
  ["منتجات_المتجر", "point-store"],
  ["products", "point-store"],
  ["شراء", "point-store"],
  ["مقتنياتي", "point-store"],
  ["مشترياتي", "point-store"],
  ["لقب", "point-store"],
  ["حالة_الاتصال", "connection-status"],
  ["حالة_الحساب", "connection-status"],
  ["حالة_البوت", "connection-status"],
  ["حالة الاتصال", "connection-status"],
  ["حالة الحساب", "connection-status"],
  ["حالة البوت", "connection-status"],
  ["تعطيل", "disable-game"],
  ["إيقاف_لعبة", "disable-game"],
  ["ايقاف_اللعبة", "disable-game"],
  ["إيقاف لعبة", "disable-game"],
  ["تعطيل لعبة", "disable-game"],
  ["تفعيل", "enable-game"],
  ["تشغيل_لعبة", "enable-game"],
  ["تشغيل_اللعبة", "enable-game"],
  ["تشغيل لعبة", "enable-game"],
  ["تفعيل لعبة", "enable-game"],
  ["حالة_الألعاب", "game-controls"],
  ["حاله_الالعاب", "game-controls"],
  ["حالة الألعاب", "game-controls"],
  ["إيقاف_البوت", "pause-bot"],
  ["ايقاف_البوت", "pause-bot"],
  ["إيقاف البوت", "pause-bot"],
  ["ايقاف البوت", "pause-bot"],
  ["سكون", "pause-bot"],
  ["وضع_السكون", "pause-bot"],
  ["وضع السكون", "pause-bot"],
  ["تشغيل_البوت", "resume-bot"],
  ["تشغيل البوت", "resume-bot"],
  ["استئناف", "resume-bot"],
  ["استئناف_البوت", "resume-bot"],
  ["استئناف البوت", "resume-bot"],
  ["حالة_السكون", "idle-status"],
  ["حالة السكون", "idle-status"],
  ["إغلاق_البوت", "shutdown"],
  ["اغلاق_البوت", "shutdown"],
  ["إغلاق البوت", "shutdown"],
  ["shutdown", "shutdown"],
  ["رد_اضف", "fixed-reply-add"],
  ["اضافة_رد_ثابت", "fixed-reply-add"],
  ["رد أضف", "fixed-reply-add"],
  ["إضافة رد ثابت", "fixed-reply-add"],
  ["fixedreplyadd", "fixed-reply-add"],
  ["رد_حذف", "fixed-reply-remove"],
  ["حذف_رد_ثابت", "fixed-reply-remove"],
  ["رد احذف", "fixed-reply-remove"],
  ["حذف رد ثابت", "fixed-reply-remove"],
  ["fixedreplyremove", "fixed-reply-remove"],
  ["الردود_الثابتة", "fixed-reply-list"],
  ["الردود_ثابته", "fixed-reply-list"],
  ["الردود الثابتة", "fixed-reply-list"],
  ["fixedreplies", "fixed-reply-list"],
  ["ping", "ping"],
  ["اختبارالبوت", "ping"],
  ["اختبار البوت", "ping"],
  ["صورة", "test-image"],
  ["اختبارصورة", "test-image"],
  ["اختبار صورة", "test-image"],
  ["testimage", "test-image"],
  ["cancel", "cancel"],
  ["الغاء", "cancel"],
  ["إلغاء", "cancel"],
  ["ban", "ban"],
  ["حظر", "ban"],
  ["unban", "unban"],
  ["فكحظر", "unban"],
  ["فك حظر", "unban"],
  ["bans", "bans"],
  ["المحظورين", "bans"],
  ["kick", "kick"],
  ["طرد", "kick"],
  ["خصم", "deduct-points"],
  ["خصم_نقاط", "deduct-points"],
  ["خصم نقاط", "deduct-points"],
  ["deduct-points", "deduct-points"],
  ["admin", "admin-help"],
  ["ادمن", "admin-help"],
  ["أوامر الأدمن", "admin-help"],
  ["promote-admin", "promote-admin"],
  ["ترقية", "promote-admin"],
  ["رفع", "promote-admin"],
  ["demote-admin", "demote-admin"],
  ["تنزيل", "demote-admin"],
  ["خفض", "demote-admin"],
  ["permissions", "permissions"],
  ["mypermissions", "permissions"],
  ["صلاحيات", "permissions"],
  ["صلاحياتي", "permissions"],
  ["كود", "get-app-code"],
  ["رمز", "get-app-code"],
  ["تسجيل", "get-app-code"],
  ["code", "get-app-code"],
  ["معرفي", "get-my-id"],
  ["معرف", "get-my-id"],
  ["id", "get-my-id"],
  ["myid", "get-my-id"],
];
const globalCommandAliases = new Set(
  globalCommandEntries.map(([alias]) => alias.toLowerCase()),
);
if (globalCommandAliases.size !== globalCommandEntries.length)
  throw new Error("Duplicate global command alias.");
const GLOBAL_COMMANDS = new Map(globalCommandEntries);

for (const game of registeredGames) {
  if (!game.id || !game.name || !game.engine)
    throw new Error("Every game must define an id, name, and engine.");
  if (!game.startCommand)
    throw new Error(`Game ${game.id} must define a startCommand.`);
  if (!Array.isArray(game.startAliases) || !Array.isArray(game.commandAliases))
    throw new Error(`Game ${game.id} must define startAliases and commandAliases.`);
  if (!game.startAliases.includes(game.startCommand))
    throw new Error(`Game ${game.id} startCommand must be included in startAliases.`);
  if (!game.helpCommand || !game.commandAliases.includes(game.helpCommand))
    throw new Error(`Game ${game.id} must register its helpCommand in commandAliases.`);
  if (games.has(game.id))
    throw new Error(`Duplicate game id: ${game.id}`);
  if (typeof game.engine.handleMessage !== "function")
    throw new Error(`Game ${game.id} must implement handleMessage.`);
  if (typeof game.engine.handleReaction !== "function")
    throw new Error(`Game ${game.id} must implement handleReaction.`);
  if (typeof game.engine.cancelActiveGame !== "function")
    throw new Error(`Game ${game.id} must implement cancelActiveGame.`);
  games.set(game.id, game);

  const gameCommandAliases = new Set();
  for (const alias of [...game.startAliases, ...game.commandAliases]) {
    const key = alias.toLowerCase();
    if (gameCommandAliases.has(key))
      throw new Error(`Duplicate command "${alias}" in game ${game.id}.`);
    gameCommandAliases.add(key);
    if (globalCommandAliases.has(key))
      throw new Error(`Game command "${alias}" conflicts with a global command.`);
    const existing = aliases.get(key);
    if (existing && existing !== game.id)
      throw new Error(`Game command "${alias}" is registered more than once.`);
    aliases.set(key, game.id);
  }
}

const defaultGame = games.get("crime") || games.values().next().value;
if (!defaultGame) throw new Error("At least one game must be registered.");

function commandToken(text) {
  return text.trim().replace(/^[/!]\s*/, "").split(/\s+/, 1)[0].toLowerCase();
}

function globalCommandFor(text) {
  const command = String(text || "")
    .trim()
    .replace(/^[/!]\s*/, "")
    .toLowerCase();
  const exact = GLOBAL_COMMANDS.get(command);
  if (exact) return exact;
  const spacedAlias = [...GLOBAL_COMMANDS.keys()]
    .filter((alias) => alias.includes(" "))
    .sort((left, right) => right.length - left.length)
    .find((alias) => command.startsWith(`${alias.toLowerCase()} `));
  return (
    (spacedAlias && GLOBAL_COMMANDS.get(spacedAlias)) ||
    GLOBAL_COMMANDS.get(commandToken(command))
  );
}

function isBotControlCommand(text) {
  return ["pause-bot", "resume-bot", "shutdown", "idle-status"].includes(
    globalCommandFor(text),
  );
}

function isRecognizedCommand(text) {
  return Boolean(globalCommandFor(text) || gameForCommand(text));
}

function gameForCommand(text) {
  const command = String(text || "")
    .trim()
    .replace(/^[/!]\s*/, "")
    .toLowerCase();
  const gameId = aliases.get(command) || aliases.get(commandToken(command));
  return gameId ? games.get(gameId) : null;
}

function isStartCommand(game, text) {
  const command = String(text || "")
    .trim()
    .replace(/^[/!]\s*/, "")
    .toLowerCase();
  const token = commandToken(text);
  return game.startAliases.some(
    (alias) => alias.toLowerCase() === command || alias.toLowerCase() === token,
  );
}

function engineCommandText(game, text) {
  const original = String(text || "");
  const prefix = original.trim().match(/^[/!]\s*/)?.[0] || "";
  const command = original.trim().replace(/^[/!]\s*/, "").replace(/\s+/g, " ");
  const aliases = [...game.startAliases, ...game.commandAliases];
  const compactAliases = new Set(
    aliases
      .filter((alias) => !/\s/.test(alias))
      .map((alias) => alias.toLowerCase()),
  );
  const readableAlias = aliases
    .filter(
      (alias) =>
        /\s/.test(alias) &&
        compactAliases.has(alias.replace(/\s+/g, "").toLowerCase()),
    )
    .sort((left, right) => right.length - left.length)
    .find((alias) => {
      if (command.toLowerCase() !== alias.toLowerCase() &&
          !command.toLowerCase().startsWith(`${alias.toLowerCase()} `))
        return false;
      return !game.startAliases.includes(alias) ||
        command.toLowerCase() === alias.toLowerCase();
    });
  if (!readableAlias) return text;
  const compactAlias = readableAlias.replace(/\s+/g, "");
  return `${prefix}${compactAlias}${command.slice(readableAlias.length)}`;
}

async function sendGamesList({ isGroup, threadId, userId }) {
  const lines = formatGameCommands();
  const text = [
    `🎮 الألعاب المتاحة (${games.size})`,
    "اكتب أمر البدء في المجموعة، أو استخدم أمر القواعد:",
    ...lines,
    "💡 للقواعد مباشرة: /شرح <اسم اللعبة> (مثال: /شرح الذئب).",
  ].join("\n");
  if (isGroup) return msg.sendGroup(threadId, text);
  return msg.sendPrivate(userId, text);
}

function formatGameCommands() {
  return [...games.values()].map(
    (game, index) =>
      `${String(index + 1).padStart(2, "0")}. ${game.name} — 🎮 /${game.startCommand} | 📖 /${game.helpCommand}`,
  );
}

async function sendGeneralHelp({ isGroup, threadId, userId }) {
  const text = [
    "📋 الأوامر العامة",
    "• /مساعدة — هذه القائمة | /الألعاب — قائمة الألعاب | /شرح <اسم اللعبة> — قواعدها",
    "🏆 النقاط: /التصنيف أو /ترتيب النقاط — الترتيب | /نقاطي — نقاطك",
    "🛍️ المتجر: /منتجات، /شراء <رقم>، /مقتنياتي، /لقب <رقم>",
    "🚪 /إلغاء — إلغاء اللعبة | 🛡️ /أوامر الأدمن — أوامر الإدارة",
    "🎨 /مساعدة التصميم — أوامر التصميم",
    "🖼️ /جودة (بالرد على صورة) | 📌 /شعار <موضع> (مثل: شعار أسفل المنتصف)",
    "👑 مالك البوت فقط (في الخاص): /تشغيل لعبة <اسم اللعبة>، /إيقاف لعبة <اسم اللعبة>، /حالة الألعاب، /إيقاف البوت، /تشغيل البوت، /إغلاق البوت",
    "الردود الثابتة للأدمن: /رد أضف <محفز> | <رد>، /رد احذف <محفز>، /الردود الثابتة",
  ].join("\n");
  if (isGroup) return msg.sendGroup(threadId, text);
  return msg.sendPrivate(userId, text);
}

async function handleGlobalCommand(command, context) {
  if (command === "help") return sendGeneralHelp(context);
  if (command === "game-help") return sendGameHelp(context);
  if (command === "games") return sendGamesList(context);
  if (command === "get-my-id") {
    const isOwner = adminAuth.isOwner(context.userId);
    const isAdmin = adminAuth.isAdmin(context.userId);
    const roleText = isOwner ? " (👑 مالك البوت)" : (isAdmin ? " (🛡️ أدمن البوت)" : "");
    const msgText = [
      `🆔 معرّف حسابك: ${context.userId}${roleText}`,
      `للحصول على رمز تسجيل الدخول في التطبيق، أرسل أمر: /كود`
    ].join("\n");
    return reply(context, msgText);
  }
  if (command === "get-app-code") {
    const inAppChat = require("./inAppChat");
    const code = await inAppChat.generateVerificationCode(context.userId);
    const msgText = [
      `⚡ رمز التسجيل في تطبيق ستورم بوت (Storm Bot):`,
      `👉 ${code} 👈`,
      `⏱️ الرمز صالح لمدة 15 دقيقة فقط.`,
      `🆔 معرّفك هو: ${context.userId}`,
      `استخدم المعرّف وهذا الرمز لتعيين كلمة السر الخاصة بك في التطبيق.`
    ].join("\n");
    if (context.isGroup) {
      await msg.sendGroup(context.threadId, "📩 تم إرسال كود التسجيل لك في المحادثة الخاصة مع البوت لحماية أمان حسابك!");
      return msg.sendPrivate(context.userId, msgText);
    }
    return msg.sendPrivate(context.userId, msgText);
  }
  if (command.startsWith("fixed-reply-"))
    return handleFixedReplyCommand(command, context);
  if (["disable-game", "enable-game", "game-controls"].includes(command)) {
    if (!adminAuth.isAdmin(context.userId))
      return reply(context, "⛔ إدارة تشغيل الألعاب والأوامر متاحة لأدمن ومالك البوت فقط.");
    if (command === "game-controls") return sendGameAvailability(context);
    return changeGameAvailability(command === "enable-game", context);
  }
  if (command === "idle-status") {
    if (!adminAuth.isAdmin(context.userId))
      return reply(context, "⛔ هذا الأمر متاح لأدمن البوت فقط.");
    const isPaused = botPaused;
    const isQuiet = safety.quietNow();
    const statusMsg = [
      `📊 حالة البوت: ${isPaused ? "⏸️ في وضع السكون (متوقف مؤقتًا)" : "✅ يعمل بشكل طبيعي"}`,
      `🌙 ساعات الصمت (حماية الحساب): ${isQuiet ? "مُفعلة حالياً" : "غير نشطة"}`,
      `🛡️ حماية الحساب: نشطة تلقائياً بعد 15 دقيقة خمول.`,
      isPaused ? "أرسل /تشغيل البوت للاستئناف." : "أرسل /وضع السكون لتفعيله يدوياً.",
    ].join("\n");
    return reply(context, statusMsg);
  }
  if (command === "pause-bot" || command === "resume-bot") {
    if (!adminAuth.isAdmin(context.userId))
      return reply(context, "⛔ إيقاف البوت وتشغيله متاحان لمالك البوت فقط أو أدمن البوت.");
    if (context.isGroup)
      return msg.sendGroup(
        context.threadId,
        "أرسل هذا الأمر في الخاص مع البوت للتحكم به.",
      );
    if (command === "pause-bot") {
      if (botPaused)
        return msg.sendPrivate(context.userId, "⏸️ البوت متوقف مؤقتًا بالفعل.");
      botPaused = true;
      pauseNotifiedThreads.clear();
      return msg.sendPrivate(
        context.userId,
        "⏸️ تم إيقاف البوت مؤقتًا ودخوله في وضع السكون. أرسل /تشغيل البوت لاستئناف عمله.",
      );
    }
    if (!botPaused)
      return msg.sendPrivate(context.userId, "✅ البوت يعمل بالفعل.");
    botPaused = false;
    pauseNotifiedThreads.clear();
    idlePause.resume();
    return msg.sendPrivate(context.userId, "✅ تم تشغيل البوت واستئناف عمله.");
  }
  if (command === "shutdown") {
    if (!adminAuth.isOwner(context.userId))
      return reply(context, "⛔ إغلاق البوت متاح لمالك البوت فقط.");
    if (context.isGroup)
      return msg.sendGroup(
        context.threadId,
        "أرسل /إغلاق البوت في الخاص مع البوت لإغلاقه.",
      );
    await msg.sendPrivate(context.userId, "⏻ جارٍ إغلاق البوت بطلب المالك.");
    return process.exit(0);
  }
  if (command === "leaderboard") {
    const players = await leaderboard.topPlayers();
    const text = players.length
      ? `🏆 ترتيب أفضل 10 لاعبين:\n${players
          .map(
            (player, index) =>
              `${index + 1}. ${player.display_name}${player.title ? ` «${player.title}»` : ""} — ${player.points} ${Number(player.points) === 1 ? "نقطة" : "نقاط"}`,
          )
          .join("\n")}`
      : "لا توجد نقاط بعد.";
    return context.isGroup
      ? msg.sendGroup(context.threadId, text)
      : msg.sendPrivate(context.userId, text);
  }
  if (command === "my-points") {
    const [points, title] = await Promise.all([
      leaderboard.playerPoints(context.userId),
      leaderboard.activeTitle(context.userId),
    ]);
    const text = `نقاطك: ${points} ${points === 1 ? "نقطة" : "نقاط"}${title ? ` | لقبك: ${title}` : ""}.`;
    return context.isGroup
      ? msg.sendGroup(context.threadId, text)
      : msg.sendPrivate(context.userId, text);
  }
  if (command === "connection-status") {
    if (!adminAuth.isAdmin(context.userId))
      return reply(context, "هذا الأمر متاح لأدمن البوت فقط.");
    const status = msg.getConnectionStatus();
    const lines = [
      `جلسة الحساب: ${status.loggedIn ? "مسجل الدخول" : "غير متصل"}`,
      `استقبال الرسائل: ${status.listenerHealthy ? "يعمل" : "غير مستقر"}`,
    ];
    if (status.e2eeSupported)
      lines.push(`الرسائل المشفرة: ${status.e2eeConnected ? "متصل" : "غير متصل"}`);
    return reply(context, lines.join("\n"));
  }
  if (command === "point-store") return handlePointStore(context);
  if (command === "storm-logo") return stormLogo.handle(context);
  if (command === "image-quality") return imageQuality.handle(context);
  if (command === "permissions") return sendUserPermissions(context);
  if (command === "test-image") return testPrivateImage(context);
  if (["promote-admin", "demote-admin"].includes(command)) {
    if (command === "promote-admin") return promoteAdmin(context);
    return demoteAdmin(context);
  }
  if (["ban", "unban", "bans", "kick", "deduct-points", "admin-help"].includes(command)) {
    if (!adminAuth.isAdmin(context.userId))
      return reply(context, "⛔ هذا الأمر متاح لأدمن البوت فقط.");
    if (command === "ban") return banUser(context);
    if (command === "unban") return unbanUser(context);
    if (command === "bans") return sendBanList(context);
    if (command === "kick") return kickUser(context);
    if (command === "deduct-points") return deductPoints(context);
    const ownerCommands = adminAuth.isOwner(context.userId)
      ? "\nمالك البوت: /رفع ادمن أو /تنزيل ادمن بالرد أو المعرّف."
      : "";
    return reply(
      context,
      `أوامر الأدمن:\n/إيقاف البوت، /تشغيل البوت، /حالة السكون\n/حالة الاتصال، /إلغاء، /حظر <معرّف> [سبب]، /فك حظر <معرّف>، /المحظورين\n/طرد <معرّف> أو بالرد | /خصم نقاط <معرّف> <مبلغ> أو بالرد\n/متجر إضافة/حذف/سعر/وصف <رقم>\nالردود الثابتة: /رد أضف <محفز> | <رد>، /رد احذف <محفز>، /الردود الثابتة${ownerCommands}`,
    );
  }
  if (command === "cancel") {
    if (!context.isGroup)
      return msg.sendPrivate(
        context.userId,
        "ألغِ اللعبة من مجموعتها.",
      );
    const room = await activeRoomForThread(context.threadId);
    if (!room)
      return msg.sendGroup(context.threadId, "ℹ️ لا توجد لعبة نشطة لإلغائها.");
    const game = games.get(room.game_id || "crime");
    if (!game) {
      console.error(
        `[game manager] cannot cancel active room for unregistered game "${room.game_id}"`,
      );
      return msg.sendGroup(
        context.threadId,
        "⚠️ اللعبة النشطة غير مسجلة في النظام حالياً.",
      );
    }
    if (typeof game.engine.cancelActiveGame !== "function")
      throw new Error(`Game ${game.id} does not implement cancelActiveGame.`);
    return game.engine.cancelActiveGame(
      context.userId,
      context.threadId,
      adminAuth.isAdmin(context.userId),
    );
  }
  if (command === "ping") {
    const text = "✅ البوت يعمل ويستقبل الأوامر.";
    return context.isGroup
      ? msg.sendGroup(context.threadId, text)
      : msg.sendPrivate(context.userId, text);
  }
}

function normalizeGameName(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .replace(/^ال/, "");
}

function findGame(value) {
  const wanted = normalizeGameName(value).replace(/^لعبه/, "");
  if (!wanted) return null;
  return (
    [...games.values()].find((game) =>
      [game.id, game.name, game.startCommand, ...game.startAliases].some(
        (candidate) =>
          normalizeGameName(candidate).replace(/^لعبه/, "") === wanted,
      ),
    ) || null
  );
}

async function handlePointStore(context) {
  const rootCommand = commandToken(context.text);
  const commandText = commandArguments(context.text).trim();
  const [subcommand = "", ...parts] = commandText.split(/\s+/);
  let sub = subcommand.toLowerCase();
  let argument = parts.join(" ").trim();
  if (rootCommand === "شراء") {
    sub = "شراء";
    argument = commandText;
  } else if (rootCommand === "مقتنياتي" || rootCommand === "مشترياتي") {
    sub = "مقتنياتي";
  } else if (rootCommand === "لقب") {
    sub = "لقب";
    argument = commandText;
  }

  if (["شراء", "buy"].includes(sub)) {
    const [productId] = argument.split(/\s+/, 1);
    if (!/^\d+$/.test(productId || ""))
      return reply(context, "طريقة الاستخدام: شراء <رقم السلعة>.");
    try {
      const { product, balance } = await pointStore.purchase(
        context.userId,
        productId,
      );
      return reply(
        context,
        `تم شراء ${product.name} مقابل ${product.price} نقطة. رصيدك المتبقي: ${balance}.`,
      );
    } catch (error) {
      return storeFailure(context, "purchase", error);
    }
  }

  if (["مقتنياتي", "مشترياتي", "inventory"].includes(sub))
    return sendStoreInventory(context);

  if (["لقب", "تفعيل_لقب", "equip"].includes(sub)) {
    const [productId] = argument.split(/\s+/, 1);
    if (!/^\d+$/.test(productId || ""))
      return reply(context, "طريقة الاستخدام: لقب <رقم اللقب الذي تملكه>.");
    try {
      const product = await pointStore.equipTitle(context.userId, productId);
      return reply(context, `تم تفعيل لقب «${product.name}».`);
    } catch (error) {
      return storeFailure(context, "equip", error);
    }
  }

  if (["إضافة", "اضافة", "add"].includes(sub))
    return manageStoreProduct(context, "add", argument);
  if (["حذف", "ازالة", "إزالة", "remove"].includes(sub))
    return manageStoreProduct(context, "remove", argument);
  if (["سعر", "price"].includes(sub))
    return manageStoreProduct(context, "price", argument);
  if (["وصف", "description"].includes(sub))
    return manageStoreProduct(context, "description", argument);

  if (sub && !["قائمة", "list"].includes(sub))
    return reply(context, "اكتب متجر لعرض المنتجات، شراء <رقم> للشراء، أو مقتنياتي لعرض مشترياتك.");

  return sendPointStore(context);
}

async function sendPointStore(context) {
  try {
    const [products, balance] = await Promise.all([
      pointStore.listProducts(),
      leaderboard.playerPoints(context.userId),
    ]);
    if (!products.length)
      return reply(context, `المتجر فارغ حالياً. رصيدك: ${balance} نقطة.`);

    const lines = products.map((product) => {
      const type = product.item_type === "cosmetic" ? "لقب/مظهر" : "ميزة";
      const description = product.description ? ` — ${product.description}` : "";
      return `${product.id}. ${product.name} (${type}) — ${product.price} نقطة${description}`;
    });
    return reply(context, `المتجر | رصيدك: ${balance} نقطة\n${lines.join("\n")}\nللشراء: شراء <رقم السلعة>`);
  } catch (error) {
    return storeFailure(context, "list", error);
  }
}

async function sendStoreInventory(context) {
  try {
    const inventory = await pointStore.inventoryFor(context.userId);
    if (!inventory.length) return reply(context, "لا تملك أي منتجات من المتجر بعد.");
    const lines = inventory.map((item) => {
      const quantity = Number(item.quantity) > 1 ? ` ×${item.quantity}` : "";
      const status = item.item_type === "cosmetic" && item.equipped ? " (مفعّل)" : "";
      return `${item.id}. ${item.name}${quantity}${status}`;
    });
    return reply(context, `مشترياتك:\n${lines.join("\n")}\nلتفعيل لقب: لقب <رقم السلعة>`);
  } catch (error) {
    return storeFailure(context, "inventory", error);
  }
}

async function manageStoreProduct(context, action, argument) {
  if (!adminAuth.isAdmin(context.userId))
    return reply(context, "هذا الأمر متاح لأدمن البوت فقط.");

  try {
    if (action === "add") {
      const [definition, name = "", description = ""] = argument.split("|").map((part) => part.trim());
      const match = /^(لقب|مظهر|ميزة)\s+(\d+)$/u.exec(definition || "");
      if (!match || !name)
        return reply(context, "الاستخدام: متجر إضافة <لقب|ميزة> <السعر> | <الاسم> | <الوصف>");
      const itemType = match[1] === "ميزة" ? "perk" : "cosmetic";
      const product = await pointStore.createProduct({
        itemType,
        price: match[2],
        name,
        description,
        createdBy: context.userId,
      });
      return reply(context, `تمت إضافة السلعة ${product.id}: ${product.name} — ${product.price} نقطة.`);
    }

    if (action === "remove") {
      const productId = argument.split(/\s+/, 1)[0];
      if (!/^\d+$/.test(productId || ""))
        return reply(context, "الاستخدام: متجر حذف <رقم السلعة>");
      const removed = await pointStore.removeProduct(productId);
      return reply(context, removed ? "تم حذف السلعة من المتجر." : "لم يتم العثور على سلعة نشطة بهذا الرقم.");
    }

    if (action === "price") {
      const [productId, price] = argument.split(/\s+/, 2);
      if (!/^\d+$/.test(productId || "") || !/^\d+$/.test(price || ""))
        return reply(context, "الاستخدام: متجر سعر <رقم السلعة> <السعر>");
      const updated = await pointStore.updateProductPrice(productId, price);
      return reply(context, updated ? "تم تحديث السعر." : "لم يتم العثور على سلعة نشطة بهذا الرقم.");
    }

    const [productId = "", ...descriptionParts] = argument.split("|");
    const description = descriptionParts.join("|").trim();
    if (!/^\s*\d+\s*$/.test(productId) || !descriptionParts.length)
      return reply(context, "الاستخدام: متجر وصف <رقم السلعة> | <الوصف>");
    const updated = await pointStore.updateProductDescription(productId.trim(), description);
    return reply(context, updated ? "تم تحديث وصف السلعة." : "لم يتم العثور على سلعة نشطة بهذا الرقم.");
  } catch (error) {
    return storeFailure(context, `admin-${action}`, error);
  }
}

function storeFailure(context, operation, error) {
  console.error(`[point store] ${operation} failed:`, error.message);
  const message =
    error instanceof Error && error.message
      ? `تعذر تنفيذ الطلب: ${error.message}`
      : "تعذّر طلب المتجر.";
  return reply(context, message);
}

async function sendGameHelp(context) {
  const argument = commandArguments(context.text);
  const requestedName = argument.replace(/^لعبة\s+/i, "").trim();
  const game = argument ? findGame(requestedName) : defaultGame;
  if (!game) {
    return reply(
      context,
      `لم أتعرف على اللعبة. اختر من الألعاب وأوامرها:\n${formatGameCommands().join("\n")}\nاستخدم /شرح <اسم اللعبة> لعرض القواعد.`,
    );
  }
  return game.engine.handleMessage({
    ...context,
    text: engineCommandText(game, `/${game.helpCommand}`),
  });
}

async function sendGameAvailability(context) {
  const controls = await gameAvailability.list();
  const states = new Map(
    controls.map((control) => [control.game_id, Boolean(control.enabled)]),
  );
  const lines = [...games.values()].map(
    (game) =>
      `• ${game.name} — /${game.startCommand}: ${states.get(game.id) === false ? "⏸️ متوقفة" : "✅ تعمل"}`,
  );
  return reply(context, `🎮 حالة الألعاب:\n${lines.join("\n")}`);
}

async function changeGameAvailability(enabled, context) {
  const requested = commandArguments(context.text).replace(/^لعبة\s+/i, "").trim();
  const game = findGame(requested);
  if (!game)
    return reply(
      context,
      `لم أتعرف على اللعبة. استخدم أحد هذه الأسماء:\n${[...games.values()].map((item) => `• ${item.name} (${item.id}) — /${item.startCommand}`).join("\n")}`,
    );
  await gameAvailability.setEnabled(game.id, enabled, context.userId);
  return reply(
    context,
    enabled
      ? `✅ تم تشغيل ${game.name}. يمكن الآن بدء جولات جديدة.`
      : `⏸️ تم إيقاف ${game.name}. لن تبدأ جولات جديدة؛ المباريات النشطة ستكمل حتى تنتهي.`,
  );
}

async function testPrivateImage(context) {
  if (context.isGroup)
    return msg.sendGroup(
      context.threadId,
      "أرسل /صورة في محادثة خاصة مع البوت لاختبار إرسال الصور.",
    );

  if ((process.env.SPY_IMAGE_DELIVERY || "").toLowerCase() === "host") {
    try {
      const url = await require("./imageHost").upload(createTestImage(), "image/jpeg");
      return msg.sendPrivate(
        context.userId,
        `اختبار الصورة: ${url}`,
      );
    } catch (error) {
      return msg.sendPrivate(context.userId, `فشل رفع الصورة: ${error.message}`);
    }
  }
  const result = await msg.sendPrivateImageBufferWithResult(
    context.userId,
    createTestImage(),
    "image/jpeg",
    "اختبار صورة JPEG.",
  );
  if (!result.ok) {
    console.error("[diagnostic] test image send failed:", result.reason);
    const notice = await msg.sendPrivateWithResult(
      context.userId,
      `فشل إرسال الصورة: ${result.reason || "لا تأكيد من الخدمة."}`,
    );
    if (!notice.ok)
      console.error(
        "[diagnostic] could not notify user about image failure:",
        notice.reason,
      );
    return;
  }

  console.log(
    `[diagnostic] test image accepted for user ${context.userId}, message ${result.messageId}`,
  );
  const notice = await msg.sendPrivateWithResult(
    context.userId,
    `قُبل إرسال الصورة (${result.messageId})؛ لا يؤكد ظهورها على جهازك.`,
  );
  if (!notice.ok)
    console.error(
      "[diagnostic] test image sent but confirmation message failed:",
      notice.reason,
    );
}

async function sendUserPermissions(context) {
  const isAdmin = adminAuth.isAdmin(context.userId);
  const isBanned = await db.isUserBanned(context.userId);
  const lines = [
    `الصلاحية: ${
      adminAuth.isOwner(context.userId)
        ? `مالك البوت (${adminAuth.ownerName})`
        : isAdmin
          ? "أدمن البوت"
          : "مستخدم عادي"
    }`,
    isAdmin
      ? "إلغاء الألعاب وإدارة الحظر متاحان."
      : "يمكنك إلغاء لعبتك واستخدام الألعاب.",
    `الحظر: ${isBanned ? "محظور من بدء الألعاب." : "غير محظور."}`,
  ];
  if (isBanned)
    lines.push("الحظر لا ينهي مباراة بدأت.");
  return reply(context, lines.join("\n"));
}

async function promoteAdmin(context) {
  if (!adminAuth.isOwner(context.userId))
    return reply(context, "⛔ أمر رفع الأدمن متاح لمالك البوت فقط.");
  const argument = commandArguments(context.text)
    .replace(/^(?:ادمن|أدمن|admin)\s*/i, "")
    .trim();
  const targetId = String(context.messageReply?.senderID || argument);
  if (!validMessengerId(targetId))
    return reply(
      context,
      "طريقة الاستخدام: بالرد على رسالة اللاعب أرسل /رفع ادمن، أو أرسل /رفع ادمن <المعرّف>.",
    );
  if (targetId === String(msg.selfId?.() || ""))
    return reply(context, "لا يمكن ترقية حساب البوت إلى أدمن.");
  if (adminAuth.isAdmin(targetId))
    return reply(context, `ℹ️ المستخدم ${targetId} أدمن بالفعل.`);

  const added = await adminAuth.addAdmin(targetId);
  if (!added)
    return reply(context, `ℹ️ المستخدم ${targetId} أدمن بالفعل.`);
  return reply(context, `✅ تمت ترقية المستخدم ${targetId} إلى أدمن البوت.`);
}

async function demoteAdmin(context) {
  if (!adminAuth.isOwner(context.userId))
    return reply(context, "⛔ أمر تنزيل الأدمن متاح لمالك البوت فقط.");

  const argument = commandArguments(context.text)
    .replace(/^(?:ادمن|أدمن|admin)\s*/i, "")
    .trim();
  const targetId = String(context.messageReply?.senderID || argument);
  if (!validMessengerId(targetId))
    return reply(
      context,
      "طريقة الاستخدام: بالرد على رسالة الأدمن أرسل /تنزيل ادمن، أو أرسل /تنزيل ادمن <المعرّف>.",
    );
  if (adminAuth.isOwner(targetId))
    return reply(context, `⛔ لا يمكن تنزيل رتبة مالك البوت (${adminAuth.ownerName}).`);
  if (!adminAuth.isAdmin(targetId))
    return reply(context, `ℹ️ المستخدم ${targetId} ليس أدمن مسجلاً.`);

  const removed = await adminAuth.removeAdmin(targetId);
  if (!removed)
    return reply(context, `ℹ️ المستخدم ${targetId} ليس أدمن مسجلاً.`);
  return reply(context, `✅ تم تنزيل المستخدم ${targetId} من رتبة أدمن البوت.`);
}

function reply(context, text) {
  return context.isGroup
    ? msg.sendGroup(context.threadId, text)
    : msg.sendPrivate(context.userId, text);
}

function commandArguments(text) {
  const command = String(text || "")
    .trim()
    .replace(/^[/!]\s*/, "")
    .replace(/\s+/g, " ");
  const spacedAlias = [...GLOBAL_COMMANDS.keys()]
    .filter((alias) => alias.includes(" "))
    .sort((left, right) => right.length - left.length)
    .find(
      (alias) =>
        command.toLowerCase() === alias.toLowerCase() ||
        command.toLowerCase().startsWith(`${alias.toLowerCase()} `),
    );
  return spacedAlias
    ? command.slice(spacedAlias.length).trim()
    : command.replace(/^\S+\s*/, "");
}

async function handleFixedReplyCommand(command, context) {
  if (!adminAuth.isAdmin(context.userId))
    return reply(context, "⛔ إدارة الردود الثابتة متاحة لأدمن البوت فقط.");
  if (command === "fixed-reply-list") {
    const entries = await fixedReplies.list();
    if (!entries.length) return reply(context, "لا توجد ردود ثابتة محفوظة.");
    const lines = entries.map(
      (entry) => `• ${entry.trigger_text} ← ${entry.response_text}`,
    );
    return reply(context, `الردود الثابتة (آخر ${entries.length}):\n${lines.join("\n")}`);
  }

  const argumentsText = commandArguments(context.text).trim();
  if (command === "fixed-reply-add") {
    const separator = argumentsText.indexOf("|");
    if (separator < 0)
      return reply(
        context,
        "طريقة الاستخدام: /رد أضف <محفز> | <الرد>. مثال: /رد أضف السلام عليكم | وعليكم السلام!",
      );
    const trigger = argumentsText.slice(0, separator).trim();
    const response = argumentsText.slice(separator + 1).trim();
    try {
      await fixedReplies.add(trigger, response, context.userId);
      return reply(context, `✅ حُفظ الرد الثابت للمحفز: ${trigger}`);
    } catch (error) {
      if (error.code === "ER_DUP_ENTRY")
        return reply(context, "يوجد رد ثابت لهذا المحفز بالفعل؛ احذفه أولاً ثم أضفه مجدداً.");
      console.error("[fixed replies] add failed:", error.message);
      return reply(context, `تعذر حفظ الرد الثابت: ${error.message}`);
    }
  }

  const trigger = argumentsText;
  if (!trigger)
    return reply(context, "طريقة الاستخدام: /رد احذف <المحفز>");
  try {
    const removed = await fixedReplies.remove(trigger);
    return reply(
      context,
      removed ? `✅ حُذف الرد الثابت للمحفز: ${trigger}` : "لم أجد رداً ثابتاً بهذا المحفز.",
    );
  } catch (error) {
    console.error("[fixed replies] remove failed:", error.message);
    return reply(context, `تعذر حذف الرد الثابت: ${error.message}`);
  }
}

function validMessengerId(value) {
  return /^\d{1,64}$/.test(value);
}

async function banUser(context) {
  const [targetId, ...reasonParts] = commandArguments(context.text).split(/\s+/);
  if (!validMessengerId(targetId || ""))
    return reply(
      context,
      "طريقة الاستخدام: /حظر <معرّف المستخدم> [السبب]",
    );
  if (adminAuth.isOwner(targetId))
    return reply(context, `⛔ لا يمكن حظر مالك البوت (${adminAuth.ownerName}).`);
  if (adminAuth.isAdmin(targetId))
    return reply(context, "⛔ لا يمكن حظر أدمن مسجّل في إعدادات البوت.");

  const reason = reasonParts.join(" ").slice(0, 500);
  await db.banUser(targetId, context.userId, reason);
  return reply(
    context,
    `✅ تم حظر المستخدم ${targetId} من التسجيل في جميع الألعاب.${reason ? `\nالسبب: ${reason}` : ""}`,
  );
}

async function deductPoints(context) {
  if (!context.isGroup)
    return reply(context, "استخدم أمر خصم نقاط داخل المجموعة التي تريد خصم النقاط منها.");

  let remainder = commandArguments(context.text).trim();
  remainder = remainder.replace(/^نقاط\s*/i, "").trim();

  let targetId = context.messageReply?.senderID ? String(context.messageReply.senderID) : "";
  let amountText = remainder;
  if (!targetId) {
    const [parsedTargetId, ...rest] = remainder.split(/\s+/);
    targetId = parsedTargetId || "";
    amountText = rest.join(" ");
  }

  if (!validMessengerId(targetId || ""))
    return reply(
      context,
      "طريقة الاستخدام: بالرد على رسالة اللاعب اكتب خصم نقاط 10، أو اكتب خصم نقاط <المعرّف> <المبلغ>.",
    );

  const amount = Number(amountText);
  if (!Number.isFinite(amount) || amount <= 0)
    return reply(
      context,
      "طريقة الاستخدام: بالرد على رسالة اللاعب اكتب خصم نقاط 10، أو اكتب خصم نقاط <المعرّف> <المبلغ>.",
    );

  if (adminAuth.isOwner(targetId) || adminAuth.isAdmin(targetId))
    return reply(context, "⛔ لا يمكن خصم نقاط مالك البوت أو أي أدمن مسجّل.");

  const previousPoints = await leaderboard.playerPoints(targetId);
  const deducted = Math.min(previousPoints, Math.trunc(amount));
  const result = await leaderboard.deductPoints(targetId, deducted);
  const finalPoints = result.newPoints ?? Math.max(0, previousPoints - deducted);
  return reply(
    context,
    `✅ تم خصم ${deducted} نقطة${deducted === 1 ? "" : "ات"} من المستخدم ${targetId}. النقاط الحالية: ${finalPoints}.`,
  );
}

async function kickUser(context) {
  if (!context.isGroup)
    return reply(context, "استخدم أمر /طرد داخل المجموعة التي تريد طرد عضو منها.");

  const targetId = String(context.messageReply?.senderID || commandArguments(context.text).split(/\s+/, 1)[0] || "");
  if (!validMessengerId(targetId))
    return reply(
      context,
      "طريقة الاستخدام: بالرد على رسالة اللاعب أرسل طرد، أو أرسل طرد <المعرّف>.",
    );
  if (adminAuth.isOwner(targetId))
    return reply(context, `⛔ لا يمكن طرد مالك البوت (${adminAuth.ownerName}).`);
  if (adminAuth.isAdmin(targetId))
    return reply(context, "⛔ لا يمكن طرد أدمن مسجّل في إعدادات البوت.");
  if (String(targetId) === String(context.userId))
    return reply(context, "⛔ لا يمكنك طرد نفسك.");

  try {
    await msg.removeUserFromGroup(targetId, context.threadId);
    return reply(context, `✅ تم طرد المستخدم ${targetId} من المجموعة.`);
  } catch (error) {
    console.error("[game manager] kick failed:", error && error.message ? error.message : error);
    return reply(
      context,
      `⚠️ تعذّر طرد المستخدم ${targetId}. قد لا تدعم واجهة الرسائل هذه العملية أو قد تكون صلاحيات البوت غير كافية.`,
    );
  }
}

async function unbanUser(context) {
  const targetId = commandArguments(context.text).split(/\s+/, 1)[0];
  if (!validMessengerId(targetId || ""))
    return reply(context, "طريقة الاستخدام: /فك حظر <معرّف المستخدم>");
  const result = await db.unbanUser(targetId);
  if (!result.affectedRows)
    return reply(context, `ℹ️ المستخدم ${targetId} غير موجود في قائمة الحظر.`);
  return reply(context, `✅ تم رفع الحظر عن المستخدم ${targetId}.`);
}

async function sendBanList(context) {
  const banned = await db.listBannedUsers();
  if (!banned.length) return reply(context, "✅ لا يوجد مستخدمون محظورون.");
  const lines = banned.map(
    (entry) =>
      `• ${entry.psid}${entry.reason ? ` — ${entry.reason}` : ""}`,
  );
  return reply(context, `🚫 قائمة المحظورين:\n${lines.join("\n")}`);
}

async function activeRoomForThread(threadId) {
  return db.one(
    "SELECT game_id FROM game_rooms WHERE thread_id=? AND status IN ('lobby','playing') ORDER BY id DESC LIMIT 1",
    [threadId],
  );
}

async function activeGameForUser(userId) {
  const room = await findActiveGameForPlayer(userId);
  return room ? games.get(room.game_id) || null : null;
}

async function hasActiveGame(context) {
  if (context.isGroup)
    return Boolean(await activeRoomForThread(context.threadId));
  return Boolean(await findActiveGameForPlayer(context.userId));
}

const CONTROLLABLE_COMMANDS = [
  { id: "leaderboard", name: "ترتيب النقاط (التصنيف)", command: "/التصنيف", aliases: ["leaderboard", "top"] },
  { id: "my-points", name: "عرض نقاطي", command: "/نقاطي", aliases: ["my-points"] },
  { id: "point-store", name: "متجر النقاط والمشتريات", command: "/متجر", aliases: ["point-store"] },
  { id: "storm-logo", name: "إضافة شعار على الصور", command: "/شعار", aliases: ["storm-logo"] },
  { id: "image-quality", name: "رفع جودة الصور الذكي", command: "/جودة", aliases: ["image-quality"] },
  { id: "fixed-reply", name: "الردود الثابتة التلقائية", command: "/الردود الثابتة", aliases: ["fixed-reply-add", "fixed-reply-remove", "fixed-reply-list"] },
  { id: "test-image", name: "اختبار إرسال الصور", command: "/صورة", aliases: ["test-image"] },
];

async function handleMessage(context) {
  idlePause.check();
  const globalCommand = globalCommandFor(context.text);
  if (botPaused && !isBotControlCommand(context.text)) {
    if (context.isGroup) {
      const threadKey = String(context.threadId);
      if (!pauseNotifiedThreads.has(threadKey)) {
        pauseNotifiedThreads.add(threadKey);
        msg.sendGroup(
          context.threadId,
          "⏸️ البوت في وضع السكون حالياً لتخفيف النشاط وحماية الحساب.\nيمكن للأدمن استئنافه بإرسال /تشغيل البوت في خاص البوت.",
        ).catch(() => {});
      }
    }
    return;
  }
  if (globalCommand) {
    if (
      context.userId &&
      isGlobalCommandCoolingDown(
        `${context.platform || "messenger"}:${context.userId}`,
        globalCommand,
      )
    )
      return;
    const controllable = CONTROLLABLE_COMMANDS.find(
      (c) => c.id === globalCommand || c.aliases.includes(globalCommand),
    );
    if (controllable && !(await gameAvailability.isEnabled(controllable.id))) {
      return reply(
        context,
        `⏸️ أمر (${controllable.name}) متوقف حالياً من قِبل إدارة البوت.`,
      );
    }
    return handleGlobalCommand(globalCommand, context);
  }

  const availability = new Map();
  const isGameEnabled = (gameId) => {
    if (!availability.has(gameId))
      availability.set(gameId, gameAvailability.isEnabled(gameId));
    return availability.get(gameId);
  };
  const requestedGame = gameForCommand(context.text);
  let game;
  let room;
  let activeGame = null;
  if (context.isGroup) {
    room = await activeRoomForThread(context.threadId);
    if (
      requestedGame &&
      !(room?.game_id === requestedGame.id) &&
      !(await isGameEnabled(requestedGame.id))
    )
      return msg.sendGroup(
        context.threadId,
        `⏸️ ${requestedGame.name} متوقفة حالياً. لا يمكن بدء جولة جديدة حتى يعيد مالك البوت تشغيلها.`,
      );
    if (room) {
      game = games.get(room.game_id || "crime");
      if (!game) {
        console.error(
          `[game manager] active room uses unregistered game "${room.game_id}"`,
        );
        return msg.sendGroup(
          context.threadId,
          "⚠️ اللعبة النشطة غير مسجلة في النظام حالياً. لا يمكن توجيه الرسالة لها.",
        );
      }
      if (
        requestedGame &&
        requestedGame.id !== game.id &&
        isStartCommand(requestedGame, context.text)
      )
        return msg.sendGroup(
          context.threadId,
          `⚠️ توجد لعبة نشطة بالفعل (${game.name}). أنهِها أولاً قبل بدء لعبة أخرى.`,
        );
    }
  } else {
    if (!requestedGame || !(await isGameEnabled(requestedGame.id))) {
      activeGame = await activeGameForUser(context.userId);
      if (requestedGame && requestedGame.id !== activeGame?.id)
        return msg.sendPrivate(
          context.userId,
          `⏸️ ${requestedGame.name} متوقفة حالياً. لا يمكن بدء جولة جديدة حتى يعيد مالك البوت تشغيلها.`,
        );
    }
    game = requestedGame || activeGame;
  }
  if (
    !requestedGame &&
    !room &&
    !activeGame &&
    !/^[/!]/.test(String(context.text || "").trim())
  ) {
    const response = await fixedReplies.findMatch(context.text);
    if (response)
      return context.isGroup
        ? msg.sendGroup(context.threadId, response)
        : msg.sendPrivate(context.userId, response);
  }
  game ||= requestedGame || defaultGame;
  if (
    game &&
    isStartCommand(game, context.text) &&
    !(await isGameEnabled(game.id))
  )
    return reply(
      context,
      `⏸️ ${game.name} متوقفة حالياً. لا يمكن بدء جولة جديدة حتى يعيد مالك البوت تشغيلها.`,
    );
  return game.engine.handleMessage({
    ...context,
    text: engineCommandText(game, context.text),
  });
}

async function handleReaction(context) {
  const room = await db.one(
    "SELECT game_id FROM game_rooms WHERE thread_id=? AND lobby_message_id=? AND status='lobby' AND phase='lobby'",
    [context.threadId, context.messageId],
  );
  const game = room ? games.get(room.game_id || "crime") : null;
  if (room && !game)
    console.error(
      `[game manager] lobby reaction belongs to unregistered game "${room.game_id}"`,
    );
  if (!game) return;
  return game.engine.handleReaction(context);
}

// غرف عالقة (انهيار أثناء توزيع الأدوار/الفرز أو لعبة منسية) تحجب المجموعة من بدء أي لعبة جديدة؛ ننهيها تلقائياً.
async function cleanupStaleRooms() {
  const stale = await db.query(
    `SELECT id, thread_id, game_id FROM game_rooms
     WHERE (status='lobby' AND created_at < NOW() - INTERVAL 1 HOUR)
        OR (status='playing' AND phase IN ('assigning','tallying','final_tallying','hunter')
            AND updated_at < NOW() - INTERVAL 10 MINUTE)
        OR (status='playing' AND updated_at < NOW() - INTERVAL 3 HOUR)`,
  );
  for (const room of stale) {
    const result = await db.query(
      "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=? AND status IN ('lobby','playing')",
      [room.id],
    );
    if (result.affectedRows)
      await msg.sendGroup(
        room.thread_id,
        "⌛ أُنهيت لعبة عالقة تلقائياً. اكتبوا اسم أي لعبة لبدء جولة جديدة!",
      );
  }
}

function startTickers() {
  idlePause.resume();
  if (!idleCheckTimer) {
    idleCheckTimer = setInterval(() => idlePause.check(), 10_000);
    idleCheckTimer.unref?.();
  }
  for (const game of games.values()) game.engine.startTicker?.();
  phaseReminders.start(); // تنبيهات الوقت المتبقي (30 / 10 ثوانٍ) لكل الألعاب
  const cleanup = () =>
    cleanupStaleRooms().catch((error) =>
      console.error("[game manager] stale room cleanup failed:", error.message),
    );
  setInterval(cleanup, 5 * 60 * 1000).unref?.();
  setTimeout(cleanup, 30 * 1000).unref?.();
}

async function assertSchemas() {
  for (const game of games.values()) {
    if (typeof game.engine.assertSchema !== "function") continue;
    await game.engine.assertSchema();
    console.log(`[game manager] schema is ready for ${game.id}`);
  }
  await leaderboard.syncScores();
}

module.exports = {
  handleMessage,
  isRecognizedCommand,
  isBotControlCommand,
  getRegisteredGames: () =>
    [...games.values()].map((g) => ({
      id: g.id,
      name: g.name,
      startCommand: g.startCommand,
      helpCommand: g.helpCommand,
    })),
  CONTROLLABLE_COMMANDS,
  isBotPaused: () => {
    idlePause.check();
    return botPaused;
  },
  noteActivity: () => idlePause.noteActivity(),
  handleReaction,
  hasActiveGame,
  startTickers,
  assertSchemas,
  _internal: {
    engineCommandText,
    globalCommandFor,
    setIdleClock: (clock) => {
      idleClock = clock;
    },
    resetIdleTimer: () => idlePause.resume(),
    resetCommandCooldowns: () => isGlobalCommandCoolingDown.reset(),
  },
};
