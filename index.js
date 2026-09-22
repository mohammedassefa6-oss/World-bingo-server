import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { Telegraf, Markup } from 'telegraf';
import crypto from 'crypto';

dotenv.config();

/* =========================================================
   CONFIG & ENV
========================================================= */

const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const WEBAPP_URL = process.env.WEBAPP_URL || '';
const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);

if (!TELEGRAM_BOT_TOKEN) {
  console.warn("⚠️ Warning: TELEGRAM_BOT_TOKEN is missing in ENV!");
}

/* =========================================================
   FIREBASE ADMIN SETUP
========================================================= */

const serviceAccountVar = process.env.FIREBASE_SERVICE_ACCOUNT;
let serviceAccount = null;

if (serviceAccountVar) {
  try {
    serviceAccount = JSON.parse(serviceAccountVar);
  } catch (err) {
    console.error("❌ Failed to parse FIREBASE_SERVICE_ACCOUNT JSON:", err.message);
  }
}

if (!serviceAccount) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT is required to run this server.");
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL || "https://ethiobingo-default-rtdb.firebaseio.com"
  });
}

const db = admin.database();

/* =========================================================
   EXPRESS & TELEGRAF SETUP
========================================================= */

const app = express();
app.use(cors());
app.use(express.json());

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

/* =========================================================
   ADMIN STATS COMMAND (እዚህ ቦታ ላይ ተስተካክሎ ገብቷል)
========================================================= */

bot.command('stats', async (ctx) => {
  try {
    const uid = `tg_${ctx.from.id}`;

    // አድሚን መሆንህን ያረጋግጣል
    if (!ADMIN_UIDS.includes(uid)) {
      return ctx.reply("❌ ይህ ትእዛዝ ለአድሚን ብቻ የተፈቀደ ነው!");
    }

    // ከ Firebase ዳታቤዝ አጠቃላይ የጨዋታ ክፍሎችን ይፈልጋል
    const snap = await db.ref('rooms').once('value');
    const rooms = snap.val() || {};

    let totalFinished = 0;
    let totalRunning = 0;
    let totalWaiting = 0;

    for (const r of Object.values(rooms)) {
      if (r.state === 'finished') totalFinished++;
      else if (r.state === 'running') totalRunning++;
      else if (r.state === 'waiting') totalWaiting++;
    }

    // የተጠቃሚዎችን አጠቃላይ ብዛት ይቆጥራል
    const usersSnap = await db.ref('users').once('value');
    const totalUsers = usersSnap.exists() ? Object.keys(usersSnap.val()).length : 0;

    ctx.reply(
      `📊 **የ Ethiobingo አጠቃላይ መረጃ**\n\n` +
      `👥 አጠቃላይ ተጫዋቾች፡ ${totalUsers}\n` +
      `🏆 ያለቁ የጨዋታ ዙሮች፡ ${totalFinished}\n` +
      `🎮 አሁን እየተጫወቱ ያሉ፡ ${totalRunning}\n` +
      `⏳ የሚጠብቁ ክፍሎች፡ ${totalWaiting}`
    );

  } catch (e) {
    console.error('stats command error:', e);
    ctx.reply("❌ መረጃውን ከዳታቤዝ በማምጣት ላይ ስህተት አጋጥሟል!");
  }
});

/* =========================================================
   TELEGRAM BOT COMMANDS
========================================================= */

bot.start((ctx) => {
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.webApp('🎮 ጨዋታውን ጀምር (Play Bingo)', WEBAPP_URL)]
  ]);
  ctx.reply('እንኳን ወደ Ethiobingo በደህና መጡ! ጨዋታውን ለመጀመር ከታች ያለውን ቁልፍ ይጫኑ።', keyboard);
});

bot.launch().then(() => {
  console.log('🤖 Telegram Bot started successfully');
}).catch((err) => {
  console.error('❌ Telegram Bot launch error:', err);
});

/* =========================================================
   AUTH & HELPER FUNCTIONS
========================================================= */

function verifyTelegramWebAppData(telegramInitData) {
  try {
    const urlParams = new URLSearchParams(telegramInitData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');

    const paramsSym = Array.from(urlParams.entries())
      .map(([key, val]) => `${key}=${val}`)
      .sort()
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(TELEGRAM_BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac('sha256', secretKey)
      .update(paramsSym)
      .digest('hex');

    if (calculatedHash === hash) {
      const userJSON = urlParams.get('user');
      return userJSON ? JSON.parse(userJSON) : null;
    }
    return null;
  } catch (e) {
    return null;
  }
}

const auth = async (req, res, next) => {
  const initData = req.headers['x-telegram-init-data'];
  if (!initData) {
    return res.status(401).json({ error: 'Unauthorized: Missing Init Data' });
  }

  const tgUser = verifyTelegramWebAppData(initData);
  if (!tgUser) {
    return res.status(401).json({ error: 'Unauthorized: Invalid Init Data' });
  }

  req.uid = `tg_${tgUser.id}`;
  req.tgUser = tgUser;
  next();
};

function num(v) {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

/* =========================================================
   JOIN ROOM ROUTE
========================================================= */

app.post('/join-room', auth, async (req, res) => {
  try {
    const { stake, cardNo } = req.body;
    const roomId = `stake_${stake}_open`;
    const roomRef = db.ref(`rooms/${roomId}`);

    const userRef = db.ref(`users/${req.uid}`);
    const walletTx = await userRef.transaction((user) => {
      if (!user) user = { balance: 0, playWallet: 0 };
      if (num(user.playWallet) < stake) {
        return; // Insufficient balance
      }
      user.playWallet = num(user.playWallet) - stake;
      return user;
    });

    if (!walletTx.committed) {
      const userSnap = await userRef.once('value');
      const user = userSnap.val() || {};
      const b = num(user.playWallet) || 0;
      return res.status(412).json({
        error: `Insufficient balance. You have ${b} ETB; ${stake} ETB is required.`
      });
    }

    const jtx = await roomRef.transaction((room) => {
      room = room || {
        stake,
        state: 'waiting',
        players: {},
        taken: {}
      };

      if (room.state !== 'waiting' || Number(room.stake) !== stake) {
        return;
      }

      room.players = room.players || {};
      room.taken = room.taken || {};

      if (room.players[req.uid]) {
        return;
      }

      if (room.taken[String(cardNo)]) {
        return;
      }

      room.players[req.uid] = {
        cartelaNumber: cardNo,
        joinedAt: Date.now()
      };

      room.taken[String(cardNo)] = true;

      if (!room.countdownEndsAt) {
        room.countdownEndsAt = Date.now() + (process.env.CARTELA_SELECTION_SECONDS || 30) * 1000;
      }

      return room;
    });

    if (!jtx.committed) {
      // Refund balance if room reservation failed
      await userRef.child('playWallet').transaction((curr) => num(curr) + stake);
      return res.status(409).json({
        error: 'Cartela is already taken or the room has started.'
      });
    }

    const room = jtx.snapshot.val();
    const userSnap = await db.ref(`users/${req.uid}`).once('value');
    const user = userSnap.val() || {};

    res.json({
      roomId,
      playerCount: Object.keys(room.players || {}).length,
      countdownEndsAt: room.countdownEndsAt,
      yourCard: cardNo,
      balance: num(user.balance) || 0,
      playWallet: num(user.playWallet) || 0
    });

  } catch (e) {
    console.error('join-room error:', e);
    res.status(500).json({
      error: e.message || 'Could not join room'
    });
  }
});

/* =========================================================
   CLAIM BINGO ROUTE
========================================================= */

app.post('/claim-bingo', auth, async (req, res) => {
  try {
    const roomId = String(req.body.roomId || '');

    if (!/^stake_(10|20|50|100)_open$/.test(roomId)) {
      return res.status(400).json({ error: 'Invalid room' });
    }

    const roomRef = db.ref(`rooms/${roomId}`);
    const snap = await roomRef.once('value');
    const room = snap.val();

    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    if (room.state !== 'running') {
      return res.status(400).json({ error: 'Game is not running' });
    }

    // Process Bingo Claim Logic
    res.json({ success: true, message: 'Bingo claim received' });

  } catch (e) {
    console.error('claim-bingo error:', e);
    res.status(500).json({ error: e.message || 'Error processing claim' });
  }
});

/* =========================================================
   SERVER START
========================================================= */

app.get('/', (req, res) => {
  res.send('Ethiobingo Server is running smoothly!');
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
