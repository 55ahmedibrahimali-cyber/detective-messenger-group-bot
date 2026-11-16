// services/phaseReminders.js - تنبيهات الوقت المتبقي لكل الألعاب (يعمل بجانب مؤقّت كل لعبة دون تعديل منطقها)
// يرسل تنبيهاً واحداً عند كل عتبة (مثلاً 30 ثانية و10 ثوانٍ) لكل مرحلة، ويتجاهل العتبات المتجاوزة
// (مثلاً بعد إعادة تشغيل البوت) حتى لا يرسل رسائل متأخرة أو متكررة.
const db = require("../database");
const msg = require("./messenger");

const TICK_MS = 3000;
const TOLERANCE_S = 8; // لا نرسل إلا إذا عبرنا العتبة للتو
const sent = new Set();
let timer = null;
let running = false;

async function lobbyText(_room, remaining) {
  return `باقي ${remaining} ثانية`;
}

async function spyVotingText(room, remaining) {
  const missing = await db.query(
    `SELECT sp.display_name FROM spy_players sp
     WHERE sp.room_id=? AND sp.is_out=0 AND NOT EXISTS (
       SELECT 1 FROM spy_votes sv WHERE sv.room_id=sp.room_id AND sv.voter_player_id=sp.id)
     ORDER BY sp.id`,
    [room.id],
  );
  if (!missing.length) return null;
  return `التصويت: ${remaining}ث | لم يصوّت: ${missing.map((row) => row.display_name).join("، ")}`;
}

const RULES = {
  "*": {
    lobby: { thresholds: [30, 10], text: lobbyText },
  },
  crime: {
    discussion: {
      thresholds: [30, 10],
      text: async (room, s) => `النقاش: ${s}ث`,
    },
    voting: {
      thresholds: [20, 8],
      text: async (room, s) => `التصويت: ${s}ث`,
    },
    final_voting: {
      thresholds: [20, 8],
      text: async (room, s) => `التصويت النهائي: ${s}ث`,
    },
  },
  storm: {
    night: {
      thresholds: [15],
      text: async (room, s) => `الليل ينتهي خلال ${s}ث`,
    },
    discussion: {
      thresholds: [30, 10],
      text: async (room, s) => `النقاش: ${s}ث`,
    },
    voting: {
      thresholds: [20, 8],
      text: async (room, s) => `التصويت: ${s}ث`,
    },
  },
  spy: {
    discussion: {
      thresholds: [30, 10],
      text: async (room, s) => `النقاش: ${s}ث`,
    },
    voting: { thresholds: [20, 8], text: spyVotingText },
    spy_guess: {
      thresholds: [15],
      text: async (room, s) => `مهلة تخمين الجاسوس: ${s}ث`,
    },
  },
  werewolf: {
    night: {
      thresholds: [15],
      text: async (room, s) => `الليل ينتهي خلال ${s}ث`,
    },
    discussion: {
      thresholds: [30, 10],
      text: async (room, s) => `النقاش: ${s}ث`,
    },
    voting: {
      thresholds: [20, 8],
      text: async (room, s) => `التصويت: ${s}ث`,
    },
    hunter: {
      thresholds: [15],
      text: async (room, s) => `مهلة اختيار الصياد: ${s}ث`,
    },
  },
};

const MAX_REMINDER_THRESHOLD_S = Math.max(
  ...Object.values(RULES).flatMap((phases) =>
    Object.values(phases).flatMap((rule) => rule.thresholds),
  ),
);

function ruleFor(room) {
  return RULES[room.game_id]?.[room.phase] || RULES["*"][room.phase] || null;
}

async function check() {
  const rooms = await db.query(
    `SELECT id, game_id, thread_id, phase, current_round,
            TIMESTAMPDIFF(SECOND, NOW(), phase_ends_at) AS remaining
     FROM game_rooms
     WHERE status IN ('lobby','playing')
       AND phase_ends_at IS NOT NULL
       AND phase_ends_at > NOW()
       AND phase_ends_at <= DATE_ADD(NOW(), INTERVAL ? SECOND)`,
    [MAX_REMINDER_THRESHOLD_S],
  );
  for (const room of rooms) {
    const rule = ruleFor(room);
    if (!rule) continue;
    const remaining = Number(room.remaining);
    const thresholds = [...rule.thresholds].sort((a, b) => a - b);
    const crossed = thresholds.find((t) => remaining <= t);
    if (crossed === undefined) continue;

    const prefix = `${room.id}:${room.phase}:${room.current_round || 0}`;
    const key = `${prefix}:${crossed}`;
    const alreadyHandled = sent.has(key);
    // نعلّم هذه العتبة وكل العتبات الأكبر منها كمعالجة (لا نرسل رسائل قديمة لاحقاً)
    for (const t of thresholds) if (t >= crossed) sent.add(`${prefix}:${t}`);
    if (alreadyHandled || remaining < 3 || remaining < crossed - TOLERANCE_S) continue;

    try {
      const text = await rule.text(room, remaining);
      if (text) await msg.sendGroup(room.thread_id, text);
    } catch (error) {
      console.error(`[reminders] room ${room.id}:`, error.message);
    }
  }
  if (sent.size > 3000) {
    // نحذف أقدم نصف المفاتيح بدل مسح الكل حتى لا تتكرر التنبيهات
    const keys = [...sent];
    for (const key of keys.slice(0, 1500)) sent.delete(key);
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    check()
      .catch((error) => console.error("[reminders] check failed:", error.message))
      .finally(() => {
        running = false;
      });
  }, TICK_MS);
  timer.unref?.();
}

module.exports = { start, check, _sent: sent };
