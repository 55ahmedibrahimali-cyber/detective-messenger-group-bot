import os
from pathlib import Path

# إعدادات السيرفر
SSH_HOST = os.getenv("BOT_SSH_HOST", "13.48.58.210")
SSH_USER = os.getenv("BOT_SSH_USER", "ubuntu")
SSH_KEY_PATH = os.getenv(
    "BOT_SSH_KEY",
    str(Path.home() / "Downloads" / "detective-bot-ec2.pem")
)

# مالك البوت على الماسنجر
BOT_OWNER_NAME = "لايت"
BOT_OWNER_FB_ID = "61555344774852"

# رابط API التنبيهات المحلي للبوت على السيرفر
LOCAL_NOTIFY_URL = "http://127.0.0.1:3000/api/notify"
HEALTH_URL = "http://127.0.0.1:3000/api/health"

# إعدادات الفحص
CHECK_INTERVAL_SECONDS = int(os.getenv("CHECK_INTERVAL", "60"))
SERVICE_NAME = "detective-bot"
