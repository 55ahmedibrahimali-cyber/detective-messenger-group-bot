/**
 * services/botNotify.js
 * 
 * وحدة تنبيهات المالك عبر الماسنجر مباشرة (بدلاً من تيليجرام)
 * ترسل رسائل خاصة لحساب المالك على الفيسبوك عند توقف البوت أو أي حدث مهم
 * 
 * الاستخدام:
 *   const notify = require('./botNotify');
 *   notify.send('البوت وقع!');
 *   notify.alert('تحذير', 'السبب هنا', 'critical');
 */

const adminAuth = require('./adminAuth');

// تأجيل تحميل messenger لتجنب circular dependency عند الـ startup
function getMsg() {
  return require('./messenger');
}

const EMOJI = {
  info:     'ℹ️',
  warning:  '⚠️',
  critical: '🚨',
  success:  '✅',
  debug:    '🔧',
};

/**
 * إرسال رسالة نصية مباشرة لحساب المالك في الماسنجر
 * @param {string} text - نص الرسالة
 * @param {'info'|'warning'|'critical'|'success'} level
 */
async function send(text, level = 'info') {
  try {
    const ownerId = adminAuth.ownerId;
    if (!ownerId) {
      console.warn('[botNotify] ownerId غير محدد، لا يمكن إرسال التنبيه.');
      return;
    }
    const msg = getMsg();
    if (typeof msg.sendPrivate !== 'function') {
      console.warn('[botNotify] sendPrivate غير متاح بعد.');
      return;
    }
    const icon = EMOJI[level] || '📢';
    await msg.sendPrivate(ownerId, `${icon} ${text}`);
  } catch (err) {
    // نتجاهل أخطاء الإرسال لتجنب حلقات الخطأ اللانهائية
    console.error('[botNotify] خطأ في إرسال التنبيه:', err?.message);
  }
}

/**
 * إرسال تنبيه منسق بعنوان وتفاصيل
 * @param {string} title   - عنوان التنبيه
 * @param {string} body    - تفاصيل التنبيه
 * @param {'info'|'warning'|'critical'|'success'} level
 */
async function alert(title, body, level = 'info') {
  const icon = EMOJI[level] || '📢';
  const line = '─'.repeat(28);
  await send(`${icon} ${title}\n${line}\n${body}`, level);
}

module.exports = { send, alert };
