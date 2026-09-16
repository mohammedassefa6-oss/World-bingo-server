# Beteseb Bingo — unified Railway build

## Railway variables
Required:
- FIREBASE_DATABASE_URL = https://world-bingo-2-default-rtdb.firebaseio.com
- FIREBASE_SERVICE_ACCOUNT_BASE64 = your Firebase service-account JSON encoded as base64
- TELEGRAM_BOT_TOKEN = your bot token
- ADMIN_UIDS = comma-separated Telegram Firebase UIDs, e.g. tg_442182826

Recommended:
- TELEGRAM_BOT_USERNAME = your bot username without @
- TELEGRAM_MINI_APP_LINK_BASE = your Telegram Mini App base URL, e.g. https://t.me/YourBot/YourApp
- HOUSE_CUT = 0.20
- CALL_INTERVAL_MS = 3000

## Deploy
Push all files in this folder to the SAME Railway GitHub repository. Railway start command is `node index.js`.

Set BotFather Menu Button / Mini App URL to the Railway public URL, not GitHub Pages.

## Firebase rules
Keep the existing server-authoritative rules. Do not allow clients to write balances, money requests, winners, or rooms.

## Important
Existing balances remain in the same Firebase database. This app does not reset user balances.
