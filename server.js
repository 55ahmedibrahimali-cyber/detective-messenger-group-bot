// server.js - نقطة التشغيل: تسجيل الدخول عبر FCA ثم توجيه أحداث Messenger لمدير الألعاب
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
// يجب أن يكون أول شيء بعد dotenv: يخفي كلمات المرور والكوكيز والمفاتيح من كل السجلات
require('./services/logRedactor').install();
process.env.BOT_PLATFORM = 'messenger';
require('./services/configLoader').loadConfig();
require('./services/securityCheck').run();

const crimeAI = require('./games/crime/aiProvider');
if (!crimeAI.getConfig().apiKey) {
  console.warn(`[crime] ${crimeAI.getConfig().setupMessage}`);
}
const gameManager = require('./services/gameManager');
const adminAuth = require('./services/adminAuth');
const messenger = require('./services/messenger');
const safety = require('./services/safety');
const aiChat = require('./services/aiChat');
const designAssistant = require('./services/designAssistant');
const imageToVideo = require('./services/imageToVideo');
const imageToVideoDeps = imageToVideo.createDeps(messenger);
const funCommands = require('./services/funCommands');
const funCommandsDeps = funCommands.createDeps(messenger);
const animeEdit = require('./services/animeEditFal');
const animeEditDeps = animeEdit.createDeps(messenger);
const pinterest = require('./services/pinterest');
const deviantArt = require('./services/deviantArt');
const spyImageServer = require('./services/spyImageServer');
const welcome = require('./services/welcome');
const db = require('./database');
const { createKeyedQueue } = require('./services/keyedQueue');
const { createSlidingWindowRateLimiter } = require('./services/rateLimiter');
const { createIncomingCommandCooldown } = require('./services/commandCooldown');

// ----------------------------- حدود الأمان -----------------------------
const MAX_TEXT_LENGTH = Number(process.env.MAX_INCOMING_TEXT) || 1000;
const RATE_LIMIT_COUNT = Number(process.env.USER_RATE_LIMIT_COUNT) || 20; // رسائل
const RATE_LIMIT_WINDOW_MS = (Number(process.env.USER_RATE_LIMIT_SECONDS) || 10) * 1000;
const MAX_PENDING_EVENTS_PER_KEY = Math.max(
  1,
  Math.trunc(Number(process.env.MAX_PENDING_EVENTS_PER_KEY) || 200),
);
// اختياري: لا يعمل البوت إلا في هذه المجموعات (معرّفات مفصولة بفواصل). فارغ = كل المجموعات.
const ALLOWED_THREADS = new Set(
  (process.env.ALLOWED_THREAD_IDS || '').split(',').map((v) => v.trim()).filter(Boolean),
);

const rateLimited = createSlidingWindowRateLimiter(
  RATE_LIMIT_COUNT,
  RATE_LIMIT_WINDOW_MS,
);
const commandCoolingDown = createIncomingCommandCooldown({
  cooldownMs: 10_000,
  isCommand: (text) =>
    /^\s*[/.!]/.test(String(text || '')) ||
    gameManager.isRecognizedCommand(text) ||
    Boolean(pinterest.parseCommand(text)) ||
    Boolean(deviantArt.parseCommand(text)) ||
    imageToVideo.isCommand(text) ||
    Boolean(funCommands.parseCommand(text)) ||
    animeEdit.isCommand(text) ||
    designAssistant.isCommand(text) ||
    /^\s*[/!]?\s*(?:جودة|quality|رفع_الجودة)(?:\s|$)/i.test(
      String(text || ''),
    ),
  isExempt: (text) => gameManager.isBotControlCommand(text),
});

// طابور محدود لكل مجموعة / مستخدم خاص لتفادي تراكم الذاكرة عند بطء المعالجة.
const enqueue = createKeyedQueue({
  maxPending: MAX_PENDING_EVENTS_PER_KEY,
  onOverflow: (key, pending) =>
    console.warn(`[event queue] ${key} reached ${pending} pending events; dropping new event`),
});

// منع معالجة نفس الرسالة مرتين (MQTT قد يعيد التسليم بعد إعادة الاتصال)
const seen = new Set();
function isDuplicate(id) {
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 5000) seen.delete(seen.values().next().value);
  return false;
}

function threadAllowed(threadId, isGroup) {
  return !isGroup || ALLOWED_THREADS.size === 0 || ALLOWED_THREADS.has(String(threadId));
}

function onEvent(ev) {
  if (ev.type === 'message_reaction') {
    if (gameManager.isBotPaused()) return;
    const userId = ev.senderID || ev.userID;
    if (!userId || userId === messenger.selfId() || !ev.threadID || !ev.messageID) return;
    if (!threadAllowed(ev.threadID, true)) return;
    if (!gameManager.noteActivity()) return;
    const key = `g:${ev.threadID}`;
    enqueue(key, () => gameManager.handleReaction({
      userId: String(userId),
      threadId: String(ev.threadID),
      messageId: String(ev.messageID),
    }));
    return;
  }
  const joinNotice = welcome.messengerMemberAdded(ev, messenger.selfId());
  if (joinNotice) {
    if (gameManager.isBotPaused()) return;
    if (!threadAllowed(joinNotice.threadId, true)) return;
    if (isDuplicate(ev.messageID)) return;
    if (!gameManager.noteActivity()) return;
    enqueue(`g:${joinNotice.threadId}`, () =>
      messenger.sendGroup(joinNotice.threadId, joinNotice.text),
    );
    return;
  }
  if (ev.type !== 'message' && ev.type !== 'message_reply') return;
  let text = (ev.body || '').trim();
  if (!text || !ev.senderID || ev.senderID === messenger.selfId()) return;
  if (isDuplicate(ev.messageID)) return;

  const isGroup = !!ev.isGroup;
  if (!threadAllowed(ev.threadID, isGroup)) return;
  if (text.length > MAX_TEXT_LENGTH) text = text.slice(0, MAX_TEXT_LENGTH);
  if (!isGroup) {
    // الخاص: نسجّل إن اللاعب بدأ المحادثة (شرط إرسال الخاص له) ونحترم طلب الإيقاف
    const uid = String(ev.senderID);
    safety.noteContact(uid);
    if (safety.isStopCommand(text)) {
      messenger
        .sendPrivate(uid, 'تم إيقاف الرسائل الخاصة عنك. اكتب "ابدأ" لتفعيلها مرة أخرى.')
        .finally(() => safety.setOptOut(uid, true));
      return;
    }
    if (safety.isOptOut(uid)) {
      if (safety.isStartCommand(text)) {
        safety.setOptOut(uid, false);
        messenger.sendPrivate(uid, 'تم تفعيل الرسائل الخاصة ✅');
      }
      return;
    }
  }
  const rateLimitKey = isGroup
    ? `g:${ev.threadID}:${ev.senderID}`
    : `u:${ev.senderID}`;
  if (rateLimited(rateLimitKey)) {
    console.warn(`[security] rate limit: ignoring message from ${ev.senderID}`);
    return;
  }
  const active = gameManager.noteActivity();
  if (!active && !gameManager.isBotControlCommand(text)) return;

  const key = isGroup ? `g:${ev.threadID}` : `u:${ev.senderID}`;
  enqueue(key, async () => {
    const context = {
      platform: 'messenger',
      userId: String(ev.senderID),
      threadId: String(ev.threadID),
      messageId: String(ev.messageID || ''),
      isGroup,
      text,
      messageReply: ev.messageReply || null,
      attachments: Array.isArray(ev.attachments) ? ev.attachments : [],
    };
    if (commandCoolingDown(context)) {
      console.warn(
        `[security] command cooldown: ignoring command from ${context.userId}`,
      );
      try {
        await messenger.reactToMessage(
          context.threadId,
          context.messageId,
          "❌",
        );
      } catch (error) {
        console.warn(
          "[security] failed to mark rate-limited command:",
          redact(error.message || error),
        );
      }
      return;
    }
    if (
      gameManager.isBotPaused() ||
      gameManager.isBotControlCommand(context.text)
    )
      return gameManager.handleMessage(context);
    const pinterestHandled = await pinterest.tryHandle(
      context,
      pinterest.createDeps(messenger),
    );
    if (pinterestHandled) return;
    const deviantArtHandled = await deviantArt.tryHandle(
      context,
      deviantArt.createDeps(messenger),
    );
    if (deviantArtHandled) return;
    const imageToVideoHandled = await imageToVideo.tryHandle(
      context,
      imageToVideoDeps,
    );
    if (imageToVideoHandled) return;
    const funCommandsHandled = await funCommands.tryHandle(
      context,
      funCommandsDeps,
    );
    if (funCommandsHandled) return;
    const animeEditHandled = await animeEdit.tryHandle(context, animeEditDeps);
    if (animeEditHandled) return;
    const designHandled = await designAssistant.tryHandle(context, {
      sendText: (threadId, body, group) =>
        group
          ? messenger.sendGroup(threadId, body)
          : messenger.sendPrivate(threadId, body),
      sendImage: async (threadId, buffer, contentType, caption, group) => {
        if (group)
          return Boolean(
            await messenger.sendGroupImageBufferTracked(
              threadId,
              buffer,
              contentType,
              caption,
            ),
          );
        const result = await messenger.sendPrivateImageBufferWithResult(
          threadId,
          buffer,
          contentType,
          caption,
        );
        return Boolean(result?.ok);
      },
    });
    if (designHandled) return;
    const handled = await aiChat.tryHandle(
      context,
      {
        send: (threadId, body, group) =>
          group
            ? messenger.sendGroup(threadId, body)
            : messenger.sendPrivate(threadId, body),
        selfId: () => messenger.selfId(),
        hasActiveGame: (messageContext) =>
          gameManager.hasActiveGame(messageContext),
        isAdmin: (userId) => adminAuth.isAdmin(userId),
      },
    );
    if (handled) return;
    return gameManager.handleMessage(context);
  });
}

(async () => {
  try {
    await db.assertSchema();
    await gameManager.assertSchemas();
    adminAuth.assertConfig();
    const serverStarted = await spyImageServer.start();
    const webPort = serverStarted?.port || process.env.PORT || 3000;
    try {
      await messenger.start(onEvent);
      gameManager.startTickers();
      console.log('🕵️ Detective group bot is running');
      try {
        const botNotify = require('./services/botNotify');
        botNotify.alert(
          'البوت متصل ويعمل الآن 🚀',
          'تم تشغيل بوت المحقق على السيرفر بنجاح ونظام الألعاب نشط ومستعد.',
          'success'
        ).catch(() => {});
      } catch (_) {}
    } catch (messengerErr) {
      console.error('⚠️ تعذّر الاتصال بـ Messenger في الوقت الحالي:', messengerErr.error || messengerErr.message || messengerErr);
      console.log(`🌐 خادم إدارة وتجديد الجلسة يعمل الآن! يمكنك الدخول على http://0.0.0.0:${webPort}/admin/appstate لتجديد الجلسة أو لصق كود appstate.json الجديد.`);
      console.log('سيبقى السيرفر يعمل لتلقي الجلسة المجددة وتشغيل البوت تلقائياً.');
    }
  } catch (e) {
    if (e.code === 'ECONNREFUSED') {
      const host = process.env.DB_HOST || '127.0.0.1';
      const port = Number(process.env.DB_PORT) || 3306;
      console.error(`فشل تشغيل البوت: لا يمكن الاتصال بخادم MySQL على ${host}:${port}.`);
      console.error('تأكد من تثبيت وتشغيل MySQL أو MariaDB، ثم نفّذ npm run db:setup وأنشئ الجداول.');
    } else {
      console.error('فشل تشغيل البوت:', e.error || e.message || e);
    }
    process.exit(1);
  }
})();

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[server] ${signal} received; shutting down`);
    process.exit(0);
  });
}
