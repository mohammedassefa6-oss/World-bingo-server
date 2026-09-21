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

## Gameplay upgrades (cartela countdown, auto number-calling, auto BINGO detection)
- **Cartela-selection countdown**: joining a stake room no longer starts the
  game the instant 2 players join. Instead a countdown (default 45s,
  configurable via `CARTELA_SELECTION_SECONDS`) runs so more players can join
  and pick a cartela. When it expires: if 2+ players joined, the game starts;
  if fewer than 2, everyone is automatically refunded and the room resets.
- **Number calling now shows the letter**, e.g. "B 5", "O 61" — both in the
  Mini App and in the Telegram bot chat game.
- **Automatic BINGO detection**: the server itself checks every player's
  card after each number call, in every direction (rows, columns, both
  diagonals, four corners). The moment someone completes a line the round
  ends automatically and the prize is paid out — no manual "claim" needed.
  If more than one player completes a line on the same call, they split the
  prize and all their winning cartela numbers are shown to everyone in that
  room. The "🏆 BINGO!" button still works as a manual double-check/fallback.
- **Invite** already existed (Invite tab in the Mini App, and "🔗 Invite" in
  the bot chat menu) — it will start returning a real link now that
  `TELEGRAM_BOT_USERNAME` is set on Railway.
- **Contact Support** already exists as "☎️ Contact Support" in the bot chat
  menu (shows the `SUPPORT_CONTACT` value you set).

New Railway variable (optional):
- CARTELA_SELECTION_SECONDS = 45 (or however long you want the pick-a-card window to be)

## Slash commands, auto-notifications, Main/Play Wallet (from a reference bot comparison)
- **Slash commands** now work alongside the button menu: /start, /play,
  /register, /balance, /deposit, /withdraw, /transfer, /invite,
  /instruction, /support, /convertbonus. The bot also registers these with
  Telegram's `setMyCommands` on startup so they show in the "/" menu.
- **Fixed a bug**: `/start <referralCode>` (the deep-link used by invite
  links) was never actually being read before — it only matched a bare
  `/start`. Referral tracking works correctly now.
- **Auto-notifications**: when you approve/reject a deposit or withdrawal
  via `/admin/deposit/:id/approve` etc., the player now automatically gets
  a Telegram message ("✅ Your deposit of 10 ETB is Approved. Ref: ...").
- **Main Wallet / Play Wallet**: "Check Balance" (and the Mini App Wallet
  tab) now show both — Main Wallet is your real balance; Play Wallet shows
  the amount currently staked in an active room (0 when not playing). This
  is a display-only split; money handling/ledger logic is unchanged, so no
  extra migration is needed.

## Live-game screen redesign (Game ID / Players / Bet / Derash / Called + full board)
The Mini App's game screen now matches the reference layout you shared:
- **Stats bar**: Game ID, Players, Bet, Derash (net prize pool = stake ×
  players × (1 - house cut)), Called (how many numbers called so far).
- **Full 1–75 caller board** (B/I/N/G/O columns) showing every called
  number highlighted, in addition to your own 5×5 card below it.
- **Progress bar** that fills up between number calls (matches
  `CALL_INTERVAL_MS`, fetched from the new public `/config` endpoint).
- **🔊 Auto-announce toggle**: when on, your phone speaks each new number
  ("B 5", "O 61") using the browser's built-in text-to-speech — no audio
  files needed. Purely client-side; doesn't affect gameplay.

No new Railway variables needed for this part.
