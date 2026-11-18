// services/inAppChat.js - غرفة الشات الداخلية، إدارة الحسابات والرموز، المحادثات الخاصة والأمان
const crypto = require("crypto");
const adminAuth = require("./adminAuth");
const db = require("../database");

let messageCounter = 1;
const publicMessages = [];
const MAX_HISTORY = 200;
const messageListeners = [];

function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password).trim() + "_nexca_salt_2026").digest("hex");
}

// إضافة رسالة في الشات العام
function addMessage({ senderId, senderName, text, isBot = false, role = "player" }) {
  const msgObj = {
    id: messageCounter++,
    senderId: String(senderId || (isBot ? "bot" : "user")),
    senderName: String(senderName || (isBot ? "ستورم بوت ⚡" : "لاعب")),
    text: String(text || ""),
    isBot: Boolean(isBot),
    role: String(role),
    time: new Date().toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    timestamp: Date.now(),
  };

  publicMessages.push(msgObj);
  if (publicMessages.length > MAX_HISTORY) {
    publicMessages.shift();
  }

  for (const listener of messageListeners) {
    try {
      listener(msgObj);
    } catch (_) {}
  }
  return msgObj;
}

function getMessagesSince(sinceId = 0) {
  const num = Number(sinceId) || 0;
  return publicMessages.filter((m) => m.id > num);
}

// توليد رمز تحقق عشوائي من 6 أرقام وحفظه بالـ DB
async function generateVerificationCode(userId) {
  const cleanId = String(userId).trim();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = Date.now() + 15 * 60 * 1000; // 15 دقيقة

  try {
    await db.query(
      `INSERT INTO app_verification_codes (psid, code, expires_at)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE code = VALUES(code), expires_at = VALUES(expires_at), created_at = CURRENT_TIMESTAMP`,
      [cleanId, code, expiresAt]
    );
  } catch (err) {
    console.error("[inAppChat] generateVerificationCode error:", err.message);
  }
  return code;
}

// تسجيل حساب جديد بالمعرف والرمز وكلمة السر والاسم
async function registerAccount({ userId, code, password, displayName = "", avatarUrl = "", theme = "dark" }) {
  const cleanId = String(userId || "").trim();
  const cleanCode = String(code || "").trim();
  const cleanPass = String(password || "").trim();
  const cleanName = String(displayName || "").trim().slice(0, 50);

  if (!cleanId || !/^\d{1,64}$/.test(cleanId)) {
    return { ok: false, error: "معرّف فيسبوك غير صالح. يجب أن يتكون من أرقام فقط." };
  }
  if (!cleanName || cleanName.length < 2) {
    return { ok: false, error: "يرجى كتابة اسمك الذي سيظهر في البوت والألعاب (حرفين فأكثر)." };
  }
  if (!cleanCode || cleanCode.length < 4) {
    return { ok: false, error: "يرجى إدخال رمز التحقق المستلم من البوت." };
  }
  if (!cleanPass || cleanPass.length < 4) {
    return { ok: false, error: "كلمة السر يجب أن تكون 4 أحرف/أرقام على الأقل." };
  }

  // التحقق من الرمز
  try {
    const codeRow = await db.one(
      "SELECT code, expires_at FROM app_verification_codes WHERE psid = ? LIMIT 1",
      [cleanId]
    );

    const isOwner = adminAuth.isOwner(cleanId);
    // المالك يمكنه التسجيل دائماً بدون قيود
    if (!isOwner) {
      const isQuickCode = cleanCode === "123456" || cleanCode === "000000";
      const isValidDbCode = codeRow && String(codeRow.code) === cleanCode && Number(codeRow.expires_at) >= Date.now();
      if (!isQuickCode && !isValidDbCode) {
        if (codeRow && Number(codeRow.expires_at) < Date.now()) {
          return { ok: false, error: "انتهت صلاحية الرمز. يمكنك استخدام الرمز السريع 123456 أو طلب كود جديد من التطبيق." };
        }
        return { ok: false, error: "رمز التحقق غير صحيح. يمكنك استخدام الرمز السريع 123456 أو طلب كود جديد من التطبيق." };
      }
    }

    const passHash = hashPassword(cleanPass);
    const finalName = isOwner ? (adminAuth.ownerName || cleanName) : cleanName;

    // 1. الحفظ في جدول حسابات التطبيق
    await db.query(
      `INSERT INTO app_user_accounts (psid, password_hash, display_name, avatar_url, theme)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         password_hash = VALUES(password_hash),
         display_name = VALUES(display_name),
         avatar_url = VALUES(avatar_url),
         theme = VALUES(theme)`,
      [cleanId, passHash, finalName, avatarUrl || null, theme || "dark"]
    );

    // 2. الحفظ في جدول نقاط وأسماء البوت (المصدر الأساسي لكل الألعاب والردود)
    await db.query(
      `INSERT INTO bot_player_scores (psid, display_name, points)
       VALUES (?, ?, 0)
       ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)`,
      [cleanId, finalName]
    );

    // 3. التحديث في نظام الردود البشرية والكاش
    try {
      const humanReplies = require("./humanReplies");
      humanReplies.registerPlayer(cleanId, finalName);
    } catch (_) {}

    try {
      const messenger = require("./messenger");
      if (typeof messenger.setCachedUserName === "function") {
        messenger.setCachedUserName(cleanId, finalName);
      }
    } catch (_) {}

    // حذف الرمز بعد استخدامه بنجاح
    await db.query("DELETE FROM app_verification_codes WHERE psid = ?", [cleanId]);

    return authenticateUser(cleanId);
  } catch (err) {
    console.error("[inAppChat] registerAccount error:", err.message);
    return { ok: false, error: "حدث خطأ أثناء التسجيل: " + err.message };
  }
}

// تسجيل الدخول بكلمة السر أو بالرمز المباشر
async function loginUser({ userId, password, code }) {
  const cleanId = String(userId || "").trim();
  if (!cleanId) return { ok: false, error: "يرجى إدخال معرّف الفيسبوك." };

  const isOwner = adminAuth.isOwner(cleanId);

  try {
    // 1. الدخول عبر كلمة السر إن أُرسلت
    if (password) {
      const userRow = await db.one(
        "SELECT psid, password_hash FROM app_user_accounts WHERE psid = ? LIMIT 1",
        [cleanId]
      );
      if (!userRow) {
        return { ok: false, error: "هذا الحساب غير مسجل بعد. اضغط على 'إنشاء حساب جديد' واستخدم رمز البوت." };
      }
      if (userRow.password_hash !== hashPassword(password)) {
        return { ok: false, error: "كلمة السر غير صحيحة." };
      }
      return authenticateUser(cleanId);
    }

    // 2. الدخول عبر رمز التحقق المباشر
    if (code) {
      const codeRow = await db.one(
        "SELECT code, expires_at FROM app_verification_codes WHERE psid = ? LIMIT 1",
        [cleanId]
      );
      if (!isOwner) {
        if (!codeRow || String(codeRow.code) !== String(code).trim()) {
          return { ok: false, error: "رمز التحقق غير صحيح." };
        }
        if (Number(codeRow.expires_at) < Date.now()) {
          return { ok: false, error: "انتهت صلاحية الرمز. أرسل /كود للبوت مجدداً." };
        }
      }
      return authenticateUser(cleanId);
    }

    return { ok: false, error: "يرجى إدخال كلمة السر أو رمز التحقق." };
  } catch (err) {
    console.error("[inAppChat] loginUser error:", err.message);
    return { ok: false, error: "خطأ في تسجيل الدخول: " + err.message };
  }
}

// التحقق من الصلاحيات والملف الشخصي
async function authenticateUser(userId) {
  const cleanId = String(userId || "").trim();
  if (!cleanId || !/^\d{1,64}$/.test(cleanId)) {
    return { ok: false, error: "معرّف فيسبوك غير صالح." };
  }

  const isOwner = adminAuth.isOwner(cleanId);
  const isAdmin = adminAuth.isAdmin(cleanId);
  let role = isOwner ? "owner" : (isAdmin ? "admin" : "player");
  let name = isOwner ? (adminAuth.ownerName || "لايت (المالك) 👑") : (isAdmin ? "أدمن البوت 🛡️" : `لاعب_${cleanId.slice(-4)}`);
  let points = 0;
  let title = "";
  let theme = "dark";
  let avatarUrl = "";

  try {
    // بيانات الحساب من app_user_accounts
    const accRow = await db.one("SELECT display_name, avatar_url, theme FROM app_user_accounts WHERE psid = ? LIMIT 1", [cleanId]);
    if (accRow) {
      if (accRow.display_name && !isOwner) name = accRow.display_name;
      if (accRow.theme) theme = accRow.theme;
      if (accRow.avatar_url) avatarUrl = accRow.avatar_url;
    }

    // النقاط
    const scoreRow = await db.one("SELECT display_name, points FROM bot_player_scores WHERE psid = ? LIMIT 1", [cleanId]);
    if (scoreRow) {
      if (!isOwner && !accRow?.display_name) name = scoreRow.display_name;
      points = Number(scoreRow.points) || 0;
    }

    // اللقب
    const titleRow = await db.one(
      `SELECT p.name FROM bot_shop_inventory i
       JOIN bot_shop_products p ON i.product_id = p.id
       WHERE i.psid = ? AND i.equipped = 1 LIMIT 1`,
      [cleanId]
    );
    if (titleRow) title = titleRow.name;
  } catch (err) {
    console.warn("[inAppChat] DB lookup warning:", err.message);
  }

  return {
    ok: true,
    user: {
      userId: cleanId,
      name,
      role,
      isOwner,
      isAdmin,
      points,
      title,
      theme,
      avatarUrl,
      permissions: isOwner
        ? ["all", "dashboard", "manage_games", "chat", "admin_commands", "private_chat", "screenshot_alerts"]
        : isAdmin
          ? ["manage_games", "chat", "admin_commands", "private_chat", "screenshot_alerts"]
          : ["chat", "play", "private_chat"],
    },
  };
}

// تحديث الملف الشخصي والثيم
async function updateProfile({ userId, theme, avatarUrl, displayName }) {
  const cleanId = String(userId || "").trim();
  try {
    await db.query(
      `UPDATE app_user_accounts
       SET theme = COALESCE(?, theme),
           avatar_url = COALESCE(?, avatar_url),
           display_name = COALESCE(?, display_name)
       WHERE psid = ?`,
      [theme || null, avatarUrl || null, displayName || null, cleanId]
    );
    return authenticateUser(cleanId);
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// استلام رسالة شات وتوجيهها للمحرك
async function handleIncomingAppMessage({ userId, text }) {
  const auth = await authenticateUser(userId);
  if (!auth.ok) throw new Error(auth.error);

  const user = auth.user;
  const cleanText = String(text || "").trim();
  if (!cleanText) return null;

  addMessage({
    senderId: user.userId,
    senderName: user.name,
    text: cleanText,
    isBot: false,
    role: user.role,
  });

  const gameManager = require("./gameManager");
  const context = {
    platform: "in_app",
    userId: user.userId,
    threadId: "app_lobby",
    messageId: `app_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    isGroup: true,
    text: cleanText,
    getUserName: () => user.name,
  };

  try {
    await gameManager.handleMessage(context);
  } catch (err) {
    console.error("[inAppChat] gameManager execution failed:", err.message);
    addMessage({
      senderId: "bot",
      senderName: "ستورم بوت ⚡",
      text: `⚠️ خطأ: ${err.message}`,
      isBot: true,
      role: "bot",
    });
  }

  return { ok: true };
}

// بث رسالة من البوت إلى الشات
function broadcastBotMessage(text, target) {
  addMessage({
    senderId: "bot",
    senderName: "ستورم بوت ⚡",
    text: String(text || ""),
    isBot: true,
    role: "bot",
  });
}

// تسجيل تنبيه لقطة شاشة وإرسال إشعار للأدمن
async function recordScreenshotAlert({ userId, userName, screenName = "التطبيق" }) {
  const cleanId = String(userId || "مجهول").trim();
  const name = String(userName || cleanId);
  const timeStr = new Date().toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  try {
    await db.query(
      `INSERT INTO app_security_alerts (user_id, user_name, event_type, details)
       VALUES (?, ?, 'screenshot', ?)`,
      [cleanId, name, screenName]
    );

    // إرسال تنبيه أمني في الشات العام ليشاهده الأدمن
    addMessage({
      senderId: "security",
      senderName: "🚨 الأمان والمراقبة",
      text: `⚠️ تنبيه أمني: قام العضو (${name} - ID: ${cleanId}) بأخذ لقطة شاشة (Screenshot) داخل [${screenName}] في تمام الساعة ${timeStr}!`,
      isBot: true,
      role: "admin",
    });

    // إرسال تنبيه في ماسنجر المالك
    try {
      const botNotify = require("./botNotify");
      await botNotify.alert(
        "🚨 التقاط لقطة شاشة في التطبيق",
        `المستخدم: ${name}\nالمعرّف: ${cleanId}\nالشاشة: ${screenName}\nالوقت: ${timeStr}`,
        "warning"
      );
    } catch (_) {}

    return { ok: true };
  } catch (err) {
    console.error("[inAppChat] recordScreenshotAlert error:", err.message);
    return { ok: false, error: err.message };
  }
}

// ---------------------- المحادثات الخاصة (1-on-1) ----------------------
async function sendPrivateMessage({ senderId, recipientId, text }) {
  const sId = String(senderId).trim();
  const rId = String(recipientId).trim();
  const cleanText = String(text || "").trim();
  if (!cleanText) return { ok: false, error: "الرسالة فارغة." };

  const senderAuth = await authenticateUser(sId);
  const sName = senderAuth.ok ? senderAuth.user.name : sId;

  try {
    const res = await db.query(
      `INSERT INTO app_private_messages (sender_id, recipient_id, sender_name, text)
       VALUES (?, ?, ?, ?)`,
      [sId, rId, sName, cleanText]
    );

    // لو كانت الرسالة الخاصة موجهة للبوت (خاص البوت)
    if (rId === "bot" || rId === "0") {
      const gameManager = require("./gameManager");
      const context = {
        platform: "in_app",
        userId: sId,
        threadId: `app_private_${sId}`,
        messageId: `app_p_${Date.now()}`,
        isGroup: false,
        text: cleanText,
        getUserName: () => sName,
      };
      await gameManager.handleMessage(context);
    }

    return { ok: true, messageId: res.insertId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function getPrivateMessages({ userId, otherUserId, sinceId = 0 }) {
  const u1 = String(userId).trim();
  const u2 = String(otherUserId).trim();
  const since = Number(sinceId) || 0;

  try {
    const rows = await db.query(
      `SELECT id, sender_id, recipient_id, sender_name, text, created_at
       FROM app_private_messages
       WHERE ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
         AND id > ?
       ORDER BY id ASC
       LIMIT 100`,
      [u1, u2, u2, u1, since]
    );

    const formatted = rows.map((r) => ({
      id: r.id,
      senderId: r.sender_id,
      recipientId: r.recipient_id,
      senderName: r.sender_name,
      text: r.text,
      time: new Date(r.created_at).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" }),
      isMe: String(r.sender_id) === u1,
    }));

    return { ok: true, messages: formatted };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  addMessage,
  getMessagesSince,
  generateVerificationCode,
  registerAccount,
  loginUser,
  authenticateUser,
  updateProfile,
  handleIncomingAppMessage,
  broadcastBotMessage,
  recordScreenshotAlert,
  sendPrivateMessage,
  getPrivateMessages,
};
