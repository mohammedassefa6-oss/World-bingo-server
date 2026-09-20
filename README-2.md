
# Beteseb Bingo — chat-menu build (no Mini App needed to play)

## What changed
- Added `telegramBot.js`: the whole experience (Register, Play, Check Balance,
  Deposit, Withdraw, Transfer, Invite, Contact Support, Instruction, Convert Bonus)
  now runs as normal Telegram bot messages + inline keyboards — the Mini App
  (public/index.html) is no longer required for players and is left untouched
  in case you want it later.
- `index.js` now exposes `POST /telegram/webhook` and calls Telegram's
  `setWebhook` automatically on startup (using `PUBLIC_URL` or Railway's
  `RAILWAY_PUBLIC_DOMAIN`).
- VPN blocking was intentionally **not** implemented: Telegram bot chat never
  exposes the player's real IP address to your server (only Telegram's own
  server IPs), so it cannot be checked this way. If you want VPN/proxy
  blocking later, it only becomes possible if players connect through a
  Mini App/WebApp, where their device talks to your server directly.

## Railway variables
Required (same as before):
- FIREBASE_DATABASE_URL
- FIREBASE_SERVICE_ACCOUNT_BASE64
- TELEGRAM_BOT_TOKEN
- ADMIN_UIDS

New / recommended:
- PUBLIC_URL = e.g. https://your-app.up.railway.app  (or rely on Railway's
  auto-set RAILWAY_PUBLIC_DOMAIN)
- TELEGRAM_WEBHOOK_SECRET = any random string, used to verify webhook calls
- TELEGRAM_BOT_USERNAME = bot username without @ (used for invite links)
- SUPPORT_CONTACT = e.g. @YourSupportUsername (shown on "Contact Support")
- SIGNUP_BONUS = ETB bonus credited on first /start (optional, default 0)
- REFERRAL_BONUS = ETB bonus credited to the referrer (optional, default 0)
- HOUSE_CUT = 0.20 (unchanged)
- CALL_INTERVAL_MS = 3000 (unchanged)

## Deploy
1. Push all files to your Railway GitHub repo (same as before).
2. Set the Railway variables above.
3. On boot, the app calls Telegram's setWebhook using PUBLIC_URL /
   RAILWAY_PUBLIC_DOMAIN. Check the Railway logs for "setWebhook result: ok".
4. Message your bot with /start — you should see the menu keyboard appear.

## Notes / limitations
- Session state (deposit/withdraw/transfer "waiting for amount", and active
  game watchers) is kept in memory in `telegramBot.js`. This is fine for a
  single Railway instance/replica. If you ever scale to multiple instances,
  move `sessions` and `watchers` into Firebase so all instances share state.
- "Convert Bonus" assumes a simple `users/{uid}/bonus` balance (credited via
  SIGNUP_BONUS / REFERRAL_BONUS) that converts 1:1 into the real balance.
  Adjust `handleConvertBonus` in telegramBot.js if you want wagering
  requirements before it can be converted.
- The existing Mini App files (public/index.html, and the original
  /verify-telegram-login, /balance, /profile, etc. HTTP routes) are left
  in place and still work if you ever want to offer the Mini App again —
  they just aren't part of the default chat flow anymore.

## Telebirr auto-approval (new)
Added `telebirr.js` as the integration point for automatic deposit
verification and automatic withdrawal payout.

- **Not configured yet** (default): deposit/withdraw behave exactly as
  before — a request is created and you approve it manually via
  `/admin/deposit/:id/approve` etc. Nothing changes until you set the
  variables below.
- **Once configured**: Deposit asks the player for their Telebirr
  transaction ID and verifies it before crediting; Withdraw sends the
  payout to the player's saved phone number automatically. If either
  auto step fails, it safely falls back to a manual admin-approval
  request instead of losing the money.

Add these Railway variables when you have your Telebirr merchant
credentials, and send me the actual Telebirr API docs so I can fill in
the two request/response blocks in `telebirr.js` marked
"FILL IN FROM YOUR TELEBIRR DOCS" — they're currently a placeholder shape:
- TELEBIRR_API_BASE
- TELEBIRR_APP_ID
- TELEBIRR_APP_SECRET
- TELEBIRR_SHORT_CODE
