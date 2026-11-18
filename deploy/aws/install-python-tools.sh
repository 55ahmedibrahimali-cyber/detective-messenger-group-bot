#!/bin/bash
# ============================================================
# سكريبت تثبيت أدوات Python على سيرفر AWS
# يُشغَّل مرة واحدة بعد نشر الكود على السيرفر
# ============================================================
set -e

BOT_DIR="/opt/detective-bot"
PYTHON_DIR="$BOT_DIR/python"

echo "=============================================="
echo "   تثبيت أدوات Python - Detective Bot"
echo "=============================================="

# --- التأكد من وجود Python 3 وpip ---
echo "[1/5] التحقق من Python..."
python3 --version
pip3 --version

# --- تثبيت متطلبات كل أداة ---
echo "[2/5] تثبيت متطلبات المراقب..."
pip3 install -q -r "$PYTHON_DIR/monitor/requirements.txt"

echo "[3/5] تثبيت متطلبات الـ Dashboard..."
pip3 install -q -r "$PYTHON_DIR/dashboard/requirements.txt"

echo "[4/5] نسخ ملفات systemd services..."
cp "$BOT_DIR/deploy/aws/detective-bot-monitor.service" /etc/systemd/system/
cp "$BOT_DIR/deploy/aws/detective-bot-dashboard.service" /etc/systemd/system/

# --- إضافة المتغيرات المطلوبة في .env إذا لم تكن موجودة ---
ENV_FILE="$BOT_DIR/.env"
echo ""
echo "[4.5/5] التحقق من متغيرات البيئة في .env..."
if ! grep -q "TELEGRAM_BOT_TOKEN" "$ENV_FILE" 2>/dev/null; then
    echo "" >> "$ENV_FILE"
    echo "# === إعدادات مراقب البوت (Python) ===" >> "$ENV_FILE"
    echo "TELEGRAM_BOT_TOKEN=" >> "$ENV_FILE"
    echo "TELEGRAM_OWNER_CHAT_ID=" >> "$ENV_FILE"
    echo "BOT_SSH_HOST=13.48.58.210" >> "$ENV_FILE"
    echo "BOT_SSH_USER=ubuntu" >> "$ENV_FILE"
    echo "BOT_SSH_KEY=/home/ubuntu/detective-bot-ec2.pem" >> "$ENV_FILE"
    echo "CHECK_INTERVAL=60" >> "$ENV_FILE"
    echo ""
    echo "⚠️  مهم: عدّل TELEGRAM_BOT_TOKEN و TELEGRAM_OWNER_CHAT_ID في:"
    echo "    $ENV_FILE"
fi

# --- تفعيل وتشغيل الخدمات ---
echo "[5/5] تفعيل وتشغيل الخدمات..."
systemctl daemon-reload

systemctl enable detective-bot-monitor.service
systemctl enable detective-bot-dashboard.service

systemctl restart detective-bot-monitor.service
systemctl restart detective-bot-dashboard.service

echo ""
echo "=============================================="
echo "   ✅ تم التثبيت بنجاح!"
echo "=============================================="
systemctl status detective-bot-monitor.service --no-pager -l
echo "----------------------------------------------"
systemctl status detective-bot-dashboard.service --no-pager -l
echo ""
echo "Dashboard متاح على: http://13.48.58.210:5000"
echo ""
echo "⚠️  لا تنسَ تعديل TELEGRAM_BOT_TOKEN و TELEGRAM_OWNER_CHAT_ID في:"
echo "   $ENV_FILE"
echo "   ثم: sudo systemctl restart detective-bot-monitor"
