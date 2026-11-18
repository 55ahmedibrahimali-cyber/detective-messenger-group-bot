"""
مراقب بوت المحقق — يفحص السيرفر والخدمة ويرسل التنبيهات لماسنجر المالك
يعمل في تناغم تام مع خدمة detective-bot لحماية الحساب ومنع أي أخطاء
"""

import time
import logging
from datetime import datetime
import requests
import paramiko
from config import (
    SSH_HOST, SSH_USER, SSH_KEY_PATH,
    CHECK_INTERVAL_SECONDS, SERVICE_NAME, BOT_OWNER_NAME, HEALTH_URL
)
from messenger_notify import send_messenger_alert

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.FileHandler("monitor.log", encoding="utf-8"),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger("bot_monitor")


class BotMonitor:
    def __init__(self):
        self.last_status = None
        self.consecutive_failures = 0
        self.pending_alert = None

    def _check_local_health(self):
        """فحص حالة الخادم محلياً عبر API"""
        try:
            res = requests.get(HEALTH_URL, timeout=5)
            if res.status_code == 200:
                return True
        except Exception:
            pass
        return False

    def _check_ssh(self):
        client = None
        try:
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            client.connect(
                hostname=SSH_HOST,
                username=SSH_USER,
                key_filename=SSH_KEY_PATH,
                timeout=10,
                banner_timeout=10
            )
            _, stdout, _ = client.exec_command(f"systemctl is-active {SERVICE_NAME}", timeout=10)
            status = stdout.read().decode("utf-8", errors="replace").strip()
            return True, status
        except Exception as e:
            return False, str(e)
        finally:
            if client:
                try:
                    client.close()
                except Exception:
                    pass

    def run(self):
        logger.info(f"🚀 بدء مراقبة البوت على السيرفر {SSH_HOST} كل {CHECK_INTERVAL_SECONDS} ثانية...")

        while True:
            # أولاً: فحص محلي خفيف لا يثقل السيرفر
            is_healthy = self._check_local_health()
            now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

            if is_healthy:
                if self.last_status != "active":
                    logger.info(f"[{now}] البوت شغال ومستقر (Active).")
                    if self.pending_alert:
                        send_messenger_alert("البوت عاد للعمل بنجاح! ✅", f"تم استعادة الاتصال وخدمة البوت تعمل الآن بشكل طبيعي.\nالوقت: {now}", "success")
                        self.pending_alert = None
                self.last_status = "active"
                self.consecutive_failures = 0
            else:
                # إذا لم يستجب الـ API المحلي، نتحقق من SSH
                ok, status = self._check_ssh()
                if ok:
                    if status != "active" and self.last_status == "active":
                        logger.warning(f"[{now}] البوت توقف: {status}")
                        self.pending_alert = f"خدمة البوت {SERVICE_NAME} توقفت (الحالة: {status}) في {now}"
                    self.last_status = status
                else:
                    self.consecutive_failures += 1
                    logger.error(f"[{now}] تعذر الاتصال بالسيرفر ({self.consecutive_failures}x): {status}")

            time.sleep(CHECK_INTERVAL_SECONDS)


if __name__ == "__main__":
    monitor = BotMonitor()
    try:
        monitor.run()
    except KeyboardInterrupt:
        logger.info("تم إيقاف المراقب يدوياً.")
