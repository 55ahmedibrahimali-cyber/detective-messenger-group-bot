# نشر Detective Bot على AWS EC2

## المتطلبات

| المتطلب | التفاصيل |
|---------|---------|
| EC2 Instance | t3.micro أو أكبر |
| نظام التشغيل | Ubuntu 22.04 / 24.04 LTS أو Amazon Linux 2 |
| Node.js | v22 LTS (يُثبَّت تلقائياً بالسكريبت) |
| المنفذ | 3000 (أو ما تحدده في `SERVER_PORT`) |
| Security Group | افتح منفذ 3000 (أو 80 مع Nginx) |

---

## الخطوات

### 1. تحضير EC2

```bash
# على جهازك المحلي — استبدل <EC2_IP> بعنوان الـ instance
EC2_IP="52.1.2.3"

# رفع ملفات المشروع (بدون node_modules و.env وappstate)
rsync -avz \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude 'appstate.json' \
  --exclude 'appstate.json.bak' \
  --exclude '.nexca' \
  ./ ubuntu@${EC2_IP}:/opt/detective-bot/

# رفع .env بشكل منفصل (ملف سري)
scp .env ubuntu@${EC2_IP}:/opt/detective-bot/.env
```

### 2. تشغيل سكريبت الإعداد

```bash
ssh ubuntu@${EC2_IP}
bash /opt/detective-bot/deploy/aws/setup.sh
```

السكريبت يقوم بـ:
- تثبيت Node.js v22
- تثبيت `npm install --omit=dev`
- إنشاء systemd service مع `Restart=on-failure`
- إعداد Nginx (اختياري)

### 3. رفع appstate.json

**الطريقة الأولى — نسخ مباشر:**
```bash
scp appstate.json ubuntu@${EC2_IP}:/opt/detective-bot/appstate.json
sudo systemctl restart detective-bot
```

**الطريقة الثانية — عبر لوحة الإدارة (بدون SSH):**

1. افتح `http://<EC2_IP>:3000/admin/appstate` في المتصفح
2. الصق محتوى `appstate.json` الجديد في الحقل
3. اضغط "تحديث الجلسة" ✅

**الطريقة الثالثة — عبر API (أوتوماتيكي):**
```bash
# من جهازك المحلي
bash scripts/uploadAppState.sh http://<EC2_IP>:3000 <APPSTATE_ADMIN_KEY> appstate.json
```

---

## الأوامر اليومية

```bash
# حالة البوت
sudo systemctl status detective-bot

# السجلات المباشرة
sudo journalctl -u detective-bot -f

# إعادة التشغيل
sudo systemctl restart detective-bot

# حالة appstate وقفل الجلسة
cd /opt/detective-bot && node scripts/renewAppState.js --status

# رفع قفل الجلسة (بعد تحديث appstate)
cd /opt/detective-bot && node scripts/renewAppState.js --unlock

# تحديث الكود (بعد rsync جديد)
bash /opt/detective-bot/deploy/aws/setup.sh --update
```

---

## متغيرات البيئة المهمة على AWS

أضف هذه القيم في `/opt/detective-bot/.env` على السيرفر:

```env
# حماية لوحة الإدارة (مهم على السيرفر العام!)
APPSTATE_ADMIN_KEY=كلمة_مرور_قوية_هنا

# تجديد تلقائي للكوكيز (يمد عمر الجلسة)
AUTO_RENEW_APPSTATE=1
APPSTATE_REFRESH_INTERVAL_MINUTES=30

# اختياري: بيانات الحساب للتجديد التلقائي الكامل
FB_EMAIL=
FB_PASSWORD=
FB_2FA_SECRET=

# تشفير ملف appstate على القرص
APPSTATE_ENCRYPTION_KEY=مفتاح_عشوائي_32_حرف

# السيرفر لا يخرج عند انتهاء الجلسة
# EXIT_ON_SESSION_DIE=0  (هو الافتراضي)
```

---

## Health Check (AWS ALB / CloudWatch)

البوت يوفر endpoint جاهز للمراقبة:

```
GET http://<EC2_IP>:3000/health
GET http://<EC2_IP>:3000/healthz
GET http://<EC2_IP>:3000/ping
```

**استجابة ناجحة (200):**
```json
{
  "ok": true,
  "uptime": 3600,
  "appStateValid": true,
  "loginLocked": false,
  "uid": "61596285251802"
}
```

**عند وجود مشكلة (503):**
```json
{
  "ok": false,
  "uptime": 120,
  "appStateValid": true,
  "loginLocked": true,
  "uid": "61596285251802"
}
```

### إعداد CloudWatch Alarm

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name "DetectiveBotHealth" \
  --metric-name "UnhealthyHostCount" \
  --namespace "AWS/ApplicationELB" \
  --statistic Average \
  --period 60 \
  --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold \
  --evaluation-periods 2 \
  --alarm-actions arn:aws:sns:REGION:ACCOUNT:YourSNSTopic
```

---

## Security Group — المنافذ المطلوبة

| المنفذ | البروتوكول | المصدر | الغرض |
|--------|-----------|--------|-------|
| 22 | TCP | IP الجهاز فقط | SSH |
| 3000 | TCP | IP الجهاز فقط | لوحة الإدارة (بدون Nginx) |
| 80 | TCP | 0.0.0.0/0 | Nginx (اختياري) |
| 443 | TCP | 0.0.0.0/0 | HTTPS + Nginx + Let's Encrypt |

> **تحذير:** لا تفتح منفذ 3000 للعالم بدون تفعيل `APPSTATE_ADMIN_KEY` في `.env`

---

## Nginx + Let's Encrypt (HTTPS)

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d bot.yourdomain.com
```

ثم استخدم `https://bot.yourdomain.com/admin/appstate` بدلاً من IP مباشرة.

---

## استكشاف الأخطاء

| المشكلة | الحل |
|---------|------|
| `login_blocked` بعد البدء | افتح لوحة الإدارة وارفع appstate جديد |
| السيرفر يرفض الاتصال | تحقق من Security Group والمنفذ 3000 |
| الـ service لا يبدأ | `sudo journalctl -u detective-bot --no-pager -n 50` |
| `APPSTATE_ENCRYPTION_KEY` مفقود | أضفه إلى `.env` وأعد تشغيل البوت |
| قفل الجلسة لا يُرفع | `node scripts/renewAppState.js --unlock` |
