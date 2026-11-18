#!/usr/bin/env bash
# scripts/uploadAppState.sh
# رفع appstate.json جديد إلى السيرفر عبر API بشكل آمن
#
# الاستخدام:
#   bash scripts/uploadAppState.sh <SERVER_URL> <ADMIN_KEY> [appstate.json path]
#
# مثال:
#   bash scripts/uploadAppState.sh http://52.1.2.3:3000 MySecret123 appstate.json
#   bash scripts/uploadAppState.sh https://bot.example.com MySecret123

set -euo pipefail

SERVER_URL="${1:-}"
ADMIN_KEY="${2:-}"
APPSTATE_FILE="${3:-appstate.json}"

usage() {
  echo "الاستخدام: bash scripts/uploadAppState.sh <SERVER_URL> <ADMIN_KEY> [appstate.json]"
  echo "  SERVER_URL  : رابط السيرفر مثل http://52.1.2.3:3000"
  echo "  ADMIN_KEY   : قيمة APPSTATE_ADMIN_KEY في .env"
  echo "  appstate.json: مسار الملف (افتراضي: appstate.json في المجلد الحالي)"
  exit 1
}

[[ -z "$SERVER_URL" || -z "$ADMIN_KEY" ]] && usage
[[ ! -f "$APPSTATE_FILE" ]] && { echo "❌ الملف غير موجود: $APPSTATE_FILE"; exit 1; }

# التحقق من صحة JSON
if ! python3 -c "import sys,json; json.load(open('$APPSTATE_FILE'))" 2>/dev/null; then
  if ! node -e "JSON.parse(require('fs').readFileSync('$APPSTATE_FILE','utf8'))" 2>/dev/null; then
    echo "❌ الملف ليس JSON صالحاً"
    exit 1
  fi
fi

echo "📤 رفع appstate.json إلى $SERVER_URL ..."

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$SERVER_URL/api/appstate/update" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"cookies\": $(cat "$APPSTATE_FILE")}" \
  --max-time 30)

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [[ "$HTTP_CODE" == "200" ]]; then
  echo "✅ تم رفع appstate بنجاح"
  echo "$BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"
else
  echo "❌ فشل الرفع (HTTP $HTTP_CODE)"
  echo "$BODY"
  exit 1
fi
