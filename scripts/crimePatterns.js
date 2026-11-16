"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const telegramIndex = args.indexOf("--telegram");
const useTelegramDatabase = telegramIndex !== -1;
if (useTelegramDatabase) args.splice(telegramIndex, 1);
require("dotenv").config({
  path: path.join(root, useTelegramDatabase ? ".env.telegram" : ".env"),
});
process.env.BOT_PLATFORM = useTelegramDatabase ? "telegram" : "messenger";
require("../services/logRedactor").install();
if (useTelegramDatabase) {
  process.env.DB_NAME = process.env.TELEGRAM_DB_NAME || "detective_bot_telegram";
  process.env.DB_HOST = process.env.TELEGRAM_DB_HOST || "127.0.0.1";
  process.env.DB_PORT = process.env.TELEGRAM_DB_PORT || "3306";
  process.env.DB_USER = process.env.TELEGRAM_DB_USER || "root";
  process.env.DB_PASSWORD = process.env.TELEGRAM_DB_PASSWORD || "";
}

const db = require("../database");
const patterns = require("../games/crime/patternLibrary");
const crimeAI = require("../games/crime/aiProvider");
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function wikipediaLanguage() {
  const language = (process.env.CRIME_WIKIPEDIA_LANGUAGE || "en").trim().toLowerCase();
  if (!/^[a-z]{2,3}$/.test(language)) {
    throw new Error("CRIME_WIKIPEDIA_LANGUAGE must be a two- or three-letter code.");
  }
  return language;
}

function wikipediaUrl(title) {
  return `https://${wikipediaLanguage()}.wikipedia.org/wiki/${encodeURIComponent(
    String(title).trim().replace(/\s+/g, "_"),
  )}`;
}

async function fetchWikipedia(title) {
  const url = new URL(`https://${wikipediaLanguage()}.wikipedia.org/w/api.php`);
  url.search = new URLSearchParams({
    action: "query",
    prop: "extracts",
    explaintext: "1",
    exsectionformat: "plain",
    titles: title,
    format: "json",
    redirects: "1",
  }).toString();
  const response = await fetch(url, {
    headers: {
      "User-Agent": "DetectiveMessengerGame/2.0 (crime pattern extraction)",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Wikipedia HTTP ${response.status}`);
  const payload = await response.json();
  const page = Object.values(payload.query?.pages || {})[0];
  if (!page || page.missing !== undefined || !page.extract) {
    throw new Error("صفحة ويكيبيديا غير موجودة أو بلا نص.");
  }
  return page.extract;
}

async function ingest(items) {
  const { apiKey, models, provider } = crimeAI.requireConfig();
  let added = 0;
  let duplicates = 0;
  let failed = 0;
  for (const [index, item] of items.entries()) {
    const label = String(item.ref || item.wiki || `#${index + 1}`).slice(0, 100);
    try {
      const text = item.text ?? (item.wiki ? await fetchWikipedia(item.wiki) : "");
      const card = await patterns.extractCard({
        text,
        apiKey,
        models,
        requestModel: (...args) =>
          crimeAI.requestCrimeAIContent(...args, { provider }),
      });
      const result = await patterns.insertCard(db, card, {
        sourceRef: item.ref || (item.wiki ? wikipediaUrl(item.wiki) : null),
        approved: false,
      });
      if (result.duplicate) {
        duplicates++;
        console.log(`= مكررة: ${label}`);
      } else {
        added++;
        console.log(`+ #${result.id} (${card.crime_type}) ← ${label}`);
      }
    } catch (error) {
      failed++;
      console.error(`! فشل ${label}: ${error.message}`);
    }
    if (index + 1 < items.length) await sleep(1500);
  }
  console.log(
    `\nتم: ${added} جديدة، ${duplicates} مكررة، ${failed} فاشلة. راجع البطاقات قبل اعتمادها.`,
  );
  if (failed) process.exitCode = 1;
}

function printRow(row) {
  const card = JSON.parse(row.card_json);
  console.log(
    `#${row.id} [${row.approved ? "معتمدة" : "بانتظار المراجعة"}] استُخدمت ${row.used_count}×  صعوبة ${card.difficulty}\n` +
      `   النوع: ${card.crime_type}\n   الدافع: ${card.motive}\n   العلاقة: ${card.relationship}\n` +
      `   التضليل: ${card.deception}\n   الدليل: ${card.evidence}${card.twist ? `\n   المفاجأة: ${card.twist}` : ""}\n` +
      `   وسوم: ${(card.tags || []).join("، ")}${row.source_ref ? `\n   المصدر (للتدقيق فقط): ${row.source_ref}` : ""}\n`,
  );
}

function parseIds(values) {
  if (!values.length) throw new Error("حدّد معرّف بطاقة واحداً على الأقل.");
  const ids = values.map(Number);
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("معرّفات البطاقات يجب أن تكون أعداداً صحيحة موجبة.");
  }
  return ids;
}

function printUsage() {
  console.log(
    [
      "إدارة مكتبة أنماط الجرائم:",
      "  npm run patterns -- import crime-sources.sample.json",
      '  npm run patterns -- wiki "عنوان صفحة ويكيبيديا"',
      "  npm run patterns -- list [--pending]",
      "  npm run patterns -- approve <id...|all>",
      "  npm run patterns -- reject <id...>",
      "  npm run patterns -- stats",
      "استخدم CRIME_AI_PROVIDER=cloudflare مع CLOUDFLARE_ACCOUNT_ID وCLOUDFLARE_API_TOKEN، أو اختر groq أو gemini مع مفتاح المزوّد.",
      "أضف --telegram قبل الأمر لاستخدام قاعدة بيانات Telegram وملف .env.telegram.",
      "البطاقات الجديدة غير معتمدة؛ راجعها قبل اعتمادها للاستخدام في اللعبة.",
    ].join("\n"),
  );
}

async function main() {
  const [command, ...commandArgs] = args;
  switch (command) {
    case "import": {
      const file = commandArgs[0];
      if (!file) throw new Error("حدّد ملف JSON.");
      const data = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
      if (!Array.isArray(data)) throw new Error("الملف يجب أن يكون مصفوفة.");
      if (data.length > 50) throw new Error("يمكن استيراد 50 واقعة كحد أقصى في المرة.");
      const items = data
        .map((item) => (typeof item === "string" ? { text: item } : item))
        .filter(
          (item) =>
            item &&
            ((typeof item.text === "string" && item.text.trim()) ||
              (typeof item.wiki === "string" && item.wiki.trim())),
        );
      if (!items.length) throw new Error("لم يُعثر على نصوص وقائع صالحة في الملف.");
      await ingest(items);
      break;
    }
    case "wiki": {
      if (!commandArgs.length) throw new Error("اكتب عنوان صفحة واحدة على الأقل.");
      if (commandArgs.length > 20) throw new Error("يمكن استيراد 20 صفحة كحد أقصى في المرة.");
      await ingest(
        commandArgs.map((title) => ({
          wiki: title,
          ref: wikipediaUrl(title),
        })),
      );
      break;
    }
    case "list": {
      const rows = await patterns.listCards(db, {
        pendingOnly: commandArgs.includes("--pending"),
      });
      if (!rows.length) console.log("لا توجد بطاقات.");
      rows.forEach(printRow);
      break;
    }
    case "approve": {
      const ids =
        commandArgs.length === 1 && commandArgs[0] === "all"
          ? "all"
          : parseIds(commandArgs);
      const result = await patterns.setApproved(db, ids, true);
      console.log(`تم اعتماد ${result.affectedRows ?? 0} بطاقة.`);
      break;
    }
    case "reject": {
      for (const id of parseIds(commandArgs)) await patterns.deleteCard(db, id);
      console.log("تم حذف البطاقات المحددة.");
      break;
    }
    case "stats":
      console.log(await patterns.stats(db));
      break;
    default:
      printUsage();
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error("خطأ:", error.message);
      process.exitCode = 1;
    })
    .finally(() => setTimeout(() => process.exit(), 200));
}
