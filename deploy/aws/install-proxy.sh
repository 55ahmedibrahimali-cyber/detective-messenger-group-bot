#!/usr/bin/env bash
# deploy/aws/install-proxy.sh — تثبيت بروكسي HTTP/HTTPS آمن وخفيف (Tinyproxy) على السيرفر
# الاستخدام: bash deploy/aws/install-proxy.sh [PROXY_PORT] [PROXY_USER] [PROXY_PASS]

set -euo pipefail

PROXY_PORT="${1:-8888}"
PROXY_USER="${2:-botproxy}"
PROXY_PASS="${3:-$(openssl rand -hex 8)}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[proxy-setup]${NC} $*"; }
warn()  { echo -e "${YELLOW}[proxy-setup]${NC} $*"; }

info "تثبيت Tinyproxy على السيرفر..."
if command -v apt-get &>/dev/null; then
  sudo apt-get update -y
  sudo apt-get install -y tinyproxy
elif command -v yum &>/dev/null; then
  sudo yum install -y tinyproxy || sudo dnf install -y tinyproxy
else
  echo "مدير الحزم غير مدعوم تلقائياً."
  exit 1
fi

CONF="/etc/tinyproxy/tinyproxy.conf"
if [[ ! -f "$CONF" && -f "/etc/tinyproxy.conf" ]]; then
  CONF="/etc/tinyproxy.conf"
fi

sudo cp "$CONF" "${CONF}.bak"

# إعداد الكونفج للسماح بالاتصال الخارجي المحمي بكلمة سر
sudo sed -i "s/^Port .*/Port ${PROXY_PORT}/" "$CONF"
sudo sed -i "s/^Allow /#Allow /" "$CONF"
sudo sed -i "s/^BasicAuth /#BasicAuth /" "$CONF"

# إضافة صلاحيات الدخول
cat <<EOF | sudo tee -a "$CONF" > /dev/null

# --- إعدادات البروكسي الآمن للبوت ---
BasicAuth ${PROXY_USER} ${PROXY_PASS}
DisableViaHeader Yes
EOF

# فتح المنفذ في جدار الحماية المحلي إذا كان ufw مفعلاً
if command -v ufw &>/dev/null && sudo ufw status | grep -q "Status: active"; then
  sudo ufw allow "${PROXY_PORT}/tcp" || true
fi

sudo systemctl restart tinyproxy
sudo systemctl enable tinyproxy

SERVER_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || hostname -I | awk '{print $1}')

echo ""
echo -e "${GREEN}======================================================${NC}"
echo -e "${GREEN}  تم تجهيز البروكسي على السيرفر بنجاح! 🎉${NC}"
echo -e "${GREEN}======================================================${NC}"
echo ""
echo "بيانات البروكسي الخاصة بك للربط في المتصفح:"
echo "-----------------------------------------------"
echo "نوع البروكسي: HTTP / HTTPS"
echo "الخادم (Server IP): ${SERVER_IP}"
echo "المنفذ (Port):      ${PROXY_PORT}"
echo "اسم المستخدم:      ${PROXY_USER}"
echo "كلمة المرور:        ${PROXY_PASS}"
echo ""
echo "رابط البروكسي لملف .env (إن رغبت):"
echo "HTTPS_PROXY=http://${PROXY_USER}:${PROXY_PASS}@${SERVER_IP}:${PROXY_PORT}"
echo ""
echo -e "${YELLOW}تنبيه هام جداً لـ AWS:${NC}"
echo "تأكد من فتح المنفذ ${PROXY_PORT} (Custom TCP) في Security Groups على لوحة AWS."
echo "-----------------------------------------------"
