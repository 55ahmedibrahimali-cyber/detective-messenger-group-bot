#!/usr/bin/env bash
# deploy/aws/setup.sh — نشر Detective Bot على AWS EC2 (Ubuntu / Amazon Linux 2)
# الاستخدام: bash deploy/aws/setup.sh [--update]
#
# المتطلبات:
#   - EC2 instance بـ Ubuntu 22.04 / 24.04 أو Amazon Linux 2
#   - المشروع محلياً مع .env مهيأ
#   - صلاحيات sudo على السيرفر
#
# الأمر المباشر لرفع الملفات والتشغيل:
#   rsync -avz --exclude 'node_modules' --exclude '.env' --exclude 'appstate.json' \
#         ./ ubuntu@<EC2_IP>:/opt/detective-bot/
#   ssh ubuntu@<EC2_IP> 'bash /opt/detective-bot/deploy/aws/setup.sh'

set -euo pipefail
BOT_DIR="${BOT_DIR:-/opt/detective-bot}"
BOT_USER="${BOT_USER:-ubuntu}"
SERVICE_NAME="detective-bot"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[setup]${NC} $*"; }
warn()  { echo -e "${YELLOW}[setup]${NC} $*"; }
error() { echo -e "${RED}[setup]${NC} $*"; exit 1; }

# --- 1. تثبيت Node.js ---
install_node() {
  if command -v node &>/dev/null; then
    info "Node.js موجود: $(node -v)"
  else
    info "تثبيت Node.js v22 LTS..."
    if command -v apt-get &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt-get install -y nodejs
    elif command -v yum &>/dev/null; then
      curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo -E bash -
      sudo yum install -y nodejs
    else
      error "مدير الحزم غير معروف. ثبّت Node.js يدوياً."
    fi
  fi
}

# --- 2. إنشاء مستخدم ومجلد البوت ---
setup_dirs() {
  if ! id "$BOT_USER" &>/dev/null; then
    info "إنشاء مستخدم $BOT_USER..."
    sudo useradd -r -s /bin/false -d "$BOT_DIR" "$BOT_USER" || true
  fi
  sudo mkdir -p "$BOT_DIR"
  sudo chown -R "$BOT_USER:$BOT_USER" "$BOT_DIR"
  sudo chmod 750 "$BOT_DIR"
  info "مجلد البوت: $BOT_DIR"
}

# --- 3. تثبيت cloudflared لنفق صفحة الرسم تلقائياً ---
install_cloudflared() {
  if command -v cloudflared &>/dev/null; then
    info "cloudflared موجود: $(cloudflared --version 2>&1 | head -1)"
  else
    info "تثبيت cloudflared لصفحة الرسم..."
    ARCH="amd64"
    if [[ "$(uname -m)" == "aarch64" || "$(uname -m)" == "arm64" ]]; then
      ARCH="arm64"
    fi
    sudo curl -fsSL -o /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}" || true
    if [[ -f /usr/local/bin/cloudflared ]]; then
      sudo chmod +x /usr/local/bin/cloudflared
      info "تم تثبيت cloudflared بنجاح ✅"
    else
      warn "تعذر تثبيت cloudflared تلقائياً؛ سيقوم البوت بتحميله عند الحاجة."
    fi
  fi
}

# --- 3. تثبيت الاعتماديات ---
install_deps() {
  info "تثبيت npm packages..."
  cd "$BOT_DIR"
  sudo -u "$BOT_USER" npm install --omit=dev --no-audit 2>&1 | tail -5
}

# --- 4. إنشاء مجلد .nexca للقفل ---
setup_nexca() {
  sudo -u "$BOT_USER" mkdir -p "$BOT_DIR/.nexca"
  sudo chmod 700 "$BOT_DIR/.nexca"
}

# --- 5. تثبيت systemd service ---
install_service() {
  info "تثبيت systemd service..."
  SERVICE_FILE="$BOT_DIR/deploy/aws/detective-bot.service"
  if [[ ! -f "$SERVICE_FILE" ]]; then
    error "ملف الـ service غير موجود: $SERVICE_FILE"
  fi

  # استبدال User وWorkingDirectory بالقيم الفعلية
  sed "s|User=ubuntu|User=$BOT_USER|g; s|WorkingDirectory=/opt/detective-bot|WorkingDirectory=$BOT_DIR|g; s|ExecStart=.*|ExecStart=$(command -v node) $BOT_DIR/server.js|g; s|EnvironmentFile=.*|EnvironmentFile=$BOT_DIR/.env|g" \
      "$SERVICE_FILE" | sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" > /dev/null

  sudo systemctl daemon-reload
  sudo systemctl enable "$SERVICE_NAME"
  info "Service مثبّت: $SERVICE_NAME"
}

# --- 6. إعداد Nginx (اختياري) ---
setup_nginx() {
  if ! command -v nginx &>/dev/null; then
    warn "Nginx غير موجود، سيتخطى إعداده."
    return
  fi
  read -rp "هل تريد إعداد Nginx reverse proxy للوحة الإدارة؟ [y/N] " yn
  if [[ "$yn" != "y" && "$yn" != "Y" ]]; then return; fi

  SERVER_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || hostname -I | awk '{print $1}')
  read -rp "أدخل دومينك (أو اضغط Enter لاستخدام $SERVER_IP): " DOMAIN
  DOMAIN="${DOMAIN:-$SERVER_IP}"

  sudo tee "/etc/nginx/sites-available/${SERVICE_NAME}" > /dev/null <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    # لوحة إدارة الـ appstate فقط — لا تعرض أي route آخر
    location /admin/appstate {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }

    location /api/appstate/ {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }

    # مسارات لعبة الرسم والصور
    location /draw/ {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }

    location /api/draw {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }

    location /game-images/ {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }

    # احجب كل شيء تاني
    location / {
        return 403;
    }
}
NGINX

  sudo ln -sf "/etc/nginx/sites-available/${SERVICE_NAME}" "/etc/nginx/sites-enabled/"
  sudo nginx -t && sudo systemctl reload nginx
  info "Nginx جاهز: http://${DOMAIN}/admin/appstate"
  warn "يُنصح بإضافة SSL عبر: sudo certbot --nginx -d ${DOMAIN}"
}

# --- 7. تحديث فقط (--update) ---
do_update() {
  info "تحديث الملفات وإعادة تشغيل الـ service..."
  cd "$BOT_DIR"
  sudo -u "$BOT_USER" npm install --omit=dev --no-audit 2>&1 | tail -3
  sudo systemctl restart "$SERVICE_NAME"
  sleep 2
  sudo systemctl status "$SERVICE_NAME" --no-pager -l | head -20
  info "تم التحديث ✅"
  exit 0
}

# --- Main ---
if [[ "${1:-}" == "--update" ]]; then
  do_update
fi

info "بدء إعداد Detective Bot على AWS..."
install_node
setup_dirs
install_cloudflared
install_deps
setup_nexca
install_service
setup_nginx

# تشغيل
if [[ -f "$BOT_DIR/.env" ]]; then
  info "ملف .env موجود ✅"
else
  warn ".env غير موجود! انسخه إلى $BOT_DIR/.env قبل التشغيل."
fi

if [[ -f "$BOT_DIR/appstate.json" ]]; then
  info "appstate.json موجود ✅"
else
  warn "appstate.json غير موجود! سيبدأ البوت لكن سيفشل الاتصال بـ Facebook."
  warn "ارفع appstate.json أو استخدم لوحة الإدارة عبر المتصفح بعد التشغيل."
fi

sudo systemctl start "$SERVICE_NAME"
sleep 3
sudo systemctl status "$SERVICE_NAME" --no-pager -l | head -25

info "
=================================================
  Detective Bot يعمل الآن 🎉
  لوحة إدارة الـ appstate:
    http://$(hostname -I | awk '{print $1}'):3000/admin/appstate
  
  الأوامر المفيدة:
    sudo systemctl status $SERVICE_NAME     # الحالة
    sudo journalctl -u $SERVICE_NAME -f      # السجلات
    sudo systemctl restart $SERVICE_NAME    # إعادة تشغيل
    bash deploy/aws/setup.sh --update       # تحديث
=================================================
"
