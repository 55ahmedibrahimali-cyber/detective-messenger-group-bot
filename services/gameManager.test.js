const test = require("node:test");
const assert = require("node:assert/strict");
const gameManager = require("./gameManager");
const leaderboard = require("./leaderboard");
const msg = require("./messenger");
const adminAuth = require("./adminAuth");
const gameAvailability = require("./gameAvailability");
const pointStore = require("./pointStore");
const fixedReplies = require("./fixedReplies");
const stormLogo = require("./stormLogo");
const imageQuality = require("./imageQuality");
const db = require("../database");
const { IDLE_TIMEOUT_MS } = require("./idlePause");
test.beforeEach(() => gameManager._internal.resetCommandCooldowns());

const games = [
  "crime",
  "storm",
  "spy",
  "feign",
  "werewolf",
  "drawing",
  "culture",
  "religion",
  "flags",
  "quote",
  "ordering",
  "wordmarket",
  "footballAuction",
  "spacetoon",
  "cartoonMovies",
  "emojiGuess",
  "animeGuess",
  "emojiFilm",
  "tryEscape",
  "treasureHunt",
  "shadowMarket",
  "rescueCode",
].map((id) => require(`../games/${id}`));
const quizGames = games.filter((game) =>
  ["culture", "religion", "flags"].includes(game.id),
);

test("the general game-help command routes to every game's own rules", async () => {
  const originals = games.map((game) => game.engine.handleMessage);
  const gameNames = [
    "مين قتل كريم",
    "STORM",
    "الجاسوس",
    "فيجن",
    "الذئب",
    "لعبة الرسم",
    "ثقافة عامة",
    "أسئلة دينية",
    "أعلام الدول",
    "من صاحب العبارة",
    "تحدي الترتيب",
    "سوق الكلمات",
    "مزاد كرة القدم",
    "أكمل الأغنية",
    "من أي فيلم كرتون؟",
    "خمن الإيموجي من الوصف",
    "احزر الشخصية (أنمي)",
    "خمن فيلم كرتون من الإيموجي",
    "حاول تهرب",
    "البحث عن الكنز",
    "سوق الظلال",
    "شفرة الإنقاذ",
  ];
  const received = [];
  try {
    games.forEach((game) => {
      game.engine.handleMessage = async (context) => {
        received.push({ gameId: game.id, text: context.text });
      };
    });
    for (const [index, game] of games.entries()) {
      gameManager._internal.resetCommandCooldowns();
      await gameManager.handleMessage({
        text: `/شرح ${gameNames[index]}`,
        isGroup: true,
        threadId: "help-thread",
        userId: "help-user",
      });
    }

    assert.deepEqual(
      received,
      games.map((game) => ({
        gameId: game.id,
        text: gameManager._internal.engineCommandText(
          game,
          `/${game.helpCommand}`,
        ),
      })),
    );
  } finally {
    games.forEach((game, index) => {
      game.engine.handleMessage = originals[index];
    });
  }
});

test("repeated global commands are ignored during the command cooldown", async () => {
  const originalSendGroup = msg.sendGroup;
  const sentMessages = [];
  gameManager._internal.resetCommandCooldowns();
  msg.sendGroup = async (_threadId, text) => sentMessages.push(text);
  try {
    const context = {
      text: "/games",
      isGroup: true,
      threadId: "cooldown-thread",
      userId: "cooldown-user",
    };
    await gameManager.handleMessage(context);
    await gameManager.handleMessage(context);

    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0], /الألعاب/);

    await gameManager.handleMessage({ ...context, platform: "telegram" });
    assert.equal(sentMessages.length, 2);
  } finally {
    msg.sendGroup = originalSendGroup;
  }
});

test("recognized command detection excludes plain gameplay messages", () => {
  assert.equal(gameManager.isRecognizedCommand("/games"), true);
  assert.equal(gameManager.isRecognizedCommand("جاسوس"), true);
  assert.equal(gameManager.isRecognizedCommand("إجابة عادية"), false);
});

test("every registered game help command produces its rules message", async () => {
  const originalSendGroup = msg.sendGroup;
  const messages = [];
  msg.sendGroup = async (_threadId, text) => {
    messages.push(text);
    return true;
  };
  try {
    for (const [index, game] of games.entries()) {
      const before = messages.length;
      await game.engine.handleMessage({
        text: gameManager._internal.engineCommandText(
          game,
          `/${game.helpCommand}`,
        ),
        isGroup: true,
        threadId: `rules-${index}`,
        userId: "rules-user",
      });
      assert.ok(messages.length > before, `no rules response for ${game.id}`);
      assert.ok(
        messages.slice(before).some((message) => typeof message === "string" && message.trim()),
        `empty rules response for ${game.id}`,
      );
    }
  } finally {
    msg.sendGroup = originalSendGroup;
  }
});

test("saved replies are restricted to admins and match only outside active games", async () => {
  const originals = {
    one: db.one,
    findMatch: fixedReplies.findMatch,
    sendGroup: msg.sendGroup,
  };
  let sentMessage;
  db.one = async () => null;
  fixedReplies.findMatch = async (text) =>
    text.includes("كلمة محفزة") ? "رد محفوظ" : null;
  msg.sendGroup = async (_threadId, text) => {
    sentMessage = text;
  };
  try {
    await gameManager.handleMessage({
      text: "/رد_اضف كلمة | رد",
      isGroup: true,
      threadId: "fixed-reply-thread",
      userId: "not-an-admin",
    });
    assert.match(sentMessage, /متاحة لأدمن البوت فقط/);

    await gameManager.handleMessage({
      text: "هذه كلمة محفزة هنا",
      isGroup: true,
      threadId: "fixed-reply-thread",
      userId: "fixed-reply-user",
    });
    assert.equal(sentMessage, "رد محفوظ");

    db.one = async () => ({ game_id: "crime" });
    const crime = games.find((game) => game.id === "crime");
    const originalHandleMessage = crime.engine.handleMessage;
    let forwardedText;
    crime.engine.handleMessage = async (context) => {
      forwardedText = context.text;
    };
    try {
      await gameManager.handleMessage({
        text: "كلمة محفزة",
        isGroup: true,
        threadId: "active-game-thread",
        userId: "fixed-reply-user",
      });
      assert.equal(forwardedText, "كلمة محفزة");
      assert.equal(sentMessage, "رد محفوظ");
    } finally {
      crime.engine.handleMessage = originalHandleMessage;
    }
  } finally {
    db.one = originals.one;
    fixedReplies.findMatch = originals.findMatch;
    msg.sendGroup = originals.sendGroup;
  }
});

test("admins can add, remove, and list saved replies", async () => {
  const originals = {
    isAdmin: adminAuth.isAdmin,
    add: fixedReplies.add,
    remove: fixedReplies.remove,
    list: fixedReplies.list,
    sendGroup: msg.sendGroup,
  };
  const sent = [];
  const operations = [];
  adminAuth.isAdmin = () => true;
  fixedReplies.add = async (...args) => operations.push(["add", ...args]);
  fixedReplies.remove = async (trigger) => {
    operations.push(["remove", trigger]);
    return true;
  };
  fixedReplies.list = async () => [
    { trigger_text: "صباح الخير", response_text: "صباح النور" },
  ];
  msg.sendGroup = async (_threadId, text) => sent.push(text);
  try {
    const context = {
      isGroup: true,
      threadId: "admin-replies-thread",
      userId: "admin-user",
    };
    await gameManager.handleMessage({
      ...context,
      text: "/رد أضف صباح الخير | صباح النور",
    });
    await gameManager.handleMessage({
      ...context,
      text: "/رد احذف صباح الخير",
    });
    await gameManager.handleMessage({
      ...context,
      text: "/الردود الثابتة",
    });
    assert.deepEqual(operations, [
      ["add", "صباح الخير", "صباح النور", "admin-user"],
      ["remove", "صباح الخير"],
    ]);
    assert.match(sent[0], /حُفظ الرد الثابت/);
    assert.match(sent[1], /حُذف الرد الثابت/);
    assert.match(sent[2], /صباح الخير ← صباح النور/);
  } finally {
    adminAuth.isAdmin = originals.isAdmin;
    fixedReplies.add = originals.add;
    fixedReplies.remove = originals.remove;
    fixedReplies.list = originals.list;
    msg.sendGroup = originals.sendGroup;
  }
});

test("the games command lists every game with formatted start and rules commands", async () => {
  const originalSendGroup = msg.sendGroup;
  let sentMessage;
  msg.sendGroup = async (_threadId, text) => {
    sentMessage = text;
    return true;
  };
  try {
    await gameManager.handleMessage({
      text: "العاب",
      isGroup: true,
      threadId: "games-list-thread",
      userId: "games-list-user",
    });

    for (const game of games) {
      assert.ok(sentMessage.includes(game.name), `missing game: ${game.name}`);
      assert.ok(
        sentMessage.includes(`/${game.startCommand}`),
        `missing start command for ${game.name}`,
      );
      assert.ok(
        sentMessage.includes(`/${game.helpCommand}`),
        `missing rules command for ${game.name}`,
      );
    }
    assert.match(sentMessage, /الألعاب المتاحة/);
    assert.match(sentMessage, /01\. .* — 🎮 \//);
    assert.match(sentMessage, /\| 📖 \//);
    assert.match(sentMessage, /\/شرح <اسم اللعبة>/);
    assert.ok(sentMessage.includes("ترتيب"));
    assert.ok(sentMessage.includes("سوق الكلمات"));
    assert.ok(!sentMessage.includes("ترتيب_تحدي"));
    assert.ok(!sentMessage.includes("سوق_الكلمات"));
    assert.ok(sentMessage.includes("/قواعد جاسوس"));
    assert.ok(sentMessage.includes("/احزر الشخصية"));
    assert.ok(sentMessage.includes("/البحث عن الكنز"));
    assert.ok(!sentMessage.includes("/قواعدجاسوس"));
  } finally {
    msg.sendGroup = originalSendGroup;
  }
});

test("registered game command aliases have no exact duplicates", () => {
  for (const game of games) {
    const aliases = [...game.startAliases, ...game.commandAliases];
    assert.equal(
      new Set(aliases.map((alias) => alias.toLowerCase())).size,
      aliases.length,
      `duplicate command alias in ${game.id}`,
    );
  }
});

test("readable spaced game commands normalize to existing engine aliases", () => {
  const treasure = games.find((game) => game.id === "treasure-hunt");
  assert.equal(
    gameManager._internal.engineCommandText(treasure, "/البحث عن الكنز"),
    "/البحثعنالكنز",
  );
  assert.equal(
    gameManager._internal.engineCommandText(treasure, "/قواعد الكنز"),
    "/قواعدالكنز",
  );
  assert.equal(
    gameManager._internal.engineCommandText(treasure, "/تلميح كنز 3"),
    "/تلميحكنز 3",
  );
  assert.equal(
    gameManager._internal.engineCommandText(treasure, "إجابة عادية"),
    "إجابة عادية",
  );
  assert.equal(
    gameManager._internal.globalCommandFor("/تشغيل لعبة سوق الظلال"),
    "enable-game",
  );
  assert.equal(
    gameManager._internal.globalCommandFor("/رد أضف صباح الخير | صباح النور"),
    "fixed-reply-add",
  );
});

test("general help shows owner-only game controls", async () => {
  const originalSendGroup = msg.sendGroup;
  let sentMessage;
  msg.sendGroup = async (_threadId, text) => {
    sentMessage = text;
  };
  try {
    await gameManager.handleMessage({
      text: "/مساعدة",
      isGroup: true,
      threadId: "help-controls-thread",
      userId: "help-controls-user",
    });
    assert.match(sentMessage, /\/الألعاب — قائمة الألعاب/);
    assert.match(sentMessage, /\/شرح <اسم اللعبة> — قواعدها/);
    assert.match(sentMessage, /\/إلغاء — إلغاء اللعبة/);
    assert.match(sentMessage, /شعار <موضع>.*شعار أسفل المنتصف/);
    assert.match(sentMessage, /جودة \(بالرد على صورة\)/);
    assert.match(sentMessage, /ترتيب النقاط/);
    assert.match(sentMessage, /\/تشغيل لعبة <اسم اللعبة>/);
    assert.match(sentMessage, /\/إيقاف لعبة <اسم اللعبة>/);
    assert.match(sentMessage, /\/حالة الألعاب/);
    assert.match(sentMessage, /\/إيقاف البوت/);
    assert.match(sentMessage, /\/تشغيل البوت/);
    assert.match(sentMessage, /\/إغلاق البوت/);
    assert.match(sentMessage, /\/رد أضف <محفز> \| <رد>/);
  } finally {
    msg.sendGroup = originalSendGroup;
  }
});

test("the owner can pause and resume the bot from private chat", async () => {
  const originalSendPrivate = msg.sendPrivate;
  const originalSendGroup = msg.sendGroup;
  const privateMessages = [];
  const groupMessages = [];
  msg.sendPrivate = async (_userId, text) => privateMessages.push(text);
  msg.sendGroup = async (_threadId, text) => groupMessages.push(text);
  const ownerContext = {
    isGroup: false,
    userId: "61555344774852",
    threadId: "bot-control-owner",
  };
  try {
    await gameManager.handleMessage({
      ...ownerContext,
      userId: "not-the-owner",
      text: "/إيقاف البوت",
    });
    assert.equal(gameManager.isBotPaused(), false);
    assert.match(privateMessages.at(-1), /مالك البوت فقط/);

    await gameManager.handleMessage({
      ...ownerContext,
      isGroup: true,
      text: "/إيقاف البوت",
    });
    assert.equal(gameManager.isBotPaused(), false);
    assert.match(groupMessages.at(-1), /في الخاص/);

    await gameManager.handleMessage({
      ...ownerContext,
      text: "/إيقاف البوت",
    });
    assert.equal(gameManager.isBotPaused(), true);
    assert.match(privateMessages.at(-1), /إيقاف البوت مؤقتًا/);

    const sentCount = privateMessages.length;
    await gameManager.handleMessage({
      ...ownerContext,
      text: "/مساعدة",
    });
    assert.equal(privateMessages.length, sentCount);

    await gameManager.handleMessage({
      ...ownerContext,
      text: "/تشغيل البوت",
    });
    assert.equal(gameManager.isBotPaused(), false);
    assert.match(privateMessages.at(-1), /استئناف عمله/);
  } finally {
    if (gameManager.isBotPaused()) {
      await gameManager.handleMessage({
        ...ownerContext,
        text: "/تشغيل البوت",
      });
    }
    msg.sendPrivate = originalSendPrivate;
    msg.sendGroup = originalSendGroup;
  }
});

test("the owner can resume the bot from automatic idle mode", async () => {
  const originalSendPrivate = msg.sendPrivate;
  const privateMessages = [];
  let now = Date.now();
  const ownerContext = {
    isGroup: false,
    userId: "61555344774852",
    threadId: "idle-control-owner",
  };
  msg.sendPrivate = async (_userId, text) => privateMessages.push(text);
  gameManager._internal.setIdleClock(() => now);
  gameManager._internal.resetIdleTimer();
  try {
    now += IDLE_TIMEOUT_MS;
    assert.equal(gameManager.isBotPaused(), true);

    await gameManager.handleMessage({
      ...ownerContext,
      text: "/تشغيل البوت",
    });

    assert.equal(gameManager.isBotPaused(), false);
    assert.match(privateMessages.at(-1), /استئناف عمله/);
  } finally {
    if (gameManager.isBotPaused()) {
      await gameManager.handleMessage({
        ...ownerContext,
        text: "/تشغيل البوت",
      });
    }
    gameManager._internal.setIdleClock(() => Date.now());
    gameManager._internal.resetIdleTimer();
    msg.sendPrivate = originalSendPrivate;
  }
});

test("an admin can pause and resume the bot and check idle status", async () => {
  const originalSendPrivate = msg.sendPrivate;
  const originalSendGroup = msg.sendGroup;
  const originalIsAdmin = adminAuth.isAdmin;
  const originalIsOwner = adminAuth.isOwner;
  const privateMessages = [];
  const groupMessages = [];
  msg.sendPrivate = async (_userId, text) => privateMessages.push(text);
  msg.sendGroup = async (_threadId, text) => groupMessages.push(text);
  adminAuth.isOwner = (id) => String(id) === "61555344774852";
  adminAuth.isAdmin = (id) => String(id) === "61555344774852" || String(id) === "admin-123";

  const adminContext = {
    isGroup: false,
    userId: "admin-123",
    threadId: "admin-thread",
  };
  try {
    await gameManager.handleMessage({
      ...adminContext,
      text: "/حالة السكون",
    });
    assert.match(privateMessages.at(-1), /حالة البوت/);

    await gameManager.handleMessage({
      ...adminContext,
      text: "/إيقاف البوت",
    });
    assert.equal(gameManager.isBotPaused(), true);
    assert.match(privateMessages.at(-1), /إيقاف البوت مؤقتًا/);

    await gameManager.handleMessage({
      isGroup: true,
      userId: "regular-user",
      threadId: "group-notice-thread",
      text: "مرحبا",
    });
    assert.match(groupMessages.at(-1), /وضع السكون/);
    const countAfterFirst = groupMessages.length;

    await gameManager.handleMessage({
      isGroup: true,
      userId: "regular-user",
      threadId: "group-notice-thread",
      text: "الو",
    });
    assert.equal(groupMessages.length, countAfterFirst);

    await gameManager.handleMessage({
      ...adminContext,
      text: "/تشغيل البوت",
    });
    assert.equal(gameManager.isBotPaused(), false);
    assert.match(privateMessages.at(-1), /استئناف عمله/);
  } finally {
    if (gameManager.isBotPaused()) {
      await gameManager.handleMessage({
        ...adminContext,
        text: "/تشغيل البوت",
      });
    }
    adminAuth.isAdmin = originalIsAdmin;
    adminAuth.isOwner = originalIsOwner;
    msg.sendPrivate = originalSendPrivate;
    msg.sendGroup = originalSendGroup;
  }
});

test("admin help sends a readable command list to admins", async () => {
  const originalIsAdmin = adminAuth.isAdmin;
  const originalIsOwner = adminAuth.isOwner;
  const originalSendGroup = msg.sendGroup;
  let sentMessage;
  adminAuth.isAdmin = () => true;
  adminAuth.isOwner = () => true;
  msg.sendGroup = async (_threadId, text) => {
    sentMessage = text;
  };
  try {
    await gameManager.handleMessage({
      text: "/أوامر الأدمن",
      isGroup: true,
      threadId: "admin-help-thread",
      userId: "admin-user",
    });
    assert.equal(typeof sentMessage, "string");
    assert.match(sentMessage, /\/خصم نقاط/);
    assert.match(sentMessage, /\/رد أضف/);
    assert.match(sentMessage, /\/رفع ادمن/);
    assert.doesNotMatch(sentMessage, /\[object Object\]/);
  } finally {
    adminAuth.isAdmin = originalIsAdmin;
    adminAuth.isOwner = originalIsOwner;
    msg.sendGroup = originalSendGroup;
  }
});

test("only the owner can shut down the bot, and only from private chat", async () => {
  const originalSendPrivate = msg.sendPrivate;
  const originalSendGroup = msg.sendGroup;
  const originalExit = process.exit;
  const privateMessages = [];
  const groupMessages = [];
  let exitCode = null;
  msg.sendPrivate = async (_userId, text) => privateMessages.push(text);
  msg.sendGroup = async (_threadId, text) => groupMessages.push(text);
  process.exit = (code) => {
    exitCode = code;
  };
  try {
    await gameManager.handleMessage({
      text: "/إغلاق_البوت",
      isGroup: false,
      userId: "not-the-owner",
    });
    assert.equal(exitCode, null);
    assert.match(privateMessages.at(-1), /مالك البوت فقط/);

    await gameManager.handleMessage({
      text: "/إغلاق_البوت",
      isGroup: true,
      threadId: "shutdown-thread",
      userId: "61555344774852",
    });
    assert.equal(exitCode, null);
    assert.match(groupMessages.at(-1), /في الخاص/);

    await gameManager.handleMessage({
      text: "/إغلاق_البوت",
      isGroup: false,
      userId: "61555344774852",
    });
    assert.equal(exitCode, 0);
    assert.match(privateMessages.at(-1), /جارٍ إغلاق البوت/);
  } finally {
    msg.sendPrivate = originalSendPrivate;
    msg.sendGroup = originalSendGroup;
    process.exit = originalExit;
  }
});

test("bare game-help keeps the default game's explanation", async () => {
  const crime = games.find((game) => game.id === "crime");
  const originalHandleMessage = crime.engine.handleMessage;
  let receivedText;
  crime.engine.handleMessage = async (context) => {
    receivedText = context.text;
  };
  try {
    await gameManager.handleMessage({
      text: "/شرح",
      isGroup: false,
      userId: "help-user",
    });
    assert.equal(
      receivedText,
      gameManager._internal.engineCommandText(crime, `/${crime.helpCommand}`),
    );
  } finally {
    crime.engine.handleMessage = originalHandleMessage;
  }
});

test("game-help lists available rules when the requested game is unknown", async () => {
  const originalSendGroup = msg.sendGroup;
  let sentMessage;
  msg.sendGroup = async (_threadId, text) => {
    sentMessage = text;
  };
  try {
    await gameManager.handleMessage({
      text: "/شرح لعبة غير موجودة",
      isGroup: true,
      threadId: "help-thread",
      userId: "help-user",
    });
    for (const game of games)
      assert.match(sentMessage, new RegExp(`/${game.helpCommand}`));
  } finally {
    msg.sendGroup = originalSendGroup;
  }
});

test("private game commands take precedence over a user's active game", async () => {
  const originalIsEnabled = gameAvailability.isEnabled;
  const originals = games.map((game) => game.engine.canHandleMessage);
  const spy = games.find((game) => game.id === "spy");
  const drawing = games.find((game) => game.id === "drawing");
  const originalSpyHandler = spy.engine.handleMessage;
  let activeGameChecked = false;
  const context = {
    text: "/spytest",
    isGroup: false,
    userId: "test-user",
  };
  try {
    gameAvailability.isEnabled = async () => true;
    games.forEach((game) => {
      game.engine.canHandleMessage = async () => {
        activeGameChecked = true;
        return game.id === "drawing";
      };
    });
    spy.engine.handleMessage = async (receivedContext) => {
      assert.deepEqual(receivedContext, context);
      return "spy command handled";
    };

    assert.equal(
      await gameManager.handleMessage(context),
      "spy command handled",
    );
    assert.equal(activeGameChecked, false);
  } finally {
    gameAvailability.isEnabled = originalIsEnabled;
    games.forEach((game, index) => {
      if (originals[index] === undefined)
        delete game.engine.canHandleMessage;
      else game.engine.canHandleMessage = originals[index];
    });
    spy.engine.handleMessage = originalSpyHandler;
  }
});

test("private active-game lookup uses one query across supported game tables", async () => {
  const originalOne = db.one;
  const drawing = games.find((game) => game.id === "drawing");
  const originalDrawingHandler = drawing.engine.handleMessage;
  let query;
  let params;
  let handled = false;
  try {
    db.one = async (sql, values) => {
      query = sql;
      params = values;
      return { game_id: "drawing" };
    };
    drawing.engine.handleMessage = async () => {
      handled = true;
    };

    await gameManager.handleMessage({
      text: "إجابة خاصة",
      isGroup: false,
      userId: "active-player",
    });

    assert.equal(handled, true);
    assert.equal((query.match(/LEFT JOIN/g) || []).length, 6);
    assert.match(
      query,
      /ORDER BY FIELD\(gr\.game_id, 'crime', 'try-escape', 'treasure-hunt', 'shadow-market', 'rescue-code', 'storm', 'spy', 'feign', 'werewolf', 'drawing'\)/,
    );
    assert.deepEqual(params, Array(6).fill("active-player"));
  } finally {
    db.one = originalOne;
    drawing.engine.handleMessage = originalDrawingHandler;
  }
});

test("private shadow market messages route to the active match", async () => {
  const originalOne = db.one;
  const shadowMarket = games.find((game) => game.id === "shadow-market");
  const originalHandler = shadowMarket.engine.handleMessage;
  let handled = false;
  try {
    db.one = async () => ({ game_id: "shadow-market" });
    shadowMarket.engine.handleMessage = async (context) => {
      handled = context.text === "قبول 1" && context.userId === "buyer";
    };

    await gameManager.handleMessage({
      text: "قبول 1",
      isGroup: false,
      userId: "buyer",
    });

    test("private rescue code messages route to the active match", async () => {
      const originalOne = db.one;
      const rescueCode = games.find((game) => game.id === "rescue-code");
      const originalHandler = rescueCode.engine.handleMessage;
      let handled = false;
      try {
        db.one = async () => ({ game_id: "rescue-code" });
        rescueCode.engine.handleMessage = async (context) => {
          handled = context.text === "معلومةالإنقاذ" && context.userId === "clue-player";
        };

        await gameManager.handleMessage({
          text: "معلومةالإنقاذ",
          isGroup: false,
          userId: "clue-player",
        });

        assert.equal(handled, true);
      } finally {
        db.one = originalOne;
        rescueCode.engine.handleMessage = originalHandler;
      }
    });

    assert.equal(handled, true);
  } finally {
    db.one = originalOne;
    shadowMarket.engine.handleMessage = originalHandler;
  }
});

test("active games are routed independently by group thread", async () => {
  const originalOne = db.one;
  const crime = games.find((game) => game.id === "crime");
  const spy = games.find((game) => game.id === "spy");
  const originalCrimeHandler = crime.engine.handleMessage;
  const originalSpyHandler = spy.engine.handleMessage;
  const activeRooms = new Map([
    ["group-one", "crime"],
    ["group-two", "spy"],
  ]);
  const routed = [];
  try {
    db.one = async (_sql, [threadId]) => ({
      game_id: activeRooms.get(threadId),
    });
    crime.engine.handleMessage = async (context) => {
      routed.push([context.threadId, "crime"]);
    };
    spy.engine.handleMessage = async (context) => {
      routed.push([context.threadId, "spy"]);
    };

    await gameManager.handleMessage({
      text: "رسالة المجموعة الأولى",
      isGroup: true,
      threadId: "group-one",
      userId: "player-one",
    });
    await gameManager.handleMessage({
      text: "رسالة المجموعة الثانية",
      isGroup: true,
      threadId: "group-two",
      userId: "player-two",
    });

    assert.deepEqual(routed, [
      ["group-one", "crime"],
      ["group-two", "spy"],
    ]);
  } finally {
    db.one = originalOne;
    crime.engine.handleMessage = originalCrimeHandler;
    spy.engine.handleMessage = originalSpyHandler;
  }
});

test("AI chat can yield when the current group or private player has an active game", async () => {
  const originalOne = db.one;
  const queries = [];
  try {
    db.one = async (sql, params) => {
      queries.push([sql, params]);
      if (sql.includes("thread_id=?"))
        return params[0] === "busy-group" ? { game_id: "spy" } : null;
      return params[0] === "busy-player" ? { game_id: "crime" } : null;
    };

    assert.equal(
      await gameManager.hasActiveGame({
        isGroup: true,
        threadId: "busy-group",
      }),
      true,
    );
    assert.equal(
      await gameManager.hasActiveGame({
        isGroup: true,
        threadId: "idle-group",
      }),
      false,
    );
    assert.equal(
      await gameManager.hasActiveGame({
        isGroup: false,
        userId: "busy-player",
      }),
      true,
    );
    assert.equal(queries.length, 3);
    assert.deepEqual(queries[0][1], ["busy-group"]);
    assert.deepEqual(queries[1][1], ["idle-group"]);
    assert.match(queries[2][0], /room_players/);
    assert.match(queries[2][0], /try-escape/);
    assert.match(queries[2][0], /treasure-hunt/);
    assert.match(queries[2][0], /shadow-market/);
  } finally {
    db.one = originalOne;
  }
});

test("idle group messages do not query game availability", async () => {
  const originalOne = db.one;
  const originalIsEnabled = gameAvailability.isEnabled;
  const originalFindMatch = fixedReplies.findMatch;
  const crime = games.find((game) => game.id === "crime");
  const originalCrimeHandler = crime.engine.handleMessage;
  let availabilityChecks = 0;
  let handled = false;
  try {
    db.one = async () => null;
    fixedReplies.findMatch = async () => null;
    gameAvailability.isEnabled = async () => {
      availabilityChecks += 1;
      return true;
    };
    crime.engine.handleMessage = async () => {
      handled = true;
    };

    await gameManager.handleMessage({
      text: "رسالة عادية",
      isGroup: true,
      threadId: "idle-group",
      userId: "idle-user",
    });

    assert.equal(handled, true);
    assert.equal(availabilityChecks, 0);
  } finally {
    db.one = originalOne;
    gameAvailability.isEnabled = originalIsEnabled;
    fixedReplies.findMatch = originalFindMatch;
    crime.engine.handleMessage = originalCrimeHandler;
  }
});

test("a game start checks availability only once per message", async () => {
  const originalOne = db.one;
  const originalIsEnabled = gameAvailability.isEnabled;
  const spy = games.find((game) => game.id === "spy");
  const originalSpyHandler = spy.engine.handleMessage;
  let availabilityChecks = 0;
  let handled = false;
  try {
    db.one = async () => null;
    gameAvailability.isEnabled = async () => {
      availabilityChecks += 1;
      return true;
    };
    spy.engine.handleMessage = async () => {
      handled = true;
    };

    await gameManager.handleMessage({
      text: "/جاسوس",
      isGroup: true,
      threadId: "start-group",
      userId: "start-user",
    });

    assert.equal(handled, true);
    assert.equal(availabilityChecks, 1);
  } finally {
    db.one = originalOne;
    gameAvailability.isEnabled = originalIsEnabled;
    spy.engine.handleMessage = originalSpyHandler;
  }
});

test("the global ranking command replies with the top players in a group", async () => {
  const originalTopPlayers = leaderboard.topPlayers;
  const originalSendGroup = msg.sendGroup;
  let sentMessage;
  leaderboard.topPlayers = async () => [
    { display_name: "الأول", points: 4 },
    { display_name: "الثاني", points: 2 },
  ];
  msg.sendGroup = async (_threadId, text) => {
    sentMessage = text;
    return true;
  };
  try {
    for (const text of ["/ترتيب النقاط", "/التصنيف"]) {
      await gameManager.handleMessage({
        text,
        isGroup: true,
        threadId: "ranking-thread",
        userId: "test-user",
      });
      assert.match(sentMessage, /الأول — 4 نقاط/);
      assert.match(sentMessage, /الثاني — 2 نقاط/);
    }
  } finally {
    leaderboard.topPlayers = originalTopPlayers;
    msg.sendGroup = originalSendGroup;
  }
});

test("the storm logo command receives the replied image context", async () => {
  const originalHandle = stormLogo.handle;
  const reply = { attachments: [{ type: "photo", url: "https://example.com/photo" }] };
  let receivedContext;
  stormLogo.handle = async (context) => {
    receivedContext = context;
  };
  try {
    await gameManager.handleMessage({
      text: "/شعار أسفل المنتصف",
      isGroup: true,
      threadId: "storm-logo-thread",
      userId: "test-user",
      messageReply: reply,
    });

    test("the standalone quality command routes through the global command handler", async () => {
      const originalHandle = imageQuality.handle;
      let receivedContext;
      imageQuality.handle = async (context) => {
        receivedContext = context;
      };
      try {
        const context = {
          text: "/جودة",
          isGroup: true,
          threadId: "image-quality-thread",
          userId: "test-user",
          messageReply: { attachments: [{ type: "photo" }] },
        };
        await gameManager.handleMessage(context);
        assert.equal(receivedContext, context);
      } finally {
        imageQuality.handle = originalHandle;
      }
    });
    assert.equal(receivedContext.messageReply, reply);
    assert.equal(receivedContext.threadId, "storm-logo-thread");
    assert.equal(receivedContext.text, "/شعار أسفل المنتصف");
  } finally {
    stormLogo.handle = originalHandle;
  }
});

test("renamed game start commands route to their games", async () => {
  const targets = [
    ["crime", "جريمة"],
    ["ordering", "ترتيب"],
    ["wordmarket", "سوق الكلمات"],
    ["cartoon-film", "كرتون"],
    ["emoji-film", "افلام"],
    ["emoji-guess", "خمن الإيموجي"],
    ["anime-guess", "احزر الشخصية"],
    ["shadow-market", "سوق الظلال"],
    ["rescue-code", "شفرة الإنقاذ"],
  ].map(([id, text]) => ({
    game: games.find((item) => item.id === id),
    text,
  }));
  const originalDbOne = db.one;
  const originalHandlers = targets.map(({ game }) => game.engine.handleMessage);
  const routed = [];
  db.one = async () => null;
  targets.forEach(({ game }) => {
    game.engine.handleMessage = async () => routed.push(game.id);
  });
  try {
    for (const { text } of targets) {
      await gameManager.handleMessage({
        text,
        isGroup: true,
        threadId: `renamed-command-${text}`,
        userId: "command-user",
      });
    }
    assert.deepEqual(
      routed,
      targets.map(({ game }) => game.id),
    );
  } finally {
    db.one = originalDbOne;
    targets.forEach(({ game }, index) => {
      game.engine.handleMessage = originalHandlers[index];
    });
  }
});

test("the my-points command replies with the sender's score in private", async () => {
  const originalPlayerPoints = leaderboard.playerPoints;
  const originalActiveTitle = leaderboard.activeTitle;
  const originalSendPrivate = msg.sendPrivate;
  let queriedPlayer;
  let sentMessage;
  leaderboard.playerPoints = async (userId) => {
    queriedPlayer = userId;
    return 7;
  };
  leaderboard.activeTitle = async () => null;
  msg.sendPrivate = async (_userId, text) => {
    sentMessage = text;
    return true;
  };
  try {
    await gameManager.handleMessage({
      text: "/نقاطي",
      isGroup: false,
      threadId: "private-thread",
      userId: "score-owner",
    });
    assert.equal(queriedPlayer, "score-owner");
    assert.match(sentMessage, /نقاطك: 7 نقاط/);
  } finally {
    leaderboard.playerPoints = originalPlayerPoints;
    leaderboard.activeTitle = originalActiveTitle;
    msg.sendPrivate = originalSendPrivate;
  }
});

test("the cancel command cancels cultural quiz games and confirms it in the group", async () => {
  const originalOne = db.one;
  const originalQuery = db.query;
  const originalIsAdmin = adminAuth.isAdmin;
  const originalSendGroup = msg.sendGroup;
  const cancelledRooms = [];
  const sentMessages = [];
  let roomId = 100;
  db.one = async (sql, params) => {
    if (sql.includes("SELECT game_id FROM game_rooms"))
      return { game_id: String(params[0]).replace(/^cancel-/, "") };
    if (sql.includes("SELECT id, host_psid FROM game_rooms"))
      return { id: ++roomId, host_psid: "quiz-host" };
    throw new Error(`Unexpected database query: ${sql}`);
  };
  db.query = async (_sql, params) => {
    cancelledRooms.push(params[0]);
    return { affectedRows: 1 };
  };
  adminAuth.isAdmin = () => false;
  msg.sendGroup = async (_threadId, text) => {
    sentMessages.push(text);
    return true;
  };
  try {
    for (const game of quizGames) {
      gameManager._internal.resetCommandCooldowns();
      await gameManager.handleMessage({
        text: "الغاء",
        isGroup: true,
        threadId: `cancel-${game.id}`,
        userId: "quiz-host",
      });
    }
    assert.deepEqual(cancelledRooms, [101, 102, 103]);
    assert.equal(sentMessages.length, quizGames.length);
    quizGames.forEach((game, index) =>
      assert.match(sentMessages[index], new RegExp(`أُلغيت لعبة ${game.name}`)),
    );
  } finally {
    db.one = originalOne;
    db.query = originalQuery;
    adminAuth.isAdmin = originalIsAdmin;
    msg.sendGroup = originalSendGroup;
  }
});

test("connection status is limited to admins and shows Messenger health", async () => {
  const originalIsAdmin = adminAuth.isAdmin;
  const originalGetConnectionStatus = msg.getConnectionStatus;
  const originalSendGroup = msg.sendGroup;
  const originalSendPrivate = msg.sendPrivate;
  let sentMessage;
  adminAuth.isAdmin = (userId) => userId === "admin-user";
  msg.getConnectionStatus = () => ({
    loggedIn: true,
    listenerHealthy: true,
    e2eeSupported: true,
    e2eeConnected: false,
  });
  msg.sendGroup = async (_threadId, text) => {
    sentMessage = text;
    return true;
  };
  msg.sendPrivate = async (_userId, text) => {
    sentMessage = text;
    return true;
  };
  try {
    await gameManager.handleMessage({
      text: "حالة_الاتصال",
      isGroup: true,
      threadId: "status-thread",
      userId: "admin-user",
    });
    assert.match(sentMessage, /جلسة الحساب: مسجل الدخول/);
    assert.match(sentMessage, /استقبال الرسائل: يعمل/);
    assert.match(sentMessage, /الرسائل المشفرة: غير متصل/);

    await gameManager.handleMessage({
      text: "حالة_الاتصال",
      isGroup: false,
      userId: "regular-user",
    });
    assert.equal(sentMessage, "هذا الأمر متاح لأدمن البوت فقط.");
  } finally {
    adminAuth.isAdmin = originalIsAdmin;
    msg.getConnectionStatus = originalGetConnectionStatus;
    msg.sendGroup = originalSendGroup;
    msg.sendPrivate = originalSendPrivate;
  }
});

test("only the owner can promote an admin, including by ID in private", async () => {
  const originalAddAdmin = adminAuth.addAdmin;
  const originalSendPrivate = msg.sendPrivate;
  let addedId;
  let sentMessage;
  adminAuth.addAdmin = async (targetId) => {
    addedId = targetId;
    return true;
  };
  msg.sendPrivate = async (_userId, text) => {
    sentMessage = text;
    return true;
  };
  try {
    await gameManager.handleMessage({
      text: "/رفع ادمن 9876543210",
      isGroup: false,
      threadId: "owner-private",
      userId: "61555344774852",
    });
    assert.equal(addedId, "9876543210");
    assert.match(sentMessage, /تمت ترقية المستخدم 9876543210/);

    addedId = undefined;
    await gameManager.handleMessage({
      text: "/رفع ادمن 9876543210",
      isGroup: false,
      threadId: "admin-private",
      userId: "987654321",
    });
    assert.equal(addedId, undefined);
    assert.match(sentMessage, /متاح لمالك البوت فقط/);
  } finally {
    adminAuth.addAdmin = originalAddAdmin;
    msg.sendPrivate = originalSendPrivate;
  }
});

test("only the owner can demote admins, and cannot demote themselves", async () => {
  const originalRemoveAdmin = adminAuth.removeAdmin;
  const originalIsAdmin = adminAuth.isAdmin;
  const originalSendPrivate = msg.sendPrivate;
  let removedId;
  let sentMessage;
  adminAuth.removeAdmin = async (targetId) => {
    removedId = targetId;
    return true;
  };
  adminAuth.isAdmin = (userId) =>
    userId === "61555344774852" || userId === "555123456";
  msg.sendPrivate = async (_userId, text) => {
    sentMessage = text;
    return true;
  };
  try {
    await gameManager.handleMessage({
      text: "/تنزيل ادمن 555123456",
      isGroup: false,
      threadId: "owner-private",
      userId: "61555344774852",
    });
    assert.equal(removedId, "555123456");
    assert.match(sentMessage, /تم تنزيل المستخدم 555123456/);

    removedId = undefined;
    gameManager._internal.resetCommandCooldowns();
    await gameManager.handleMessage({
      text: "/تنزيل ادمن 61555344774852",
      isGroup: false,
      threadId: "owner-private",
      userId: "61555344774852",
    });
    assert.equal(removedId, undefined);
    assert.match(sentMessage, /لا يمكن تنزيل رتبة مالك البوت/);
  } finally {
    adminAuth.removeAdmin = originalRemoveAdmin;
    adminAuth.isAdmin = originalIsAdmin;
    msg.sendPrivate = originalSendPrivate;
  }
});

test("admins can kick a user by reply while protecting the owner and admins", async () => {
  const originalRemoveUserFromGroup = msg.removeUserFromGroup;
  const originalIsAdmin = adminAuth.isAdmin;
  const originalSendGroup = msg.sendGroup;
  let removedTarget;
  let sentMessage;
  msg.removeUserFromGroup = async (targetId, threadId) => {
    removedTarget = { targetId, threadId };
    return true;
  };
  adminAuth.isAdmin = (userId) =>
    userId === "61555344774852" || userId === "555123456";
  msg.sendGroup = async (_threadId, text) => {
    sentMessage = text;
    return true;
  };
  try {
    await gameManager.handleMessage({
      text: "طرد",
      isGroup: true,
      threadId: "group-1",
      userId: "555123456",
      messageReply: { senderID: "9876543210" },
    });
    assert.deepEqual(removedTarget, { targetId: "9876543210", threadId: "group-1" });
    assert.match(sentMessage, /تم طرد المستخدم 9876543210/);

    removedTarget = undefined;
    gameManager._internal.resetCommandCooldowns();
    await gameManager.handleMessage({
      text: "طرد",
      isGroup: true,
      threadId: "group-1",
      userId: "555123456",
      messageReply: { senderID: "61555344774852" },
    });
    assert.equal(removedTarget, undefined);
    assert.match(sentMessage, /لا يمكن طرد مالك البوت/);

    await gameManager.handleMessage({
      text: "/طرد",
      isGroup: true,
      threadId: "group-1",
      userId: "7777777",
      messageReply: { senderID: "9876543210" },
    });
    assert.match(sentMessage, /هذا الأمر متاح لأدمن البوت فقط/);
  } finally {
    msg.removeUserFromGroup = originalRemoveUserFromGroup;
    adminAuth.isAdmin = originalIsAdmin;
    msg.sendGroup = originalSendGroup;
  }
});

test("admins can deduct points from a player", async () => {
  const originalDeductPoints = leaderboard.deductPoints;
  const originalPlayerPoints = leaderboard.playerPoints;
  const originalIsAdmin = adminAuth.isAdmin;
  const originalSendGroup = msg.sendGroup;
  let sentMessage;
  let deductedPayload;

  leaderboard.playerPoints = async () => 15;
  leaderboard.deductPoints = async (targetId, amount) => {
    deductedPayload = { targetId, amount };
    return { newPoints: 10 };
  };
  adminAuth.isAdmin = (userId) => userId === "555123456";
  msg.sendGroup = async (_threadId, text) => {
    sentMessage = text;
    return true;
  };

  try {
    await gameManager.handleMessage({
      text: "خصم نقاط 10",
      isGroup: true,
      threadId: "group-1",
      userId: "555123456",
      messageReply: { senderID: "9876543210" },
    });
    assert.deepEqual(deductedPayload, { targetId: "9876543210", amount: 10 });
    assert.match(sentMessage, /تم خصم 10 نقطة/);
    assert.match(sentMessage, /النقاط الحالية: 10/);
  } finally {
    leaderboard.deductPoints = originalDeductPoints;
    leaderboard.playerPoints = originalPlayerPoints;
    adminAuth.isAdmin = originalIsAdmin;
    msg.sendGroup = originalSendGroup;
  }
});

test("admins can add products to the point store, while regular users cannot", async () => {
  const originalCreateProduct = pointStore.createProduct;
  const originalIsAdmin = adminAuth.isAdmin;
  const originalSendGroup = msg.sendGroup;
  const calls = [];
  let sentMessage;
  pointStore.createProduct = async (product) => {
    calls.push(product);
    return { id: 17, name: product.name, price: Number(product.price) };
  };
  adminAuth.isAdmin = (userId) => userId === "admin";
  msg.sendGroup = async (_threadId, text) => {
    sentMessage = text;
    return true;
  };

  try {
    await gameManager.handleMessage({
      text: "متجر إضافة لقب 100 | محقق | لقب خاص",
      isGroup: true,
      threadId: "store-thread",
      userId: "admin",
    });
    assert.deepEqual(calls[0], {
      itemType: "cosmetic",
      price: "100",
      name: "محقق",
      description: "لقب خاص",
      createdBy: "admin",
    });
    assert.match(sentMessage, /تمت إضافة السلعة 17/);

    calls.length = 0;
    await gameManager.handleMessage({
      text: "متجر إضافة ميزة 100 | عنصر",
      isGroup: true,
      threadId: "store-thread",
      userId: "player",
    });
    assert.equal(calls.length, 0);
    assert.match(sentMessage, /متاح لأدمن البوت فقط/);
  } finally {
    pointStore.createProduct = originalCreateProduct;
    adminAuth.isAdmin = originalIsAdmin;
    msg.sendGroup = originalSendGroup;
  }
});

test("players can buy an item using the standalone purchase command", async () => {
  const originalPurchase = pointStore.purchase;
  const originalSendPrivate = msg.sendPrivate;
  let purchaseCall;
  let sentMessage;
  pointStore.purchase = async (...args) => {
    purchaseCall = args;
    return {
      product: { name: "لقب المحقق", price: 20 },
      balance: 4,
    };
  };
  msg.sendPrivate = async (_userId, text) => {
    sentMessage = text;
    return true;
  };

  try {
    await gameManager.handleMessage({
      text: "شراء 12",
      isGroup: false,
      threadId: "store-private",
      userId: "player",
    });
    assert.deepEqual(purchaseCall, ["player", "12"]);
    assert.match(sentMessage, /لقب المحقق مقابل 20 نقطة/);
    assert.match(sentMessage, /رصيدك المتبقي: 4/);
  } finally {
    pointStore.purchase = originalPurchase;
    msg.sendPrivate = originalSendPrivate;
  }
});

test("the products command displays every available store product", async () => {
  const originalListProducts = pointStore.listProducts;
  const originalPlayerPoints = leaderboard.playerPoints;
  const originalSendPrivate = msg.sendPrivate;
  let sentMessage;
  pointStore.listProducts = async () => [
    { id: 1, name: "لقب المحقق", description: "لقب خاص", item_type: "cosmetic", price: 20 },
    { id: 2, name: "ميزة إضافية", description: "", item_type: "perk", price: 50 },
  ];
  leaderboard.playerPoints = async () => 70;
  msg.sendPrivate = async (_userId, text) => {
    sentMessage = text;
    return true;
  };

  try {
    await gameManager.handleMessage({
      text: "المنتجات",
      isGroup: false,
      threadId: "store-private",
      userId: "player",
    });
    assert.match(sentMessage, /1\. لقب المحقق \(لقب\/مظهر\) — 20 نقطة — لقب خاص/);
    assert.match(sentMessage, /2\. ميزة إضافية \(ميزة\) — 50 نقطة/);
    assert.match(sentMessage, /رصيدك: 70 نقطة/);
  } finally {
    pointStore.listProducts = originalListProducts;
    leaderboard.playerPoints = originalPlayerPoints;
    msg.sendPrivate = originalSendPrivate;
  }
});

test("only the owner can disable and re-enable a game by its Arabic name", async () => {
  const originalSetEnabled = gameAvailability.setEnabled;
  const originalSendPrivate = msg.sendPrivate;
  const calls = [];
  let sentMessage;
  gameAvailability.setEnabled = async (...args) => {
    calls.push(args);
  };
  msg.sendPrivate = async (_userId, text) => {
    sentMessage = text;
    return true;
  };
  try {
    await gameManager.handleMessage({
      text: "/تعطيل لعبة الرسم",
      isGroup: false,
      threadId: "owner-private",
      userId: "61555344774852",
    });
    assert.deepEqual(calls[0], ["drawing", false, "61555344774852"]);
    assert.match(sentMessage, /المباريات النشطة ستكمل حتى تنتهي/);

    await gameManager.handleMessage({
      text: "/تفعيل لعبة الرسم",
      isGroup: false,
      threadId: "owner-private",
      userId: "61555344774852",
    });
    assert.deepEqual(calls[1], ["drawing", true, "61555344774852"]);
    assert.match(sentMessage, /تم تشغيل لعبة الرسم/);

    calls.length = 0;
    await gameManager.handleMessage({
      text: "/تعطيل لعبة الرسم",
      isGroup: false,
      threadId: "admin-private",
      userId: "999999",
    });
    assert.equal(calls.length, 0);
    assert.match(sentMessage, /متاحة لمالك البوت فقط/);
  } finally {
    gameAvailability.setEnabled = originalSetEnabled;
    msg.sendPrivate = originalSendPrivate;
  }
});

test("a disabled game rejects new starts but lets its active match continue", async () => {
  const originalOne = db.one;
  const originalIsEnabled = gameAvailability.isEnabled;
  const originalSendGroup = msg.sendGroup;
  const spy = games.find((game) => game.id === "spy");
  const originalSpyHandler = spy.engine.handleMessage;
  let sentMessage;
  let handled = false;
  gameAvailability.isEnabled = async (gameId) => gameId !== "spy";
  msg.sendGroup = async (_threadId, text) => {
    sentMessage = text;
    return true;
  };
  try {
    db.one = async () => null;
    await gameManager.handleMessage({
      text: "/جاسوس",
      isGroup: true,
      threadId: "new-game-thread",
      userId: "player",
    });
    assert.match(sentMessage, /متوقفة حالياً/);

    db.one = async () => ({ game_id: "spy" });
    spy.engine.handleMessage = async () => {
      handled = true;
      return true;
    };
    await gameManager.handleMessage({
      text: "وصف الجولة",
      isGroup: true,
      threadId: "active-game-thread",
      userId: "player",
    });
    assert.equal(handled, true);

    handled = false;
    await gameManager.handleMessage({
      text: "اختيار سري",
      isGroup: false,
      threadId: "active-game-thread",
      userId: "player",
    });
    assert.equal(handled, true);
  } finally {
    db.one = originalOne;
    gameAvailability.isEnabled = originalIsEnabled;
    msg.sendGroup = originalSendGroup;
    spy.engine.handleMessage = originalSpyHandler;
  }
});
