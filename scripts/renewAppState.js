#!/usr/bin/env node
// scripts/renewAppState.js - سكربت تجديد ملف appstate.json من سطر الأوامر (CLI)
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
require("../services/logRedactor").install();
require("../services/configLoader").loadConfig();

const appstateRenewer = require("../services/appstateRenewer");

(async () => {
  console.log("==================================================");
  console.log("🕵️ أداة تجديد والتحقق من ملف appstate (Detective Bot)");
  console.log("==================================================");

  const status = appstateRenewer.getStatus();
  console.log(`- وجود ملف appstate: ${status.appStateExists ? "نعم ✅" : "لا ❌"}`);
  console.log(`- صحة الكوكيز الحالية: ${status.appStateValid ? "صالحة ✅" : "غير صالحة ❌"}`);
  console.log(`- معرّف الحساب (UID): ${status.uid || "غير متوفر"}`);
  console.log(`- عدد الكوكيز: ${status.cookieCount}`);
  console.log(`- مشفر بـ AES: ${status.encrypted ? "نعم 🔒" : "لا"}`);
  console.log(`- قفل تسجيل الدخول: ${status.loginLocked ? `مغلق حتى ${status.lockDetails?.blockedUntil} (السبب: ${status.lockDetails?.reason})` : "مفتوح ✅"}`);
  console.log(`- بيانات الحساب في .env: ${status.credentialsConfigured ? "موجودة ✅" : "غير مكتملة ⚠️"}`);
  console.log(`- مفتاح 2FA في .env: ${status.twoFactorConfigured ? "محدد ✅" : "غير محدد"}`);
  console.log("--------------------------------------------------");

  if (process.argv.includes("--status")) {
    process.exit(0);
  }

  if (process.argv.includes("--unlock")) {
    appstateRenewer.clearLock();
    console.log("تمت إزالة قفل تسجيل الدخول بنجاح.");
    process.exit(0);
  }

  console.log("جاري محاولة التجديد التلقائي للجلسة...");
  const result = await appstateRenewer.renewFromCredentials();
  if (result.ok) {
    console.log(`✅ نجح التجديد: ${result.message}`);
    console.log(`معرف الحساب الجديد: ${result.uid}`);
    process.exit(0);
  } else {
    console.error(`❌ تعذّر التجديد التلقائي: ${result.error}`);
    console.log("\n💡 الحلول المتاحة:");
    console.log("1. تأكد من صحة FB_EMAIL و FB_PASSWORD ومفتاح 2FA في ملف .env");
    console.log("2. أو صدّر appstate.json من متصفحك وحدثه عبر لوحة الإدارة:");
    console.log("   http://localhost:3000/admin/appstate");
    process.exit(1);
  }
})();
