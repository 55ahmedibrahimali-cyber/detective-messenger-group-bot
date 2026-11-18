"""
وحدة إرسال التنبيهات إلى ماسنجر المالك (فيسبوك) مباشرة
تستخدم نقطة /api/notify المحلية للبوت لإرسال رسائل خاصة إلى المالك
"""

import logging
import requests
from config import LOCAL_NOTIFY_URL, BOT_OWNER_NAME

logger = logging.getLogger("messenger_notify")

def send_messenger_alert(title: str, message: str, level: str = "info") -> bool:
    """إرسال تنبيه إلى ماسنجر المالك مباشرة"""
    payload = {
        "title": title,
        "message": f"يا {BOT_OWNER_NAME}،\n{message}",
        "level": level
    }

    try:
        res = requests.post(LOCAL_NOTIFY_URL, json=payload, timeout=8)
        if res.status_code == 200:
            logger.info(f"✅ تم إرسال التنبيه إلى ماسنجر {BOT_OWNER_NAME} بنجاح.")
            return True
        else:
            logger.error(f"خطأ في إرسال تنبيه الماسنجر: {res.status_code} - {res.text}")
            return False
    except Exception as e:
        logger.warning(f"تعذر إرسال التنبيه إلى الماسنجر (قد يكون البوت متوقفاً): {e}")
        return False
