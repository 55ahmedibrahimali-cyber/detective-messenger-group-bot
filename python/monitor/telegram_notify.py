"""
وحدة إرسال التنبيهات عبر تيليجرام — ترسل مباشرة لحساب المالك الشخصي
وليس لأي مجموعة، لضمان وصول التنبيهات بشكل خاص وسريع
"""

import logging
import requests
from config import TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_CHAT_ID, BOT_OWNER_NAME

logger = logging.getLogger("telegram_notify")

EMOJI_MAP = {
    "info":     "ℹ️",
    "warning":  "⚠️",
    "critical": "🚨",
    "success":  "✅",
    "debug":    "🔧",
}


def send_to_owner(text: str, parse_mode: str = "HTML") -> bool:
    """
    إرسال رسالة مباشرة لحساب المالك الشخصي (لا لمجموعة)
    """
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_OWNER_CHAT_ID:
        logger.warning(
            "⚠️ لم يتم تحديد TELEGRAM_BOT_TOKEN أو TELEGRAM_OWNER_CHAT_ID في متغيرات البيئة.\n"
            "أضفهما في ملف .env أو في متغيرات النظام."
        )
        return False

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_OWNER_CHAT_ID,   # حساب المالك الشخصي فقط
        "text": text,
        "parse_mode": parse_mode,
        "disable_web_page_preview": True,
        "disable_notification": False,        # صوت + إشعار دائماً
    }

    try:
        res = requests.post(url, json=payload, timeout=10)
        if res.status_code == 200:
            logger.info(f"✉️ تم إرسال التنبيه إلى {BOT_OWNER_NAME} بنجاح.")
            return True
        else:
            logger.error(f"خطأ من تيليجرام: {res.status_code} — {res.text}")
            return False
    except requests.exceptions.Timeout:
        logger.error("انتهت مهلة الاتصال بتيليجرام (timeout).")
        return False
    except Exception as e:
        logger.error(f"استثناء غير متوقع أثناء الإرسال: {e}")
        return False


def send_alert(title: str, message: str, level: str = "info") -> bool:
    """
    إرسال تنبيه منسق بـ emoji مباشرة لحساب المالك
    """
    icon = EMOJI_MAP.get(level.lower(), "📢")
    formatted = (
        f"<b>{icon} {title}</b>\n"
        f"{'─' * 30}\n"
        f"{message}"
    )
    return send_to_owner(formatted)
