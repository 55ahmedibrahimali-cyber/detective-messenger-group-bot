# تصليب الأمان — البوت والسيرفر

هذا المستند بيغطي حاجتين مختلفتين تماماً: أمان **الكود نفسه** (موجود جزء كبير منه بالفعل في المشروع)،
وأمان **السيرفر (VPS)** اللي البوت شغال عليه (مسؤوليتك، خارج الكود).

> ما ده: تصليب دفاعي (تشفير، صلاحيات، حدود، عزل). مش فيه ولا سطر عن تجاوز أنظمة فيسبوك أو إخفاء
> هوية البوت — ده موضوع منفصل اتوضح قبل كده وما بينفعش تقنياً أصلاً.

---

## 1) اللي موجود بالفعل في الكود (ولازم يفضل مفعّل)

| الحماية | الملف | هتتأكد منها إزاي |
|---|---|---|
| تشفير appstate (AES-256-GCM) | `services/secureStore.js` | حطّ `APPSTATE_ENCRYPTION_KEY` (16+ حرف) في `.env` |
| إخفاء الأسرار من اللوج | `services/logRedactor.js` | لازم يتحمّل أول سطر في `server.js`/`telegram.js` (موجود) |
| قفل تلقائي بعد رفض الدخول | `services/messengerFacebook.js` + `.nexca/login-lock.json` | لا تحذفه ولا تستخدم FORCE_LOGIN يدوياً |
| حدود إرسال (دقيقة/ساعة/يوم) | `services/safety.js`, `.env` (`MAX_SENDS_PER_*`) | راجع الأرقام دورياً |
| Rate limit للرسائل الواردة | `server.js` (`USER_RATE_LIMIT_*`) | يمنع إغراق البوت برسائل من مستخدم واحد |
| صلاحيات الأدمن منفصلة عن الكود | `services/adminAuth.js`, `admin-ids.json` أو `.nexca/telegram-admin-ids.json` | الملفات دي بره git (`.gitignore`) |
| روابط صور موقّعة ومؤقتة (HMAC + timing-safe) | `services/spyImageLinks.js` | `SPY_IMAGE_LINK_SECRET` يتولّد تلقائياً لو مش موجود |
| SQL parametrized بالكامل | `database.js` | ما تضفش أي `query(sql + userInput)` يدوي |
| فحص إقلاع تلقائي | `services/securityCheck.js` | يطبع تحذيرات عند أي تشغيل (`npm start` / `npm run start:telegram`) |

**فحص الإقلاع الجديد (`securityCheck.js`)** بيتأكد من: صلاحيات الملفات الحساسة، إنك مش شغّال بصلاحيات
root، وجود تشفير appstate، كلمة مرور DB، إعدادات روابط الصور. لو عايز يرفض التشغيل عند مشكلة حرجة
(تشغيل بـroot مثلاً) بدل التحذير بس، حطّ `SECURITY_STRICT=1` في `.env`.

---

## 2) تصليب السيرفر (VPS) — الأهم فعلياً

### مستخدم غير root
```bash
adduser botuser
usermod -aG sudo botuser   # لو محتاج sudo وقت بس
su - botuser
```
شغّل البوت بالمستخدم ده دايماً، مش root. لو حد اخترق عملية Node، بيقف عند صلاحيات مستخدم عادي.

### SSH
```bash
# في /etc/ssh/sshd_config
PasswordAuthentication no
PermitRootLogin no
```
ادخل بمفتاح SSH بس. وغيّر البورت الافتراضي 22 لو عايز تقلل محاولات bots العشوائية (مش حماية حقيقية لوحدها، بس بتقلل الضوضاء في اللوج).

### جدار الحماية (ufw)
```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
# افتح بس البورت اللي spyImageServer/drawingTunnel محتاجينه لو مفعّلين، وبس
ufw enable
```
البوت نفسه (اتصال MQTT/WebSocket لفيسبوك أو Telegram) خارج، مش داخل — يعني مفيش بورت داخل لازم يتفتح غير لو فعّلت `SPY_IMAGE_PUBLIC_BASE_URL`.

### fail2ban
```bash
apt install fail2ban
systemctl enable --now fail2ban
```
بيوقف محاولات brute-force على SSH تلقائياً.

### تحديثات تلقائية
```bash
apt install unattended-upgrades
dpkg-reconfigure --priority=low unattended-upgrades
```

### تشغيل كخدمة معزولة (systemd)
استخدم مجلداً خارج `/home` حتى لا يتعارض `ProtectHome=true` مع مسار التطبيق:
```bash
sudo install -d -o botuser -g botuser -m 0750 /opt/detective-bot
```

```ini
# /etc/systemd/system/detective-bot.service
[Unit]
Description=Detective Bot
After=network.target

[Service]
User=botuser
WorkingDirectory=/opt/detective-bot
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

# عزل إضافي (systemd sandboxing)
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/detective-bot
MemoryMax=1G

[Install]
WantedBy=multi-user.target
```
```bash
systemctl daemon-reload
systemctl enable --now detective-bot
journalctl -u detective-bot -f   # متابعة اللوج
```
`ProtectSystem=strict` + `ReadWritePaths` معناها البوت ما يقدرش يكتب في أي مكان في السيرفر غير مجلده هو، حتى لو اتعمله اختراق جزئي.

### صلاحيات الملفات
نفّذ الأوامر للملفات التي تستخدمها والموجودة فقط:
```bash
chmod 600 .env .env.telegram appstate.json admin-ids.json
chmod 700 .nexca/
# عند استخدام Telegram وبعد إنشاء ملف الأدمن:
chmod 600 .nexca/telegram-admin-ids.json
```
فحص الإقلاع الجديد (`securityCheck.js`) بيحذّرك تلقائياً لو ملف من دول صلاحياته واسعة.

### نسخ احتياطي
اعمل نسخة من ملفات البيئة والجلسة المشفّرة وقوائم الأدمن في مكان تاني **مش على نفس السيرفر**، مشفّرة بمفتاح منفصل. لو السيرفر اتسرق أو اتحظر، تقدر ترجع بسرعة.

### مراقبة
```bash
journalctl -u detective-bot --since "1 hour ago" | grep -i "security\|error"
```
راجع كلمة `[security]` و`[security][حرج]` في اللوج بعد كل تشغيل.

---

## 3) قائمة تأكيد سريعة قبل ما تعتبر السيرفر جاهز

- [ ] البوت شغّال بمستخدم عادي، مش root
- [ ] SSH بمفتاح بس، `PasswordAuthentication no`
- [ ] `ufw` شغّال ومفيهوش بورتات مفتوحة غير اللي محتاجها فعلاً
- [ ] `fail2ban` شغّال
- [ ] `.env` و`appstate.json` و`admin-ids.json` صلاحياتهم `600`
- [ ] `APPSTATE_ENCRYPTION_KEY` و`DB_PASSWORD` متظبطين في `.env`
- [ ] نسخة احتياطية مشفّرة في مكان منفصل
- [ ] تشغيل `node server.js` مرة يدوياً وقراءة كل أسطر `[security]` في البداية
