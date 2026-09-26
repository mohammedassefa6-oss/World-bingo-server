const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const admin = require('firebase-admin');
const { getCard, hasBingo, letterFor } = require('./cartela');
const createBot = require('./telegramBot');

const serviceAccountJson = Buffer.from(
  process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '',
  'base64'
).toString('utf8');

if (!serviceAccountJson) {
  throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 is not set');
}

const serviceAccount = JSON.parse(serviceAccountJson);

if (!process.env.FIREBASE_DATABASE_URL) {
  throw new Error('FIREBASE_DATABASE_URL is not set');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.database();

const app = express();

app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

const BOT_USERNAME = String(
  process.env.TELEGRAM_BOT_USERNAME || ''
).replace(/^@/, '');

const MINI_APP_LINK_BASE = String(
  process.env.TELEGRAM_MINI_APP_LINK_BASE || ''
);

const ADMIN_UIDS = String(
  process.env.ADMIN_UIDS || ''
)
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

const HOUSE_CUT = Math.min(
  Math.max(Number(process.env.HOUSE_CUT || 0.20), 0),
  1
);

const CALL_INTERVAL_MS = Math.max(
  Number(process.env.CALL_INTERVAL_MS || 3000),
  1000
);

const CARTELA_SELECTION_SECONDS = Math.max(
  Number(process.env.CARTELA_SELECTION_SECONDS || 45),
  10
);

const ALLOWED_STAKES = new Set([
  10,
  20,
  50,
  100
]);

const DEPOSIT_PHONE = String(
  process.env.DEPOSIT_PHONE || ''
);

const DEPOSIT_ACCOUNT_NAME = String(
  process.env.DEPOSIT_ACCOUNT_NAME || ''
);

const num = v => {
  if (
    v === null ||
    v === undefined ||
    v === ''
  ) {
    return null;
  }

  const n = Number(v);

  return Number.isFinite(n)
    ? n
    : null;
};

const posInt = v => {
  const n = num(v);

  return n !== null &&
    Number.isInteger(n) &&
    n > 0
    ? n
    : null;
};

const money = v => {
  const n = Number(v);

  return Number.isFinite(n) &&
    n > 0 &&
    n <= 1000000
    ? Math.round(n * 100) / 100
    : null;
};


/* =========================================================
   USER / AUTH
========================================================= */

async function profile(uid) {
  if (
    typeof uid !== 'string' ||
    !/^tg_\d+$/.test(uid)
  ) {
    return null;
  }

  const s = await db
    .ref(`users/${uid}`)
    .once('value');

  const p = s.val();

  return p &&
    String(p.telegramId) === uid.slice(3)
    ? p
    : null;
}

async function auth(req, res, next) {
  const h =
    req.headers.authorization || '';

  const token =
    h.startsWith('Bearer ')
      ? h.slice(7)
      : null;

  if (!token) {
    return res.status(401).json({
      error: 'Missing Authorization header'
    });
  }

  try {
    const d =
      await admin.auth().verifyIdToken(token);

    const p =
      await profile(d.uid);

    if (!p) {
      return res.status(403).json({
        error:
          'Telegram user verification required'
      });
    }

    req.uid = d.uid;
    req.profile = p;

    next();

  } catch (e) {
    console.error(
      'auth:',
      e.message
    );

    res.status(401).json({
      error:
        'Invalid or expired token'
    });
  }
}

function adminOnly(req, res, next) {
  auth(req, res, () => {
    if (!ADMIN_UIDS.includes(req.uid)) {
      return res.status(403).json({
        error:
          'Admin access required'
      });
    }

    next();
  });
}

function verifyTelegram(initData) {
  if (!BOT_TOKEN) {
    throw new Error(
      'Bot token not configured'
    );
  }

  const p =
    new URLSearchParams(
      initData || ''
    );

  const hash = p.get('hash');
  const authDate =
    Number(p.get('auth_date'));

  const userValue =
    p.get('user');

  if (
    !hash ||
    !authDate ||
    !userValue
  ) {
    throw new Error(
      'Invalid Telegram WebApp data'
    );
  }

  p.delete('hash');

  const check = [
    ...p.entries()
  ]
    .sort(([a], [b]) =>
      a.localeCompare(b)
    )
    .map(([k, v]) =>
      `${k}=${v}`
    )
    .join('\n');

  const secret =
    crypto
      .createHmac(
        'sha256',
        'WebAppData'
      )
      .update(BOT_TOKEN)
      .digest();

  const computed =
    crypto
      .createHmac(
        'sha256',
        secret
      )
      .update(check)
      .digest('hex');

  const a =
    Buffer.from(computed, 'hex');

  const b =
    Buffer.from(hash, 'hex');

  if (
    a.length !== b.length ||
    !crypto.timingSafeEqual(a, b)
  ) {
    throw new Error(
      'Invalid Telegram signature'
    );
  }

  const age =
    Date.now() / 1000 - authDate;

  if (
    !Number.isFinite(authDate) ||
    age > 300 ||
    age < -30
  ) {
    throw new Error(
      'initData expired, reopen the app'
    );
  }

  let user;

  try {
    user =
      JSON.parse(userValue);
  } catch {
    throw new Error(
      'Invalid Telegram user data'
    );
  }

  if (!user || !user.id) {
    throw new Error(
      'Telegram user is required'
    );
  }

  return {
    user,
    startParam:
      p.get('start_param') || ''
  };
}


/* =========================================================
   HEALTH
========================================================= */

app.get(
  '/health',
  async (req, res) => {
    try {
      const s =
        await db
          .ref('.info/connected')
          .once('value')
          .catch(() => null);

      res.json({
        ok: true,
        service: 'Beteseb Bingo',
        databaseConfigured: true,
        connected:
          s ? s.val() : null
      });

    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message
      });
    }
  }
);


/* =========================================================
   TELEGRAM LOGIN
========================================================= */

app.post(
  '/verify-telegram-login',
  async (req, res) => {
    try {
      const {
        user,
        startParam
      } = verifyTelegram(
        req.body.initData
      );

      const uid =
        `tg_${user.id}`;

      const userRef =
        db.ref(`users/${uid}`);

      const snap =
        await userRef.once('value');

      if (!snap.exists()) {
        const code =
          String(user.id);

        await userRef.set({
          balance: 0,
          playWallet: 0,
          referrals: 0,
          cards: 0,
          name:
            user.first_name ||
            'Player',
          telegramId: user.id,
          referralCode: code,
          createdAt:
            admin.database.ServerValue
              .TIMESTAMP
        });

        await db
          .ref(`referralCodes/${code}`)
          .set(uid);
      } else {
        // Make sure old users have playWallet.
        const existing =
          snap.val() || {};

        if (
          existing.playWallet ===
          undefined ||
          existing.playWallet === null
        ) {
          await userRef
            .child('playWallet')
            .set(0);
        }
      }

      const pSnap =
        await userRef.once('value');

      const p =
        pSnap.val() || {};

      /*
       * Referral is applied once,
       * only for a new user and
       * never to self.
       */
      if (
        !snap.exists() &&
        startParam
      ) {
        const refSnap =
          await db
            .ref(
              `referralCodes/${String(
                startParam
              )}`
            )
            .once('value');

        const refUid =
          refSnap.val();

        if (
          refUid &&
          refUid !== uid
        ) {
          await db
            .ref(
              `users/${refUid}/referrals`
            )
            .transaction(
              v =>
                (Number(v) || 0) + 1
            );

          await userRef.update({
            referredBy: refUid
          });
        }
      }

      const balance =
        num(
          (
            await userRef
              .child('balance')
              .once('value')
          ).val()
        );

      const customToken =
        await admin.auth()
          .createCustomToken(uid);

      res.json({
        customToken,
        uid,
        balance:
          balance === null
            ? 0
            : balance,
        referralCode:
          p.referralCode ||
          String(user.id)
      });

    } catch (e) {
      console.error(
        'verify:',
        e
      );

      res.status(403).json({
        error: e.message
      });
    }
  }
);


/* =========================================================
   PLAY WALLET
========================================================= */

/*
 * IMPORTANT:
 *
 * Main Wallet:
 * users/{uid}/balance
 *
 * Play Wallet:
 * users/{uid}/playWallet
 *
 * Deposit goes to Main Wallet.
 *
 * When a player joins a game:
 *
 * Main Wallet -> Play Wallet
 *
 * This prevents the old bug where the UI was showing
 * a fake Play Wallet based only on room.stake.
 */

async function getPlayWallet(uid) {
  const s =
    await db
      .ref(`users/${uid}/playWallet`)
      .once('value');

  const value =
    num(s.val());

  return value === null
    ? 0
    : value;
}

async function ensureWalletFields(uid) {
  const ref =
    db.ref(`users/${uid}`);

  const snap =
    await ref.once('value');

  const u =
    snap.val() || {};

  const updates = {};

  if (
    u.balance === undefined ||
    u.balance === null
  ) {
    updates.balance = 0;
  }

  if (
    u.playWallet === undefined ||
    u.playWallet === null
  ) {
    updates.playWallet = 0;
  }

  if (Object.keys(updates).length) {
    await ref.update(updates);
  }
}


/*
 * Transfer stake from Main Wallet
 * to Play Wallet atomically.
 */
async function moveMainToPlay(
  uid,
  amount
) {
  const userRef =
    db.ref(`users/${uid}`);

  const tx =
    await userRef.transaction(
      user => {
        user = user || {};

        const balance =
          num(user.balance) || 0;

        const playWallet =
          num(user.playWallet) || 0;

        if (balance < amount) {
          return;
        }

        return {
          ...user,
          balance:
            Math.round(
              (balance - amount) *
              100
            ) / 100,
          playWallet:
            Math.round(
              (playWallet + amount) *
              100
            ) / 100
        };
      }
    );

  return tx;
}


/*
 * Move Play Wallet back to Main Wallet.
 * Used when a room does not start.
 */
async function movePlayToMain(
  uid,
  amount
) {
  const userRef =
    db.ref(`users/${uid}`);

  return userRef.transaction(
    user => {
      user = user || {};

      const balance =
        num(user.balance) || 0;

      const playWallet =
        num(user.playWallet) || 0;

      const move =
        Math.min(
          playWallet,
          amount
        );

      return {
        ...user,
        balance:
          Math.round(
            (balance + move) *
            100
          ) / 100,
        playWallet:
          Math.round(
            (playWallet - move) *
            100
          ) / 100
      };
    }
  );
}


/*
 * Remove the stake from Play Wallet
 * when a game is completed.
 *
 * The stake is already committed to
 * the game at this point.
 */
async function consumePlayWallet(
  uid,
  amount
) {
  const userRef =
    db.ref(`users/${uid}`);

  return userRef.transaction(
    user => {
      user = user || {};

      const balance =
        num(user.balance) || 0;

      const playWallet =
        num(user.playWallet) || 0;

      const remaining =
        Math.max(
          0,
          playWallet - amount
        );

      return {
        ...user,
        balance,
        playWallet:
          Math.round(
            remaining * 100
          ) / 100
      };
    }
  );
}


/* =========================================================
   GAME HISTORY (admin reporting)
========================================================= */

/*
 * Every finished room (won or no-winner) is archived here
 * so admins can see total rounds played and full history,
 * since the live `rooms/{roomId}` node gets reset/reused
 * for the next round.
 */
async function recordGameHistory({
  roomId,
  stake,
  playerCount,
  winners,
  totalPrize,
  winningNumber
}) {
  try {
    const id =
      db.ref('gameHistory').push().key;

    await db
      .ref(`gameHistory/${id}`)
      .set({
        roomId,
        stake: Number(stake) || 0,
        playerCount:
          Number(playerCount) || 0,
        winners: winners || null,
        winnerCount: winners
          ? Object.keys(winners).length
          : 0,
        totalPrize:
          Number(totalPrize) || 0,
        winningNumber:
          winningNumber === undefined
            ? null
            : winningNumber,
        finishedAt:
          admin.database.ServerValue
            .TIMESTAMP
      });

  } catch (e) {
    console.error(
      'recordGameHistory:',
      e.message
    );
  }
}


/* =========================================================
   ACTIVE STAKE
========================================================= */

async function getActiveStake(uid) {
  try {
    for (
      const stake of ALLOWED_STAKES
    ) {
      const s =
        await db
          .ref(
            `rooms/stake_${stake}_open`
          )
          .once('value');

      const r = s.val();

      if (
        r &&
        r.players &&
        r.players[uid] &&
        (
          r.state === 'waiting' ||
          r.state === 'running'
        )
      ) {
        return Number(r.stake) || 0;
      }
    }

    return 0;

  } catch (e) {
    return 0;
  }
}


/* =========================================================
   BALANCE
========================================================= */

app.get(
  '/balance',
  auth,
  async (req, res) => {
    try {
      await ensureWalletFields(
        req.uid
      );

      const userSnap =
        await db
          .ref(`users/${req.uid}`)
          .once('value');

      const user =
        userSnap.val() || {};

      const balance =
        num(user.balance) || 0;

      const playWallet =
        num(user.playWallet) || 0;

      res.json({
        balance,
        playWallet
      });

    } catch (e) {
      console.error(e);

      res.status(500).json({
        error:
          'Could not load balance'
      });
    }
  }
);


/* =========================================================
   PROFILE
========================================================= */

app.get(
  '/profile',
  auth,
  async (req, res) => {
    const p =
      await profile(req.uid);

    res.json({
      name:
        p.name || 'Player',
      telegramId:
        p.telegramId ||
        req.uid.slice(3),
      referrals:
        Number(p.referrals || 0),
      referralCode:
        p.referralCode ||
        req.uid.slice(3),
      balance:
        Number(p.balance || 0)
    });
  }
);


/* =========================================================
   REFERRAL
========================================================= */

app.get(
  '/referral',
  auth,
  async (req, res) => {
    const p =
      await profile(req.uid);

    res.json({
      referralCode:
        p.referralCode ||
        req.uid.slice(3),
      referrals:
        Number(p.referrals || 0),
      botUsername:
        BOT_USERNAME,
      linkBase:
        MINI_APP_LINK_BASE
    });
  }
);


/* =========================================================
   HISTORY
========================================================= */

app.get(
  '/history',
  auth,
  async (req, res) => {
    try {
      const s =
        await db
          .ref(
            `users/${req.uid}/transactions`
          )
          .orderByChild('createdAt')
          .limitToLast(100)
          .once('value');

      const raw =
        s.val() || {};

      const items =
        Object.entries(raw)
          .map(([id, v]) => ({
            id,
            ...v
          }))
          .sort(
            (a, b) =>
              Number(b.createdAt || 0) -
              Number(a.createdAt || 0)
          );

      res.json({
        items
      });

    } catch (e) {
      res.status(500).json({
        error:
          'Could not load history'
      });
    }
  }
);


/* =========================================================
   CONFIG
========================================================= */

app.get(
  '/config',
  (req, res) => {
    res.json({
      houseCut: HOUSE_CUT,
      callIntervalMs:
        CALL_INTERVAL_MS
    });
  }
);


/* =========================================================
   DEPOSIT
========================================================= */

app.get(
  '/deposit-info',
  (req, res) => {
    res.json({
      phone:
        DEPOSIT_PHONE,
      name:
        DEPOSIT_ACCOUNT_NAME
    });
  }
);

app.post(
  '/deposit-request',
  auth,
  async (req, res) => {
    try {
      const amount =
        money(req.body.amount);

      if (amount === null) {
        return res.status(400).json({
          error:
            'Invalid deposit amount'
        });
      }

      const transactionId =
        req.body.transactionId
          ? String(
              req.body.transactionId
            ).slice(0, 100)
          : null;

      const id =
        db
          .ref('moneyRequests')
          .push().key;

      const request = {
        uid: req.uid,
        type: 'deposit',
        amount,
        status: 'pending',
        transactionId,
        createdAt:
          admin.database.ServerValue
            .TIMESTAMP
      };

      const updates = {};

      updates[
        `moneyRequests/${id}`
      ] = request;

      updates[
        `users/${req.uid}/transactions/${id}`
      ] = request;

      await db
        .ref()
        .update(updates);

      res.json({
        requestId: id,
        status: 'pending'
      });

    } catch (e) {
      console.error(e);

      res.status(500).json({
        error:
          'Could not create deposit request'
      });
    }
  }
);


/* =========================================================
   WITHDRAWAL
========================================================= */

app.post(
  '/withdrawal-request',
  auth,
  async (req, res) => {
    try {
      const amount =
        money(req.body.amount);

      if (amount === null) {
        return res.status(400).json({
          error:
            'Invalid withdrawal amount'
        });
      }

      const balRef =
        db.ref(
          `users/${req.uid}/balance`
        );

      const tx =
        await balRef.transaction(
          v => {
            const b = num(v);

            if (
              b === null ||
              b < amount
            ) {
              return;
            }

            return Math.round(
              (b - amount) * 100
            ) / 100;
          }
        );

      if (!tx.committed) {
        return res.status(412).json({
          error:
            'Insufficient balance'
        });
      }

      const id =
        db
          .ref('moneyRequests')
          .push().key;

      const request = {
        uid: req.uid,
        type: 'withdrawal',
        amount,
        status: 'pending',
        createdAt:
          admin.database.ServerValue
            .TIMESTAMP
      };

      const updates = {};

      updates[
        `moneyRequests/${id}`
      ] = request;

      updates[
        `users/${req.uid}/transactions/${id}`
      ] = request;

      try {
        await db
          .ref()
          .update(updates);

      } catch (e) {
        await balRef.transaction(
          v =>
            (num(v) || 0) +
            amount
        );

        throw e;
      }

      res.json({
        requestId: id,
        status: 'pending',
        balance:
          num(tx.snapshot.val()) || 0
      });

    } catch (e) {
      console.error(e);

      res.status(500).json({
        error:
          'Could not create withdrawal request'
      });
    }
  }
);


/* =========================================================
   JOIN ROOM
========================================================= */

app.post(
  '/join-room',
  auth,
  async (req, res) => {
    try {
      const stake =
        posInt(req.body.stake);

      const cardNo =
        posInt(
          req.body.cartelaNumber
        );

      if (
        !ALLOWED_STAKES.has(stake)
      ) {
        return res.status(400).json({
          error:
            'Invalid room stake'
        });
      }

      if (
        cardNo === null ||
        cardNo > 500
      ) {
        return res.status(400).json({
          error:
            'Invalid cartela number'
        });
      }

      const roomId =
        `stake_${stake}_open`;

      const roomRef =
        db.ref(`rooms/${roomId}`);

      /*
       * Play Wallet is the game wallet.
       * Deposits are credited directly to Play Wallet.
       * Joining a room only checks that the stake is available;
       * the stake is consumed when the round finishes.
       */
      await ensureWalletFields(req.uid);
      const playSnap =
        await db.ref(`users/${req.uid}/playWallet`).once('value');
      const playBalance =
        Number(playSnap.val() || 0);

      if (playBalance < stake) {
        return res.status(412).json({
          error:
            `Insufficient Play Wallet. You have ${playBalance} ETB; ${stake} ETB is required.`
        });
      }

      /*
       * Now reserve the cartela in the room.
       */
      const jtx =
        await roomRef.transaction(
          room => {
            room =
              room || {
                stake,
                state: 'waiting',
                players: {},
                taken: {}
              };

            if (
              room.state !== 'waiting' ||
              Number(room.stake) !== stake
            ) {
              return;
            }

            room.players =
              room.players || {};

            room.taken =
              room.taken || {};

            if (
              room.players[req.uid]
            ) {
              return;
            }

            if (
              room.taken[
                String(cardNo)
              ]
            ) {
              return;
            }

            room.players[req.uid] = {
              cartelaNumber: cardNo,
              joinedAt: Date.now()
            };

            room.taken[
              String(cardNo)
            ] = true;

            if (!room.countdownEndsAt) {
              room.countdownEndsAt =
                Date.now() +
                CARTELA_SELECTION_SECONDS *
                  1000;
            }

            return room;
          }
        );

      /*
       * If cartela reservation failed,
       * return the stake from Play Wallet
       * back to Main Wallet.
       */
      if (!jtx.committed) {
        await movePlayToMain(
          req.uid,
          stake
        );

        return res.status(409).json({
          error:
            'Cartela is already taken or the room has started.'
        });
      }

      const room =
        jtx.snapshot.val();

      const userSnap =
        await db
          .ref(`users/${req.uid}`)
          .once('value');

      const user =
        userSnap.val() || {};

      const balance =
        num(user.balance) || 0;

      const playWallet =
        num(user.playWallet) || 0;

      res.json({
        roomId,
        playerCount:
          Object.keys(
            room.players || {}
          ).length,
        countdownEndsAt:
          room.countdownEndsAt,
        yourCard:
          getCard(cardNo),
        balance,
        playWallet
      });

    } catch (e) {
      console.error(
        'join-room:',
        e
      );

      res.status(500).json({
        error:
          e.message ||
          'Could not join room'
      });
    }
  }
);


/* =========================================================
   CLAIM BINGO
========================================================= */

app.post(
  '/claim-bingo',
  auth,
  async (req, res) => {
    try {
      const roomId =
        String(
          req.body.roomId || ''
        );

      if (
        !/^stake_(10|20|50|100)_open$/
          .test(roomId)
      ) {
        return res.status(400).json({
          error:
            'Invalid room'
        });
      }

      const roomRef =
        db.ref(`rooms/${roomId}`);

      const snap =
        await roomRef.once('value');

      const room =
        snap.val();

      if (!room) {
        return res.status(404).json({
          error:
            'Room not found'
        });
      }

      if (
        room.state !== 'running'
      ) {
        return res.status(412).json({
          error:
            'Room not active'
        });
      }

      const player =
        room.players &&
        room.players[req.uid];

      if (!player) {
        return res.status(403).json({
          error:
            'You are not in this room'
        });
      }

      const called =
        new Set(
          Object.keys(
            room.calledNumbers || {}
          ).map(Number)
        );

      if (
        !hasBingo(
          player.cartelaNumber,
          called
        )
      ) {
        return res.status(412).json({
          error:
            'No BINGO on your card yet'
        });
      }

      const count =
        Object.keys(
          room.players || {}
        ).length;

      const gross =
        Number(room.stake) *
        count;

      const prize =
        Math.floor(
          gross *
          (1 - HOUSE_CUT)
        );

      const claimTx =
        await roomRef.transaction(
          r => {
            if (
              !r ||
              r.state !== 'running' ||
              !r.players ||
              !r.players[req.uid]
            ) {
              return;
            }

            return {
              ...r,
              state: 'finished',
              winners: {
                [req.uid]: {
                  cartelaNumber:
                    player.cartelaNumber,
                  prize
                }
              },
              winningNumber:
                room.lastCalled,
              payoutStatus:
                'pending',
              finishedAt:
                Date.now()
            };
          }
        );

      if (!claimTx.committed) {
        return res.status(409).json({
          error:
            'This round has already been claimed.'
        });
      }

      /*
       * Consume the player's stake
       * from Play Wallet.
       */
      await consumePlayWallet(
        req.uid,
        Number(room.stake)
      );

      /*
       * Send the prize to Main Wallet.
       */
      const payoutRef =
        db.ref(
          `users/${req.uid}/balance`
        );

      await payoutRef.transaction(
        v =>
          (num(v) || 0) +
          prize
      );

      await roomRef.update({
        payoutStatus: 'paid'
      });

      const txId =
        db
          .ref(
            `users/${req.uid}/transactions`
          )
          .push().key;

      await db
        .ref(
          `users/${req.uid}/transactions/${txId}`
        )
        .set({
          type: 'win',
          amount: prize,
          roomId,
          status: 'completed',
          createdAt:
            admin.database.ServerValue
              .TIMESTAMP
        });

      /*
       * Archive this finished round so
       * admins can see it in game history.
       */
      await recordGameHistory({
        roomId,
        stake: room.stake,
        playerCount: count,
        winners: {
          [req.uid]: {
            cartelaNumber:
              player.cartelaNumber,
            prize
          }
        },
        totalPrize: prize,
        winningNumber:
          room.lastCalled
      });

      const finalBalance =
        num(
          (
            await payoutRef.once('value')
          ).val()
        ) || 0;

      res.json({
        won: true,
        prize,
        balance: finalBalance,
        playWallet:
          await getPlayWallet(req.uid)
      });

    } catch (e) {
      console.error(
        'claim:',
        e
      );

      res.status(500).json({
        error:
          'Could not process BINGO payout'
      });
    }
  }
);


/* =========================================================
   ADMIN MONEY REQUESTS
========================================================= */

app.get(
  '/admin/money-requests',
  adminOnly,
  async (req, res) => {
    try {
      const s =
        await db
          .ref('moneyRequests')
          .orderByChild('createdAt')
          .limitToLast(100)
          .once('value');

      const raw =
        s.val() || {};

      const items =
        Object.entries(raw)
          .map(([id, v]) => ({
            id,
            ...v
          }))
          .sort(
            (a, b) =>
              Number(b.createdAt || 0) -
              Number(a.createdAt || 0)
          );

      res.json({
        items
      });

    } catch (e) {
      res.status(500).json({
        error:
          'Could not load requests'
      });
    }
  }
);


/* =========================================================
   PROCESS MONEY REQUEST
========================================================= */

async function processMoney(
  req,
  res,
  type,
  status
) {
  try {
    const id =
      String(
        req.params.id || ''
      );

    const rRef =
      db.ref(
        `moneyRequests/${id}`
      );

    const snap =
      await rRef.once('value');

    const r =
      snap.val();

    if (!r) {
      return res.status(404).json({
        error:
          'Request not found'
      });
    }

    if (r.type !== type) {
      return res.status(400).json({
        error:
          'Wrong request type'
      });
    }

    if (r.status !== 'pending') {
      return res.status(409).json({
        error:
          'Request already processed'
      });
    }

    /*
     * Deposit approval:
     * add money directly to PLAY WALLET.
     */
    if (
      type === 'deposit' &&
      status === 'approved'
    ) {
      await db
        .ref(
          `users/${r.uid}/playWallet`
        )
        .transaction(
          v =>
            (num(v) || 0) +
            Number(r.amount)
        );
    }

    /*
     * Withdrawal rejection:
     * return money to MAIN WALLET.
     */
    if (
      type === 'withdrawal' &&
      status === 'rejected'
    ) {
      await db
        .ref(
          `users/${r.uid}/balance`
        )
        .transaction(
          v =>
            (num(v) || 0) +
            Number(r.amount)
        );
    }

    const now =
      admin.database.ServerValue
        .TIMESTAMP;

    const updates = {};

    updates[
      `moneyRequests/${id}/status`
    ] = status;

    updates[
      `moneyRequests/${id}/processedAt`
    ] = now;

    updates[
      `moneyRequests/${id}/processedBy`
    ] = req.uid;

    updates[
      `users/${r.uid}/transactions/${id}/status`
    ] = status;

    updates[
      `users/${r.uid}/transactions/${id}/processedAt`
    ] = now;

    updates[
      `users/${r.uid}/transactions/${id}/processedBy`
    ] = req.uid;

    await db
      .ref()
      .update(updates);

    const finalBalance =
      num(
        (
          await db
            .ref(
              `users/${r.uid}/balance`
            )
            .once('value')
        ).val()
      ) || 0;

    res.json({
      ok: true,
      status,
      balance: finalBalance
    });

    const verb =
      status === 'approved'
        ? 'Approved'
        : 'Rejected';

    const icon =
      status === 'approved'
        ? '✅'
        : '❌';

    const label =
      type === 'deposit'
        ? 'deposit'
        : 'withdrawal';

    bot
      .notifyUser(
        r.uid,
        `${icon} Your ${label} of ${r.amount} ETB is ${verb}.\nRef: ${id}`
      )
      .catch(() => {});

  } catch (e) {
    console.error(e);

    res.status(500).json({
      error:
        'Could not process request'
    });
  }
}

app.post(
  '/admin/deposit/:id/approve',
  adminOnly,
  (req, res) =>
    processMoney(
      req,
      res,
      'deposit',
      'approved'
    )
);

app.post(
  '/admin/deposit/:id/reject',
  adminOnly,
  (req, res) =>
    processMoney(
      req,
      res,
      'deposit',
      'rejected'
    )
);

app.post(
  '/admin/withdrawal/:id/approve',
  adminOnly,
  (req, res) =>
    processMoney(
      req,
      res,
      'withdrawal',
      'approved'
    )
);

app.post(
  '/admin/withdrawal/:id/reject',
  adminOnly,
  (req, res) =>
    processMoney(
      req,
      res,
      'withdrawal',
      'rejected'
    )
);


/* =========================================================
   ADMIN GAME HISTORY
========================================================= */

/*
 * Full list of finished games (rounds), newest first.
 * Query params:
 *   ?limit=100   (max 500, default 100)
 *   ?stake=50    (optional filter, one of 10/20/50/100)
 */
app.get(
  '/admin/game-history',
  adminOnly,
  async (req, res) => {
    try {
      const limit =
        Math.min(
          posInt(req.query.limit) ||
            100,
          500
        );

      const s =
        await db
          .ref('gameHistory')
          .orderByChild('finishedAt')
          .limitToLast(limit)
          .once('value');

      const raw =
        s.val() || {};

      let items =
        Object.entries(raw)
          .map(([id, v]) => ({
            id,
            ...v
          }))
          .sort(
            (a, b) =>
              Number(b.finishedAt || 0) -
              Number(a.finishedAt || 0)
          );

      const stakeFilter =
        posInt(req.query.stake);

      if (
        stakeFilter &&
        ALLOWED_STAKES.has(
          stakeFilter
        )
      ) {
        items = items.filter(
          g =>
            Number(g.stake) ===
            stakeFilter
        );
      }

      res.json({
        items,
        count: items.length
      });

    } catch (e) {
      console.error(e);

      res.status(500).json({
        error:
          'Could not load game history'
      });
    }
  }
);


/*
 * Summary numbers for the admin dashboard:
 * total rounds played, total players served,
 * total prize money paid out, and a breakdown
 * of how many rounds were played per stake.
 */
app.get(
  '/admin/stats',
  adminOnly,
  async (req, res) => {
    try {
      const s =
        await db
          .ref('gameHistory')
          .once('value');

      const raw =
        s.val() || {};

      const items =
        Object.values(raw);

      const totalGames =
        items.length;

      const totalPlayers =
        items.reduce(
          (sum, g) =>
            sum +
            (Number(g.playerCount) ||
              0),
          0
        );

      const totalPrizePaid =
        items.reduce(
          (sum, g) =>
            sum +
            (Number(g.totalPrize) ||
              0),
          0
        );

      const byStake = {};

      for (const g of items) {
        const key =
          String(g.stake || 'unknown');

        byStake[key] =
          (byStake[key] || 0) + 1;
      }

      res.json({
        totalGames,
        totalPlayers,
        totalPrizePaid,
        byStake
      });

    } catch (e) {
      console.error(e);

      res.status(500).json({
        error:
          'Could not load stats'
      });
    }
  }
);


/* =========================================================
   ADVANCE RUNNING GAMES
========================================================= */

async function advanceAllRooms() {
  try {
    const s =
      await db
        .ref('rooms')
        .orderByChild('state')
        .equalTo('running')
        .once('value');

    const rooms =
      s.val() || {};

    for (
      const [roomId, room]
      of Object.entries(rooms)
    ) {
      const called =
        new Set(
          Object.keys(
            room.calledNumbers || {}
          ).map(Number)
        );

      const remaining = [];

      for (
        let n = 1;
        n <= 75;
        n++
      ) {
        if (!called.has(n)) {
          remaining.push(n);
        }
      }

      /*
       * No numbers left.
       *
       * Clear Play Wallet for players
       * because the round is finished.
       *
       * No prize is created here.
       */
      if (!remaining.length) {
        const players =
          room.players || {};

        for (
          const [uid, player]
          of Object.entries(players)
        ) {
          await consumePlayWallet(
            uid,
            Number(room.stake)
          );
        }

        await db
          .ref(
            `rooms/${roomId}/state`
          )
          .set('finished');

        /*
         * Archive this round even though
         * nobody won, so the total round
         * count stays accurate.
         */
        await recordGameHistory({
          roomId,
          stake: room.stake,
          playerCount:
            Object.keys(players).length,
          winners: null,
          totalPrize: 0,
          winningNumber:
            room.lastCalled
        });

        continue;
      }

      const next =
        remaining[
          Math.floor(
            Math.random() *
            remaining.length
          )
        ];

      await db
        .ref(
          `rooms/${roomId}/calledNumbers/${next}`
        )
        .set(true);

      await db
        .ref(
          `rooms/${roomId}/lastCalled`
        )
        .set(next);

      called.add(next);

      const players =
        room.players || {};

      const winners =
        Object.entries(players)
          .filter(
            ([uid, p]) =>
              hasBingo(
                p.cartelaNumber,
                called
              )
          );

      if (winners.length) {
        const count =
          Object.keys(players).length;

        const gross =
          Number(room.stake) *
          count;

        const totalPrize =
          Math.floor(
            gross *
            (1 - HOUSE_CUT)
          );

        const share =
          Math.floor(
            totalPrize /
            winners.length
          );

        const roomRef =
          db.ref(
            `rooms/${roomId}`
          );

        const finishTx =
          await roomRef.transaction(
            r => {
              if (
                !r ||
                r.state !== 'running'
              ) {
                return;
              }

              const winnersObj = {};

              for (
                const [uid, p]
                of winners
              ) {
                winnersObj[uid] = {
                  cartelaNumber:
                    p.cartelaNumber,
                  prize: share
                };
              }

              return {
                ...r,
                state: 'finished',
                winners:
                  winnersObj,
                winningNumber:
                  next,
                payoutStatus:
                  'pending',
                finishedAt:
                  Date.now()
              };
            }
          );

        if (finishTx.committed) {
          const winnersObj = {};

          /*
           * Remove the game stake from
           * Play Wallet and send the prize
           * to Main Wallet.
           */
          for (
            const [uid, p]
            of winners
          ) {
            await consumePlayWallet(
              uid,
              Number(room.stake)
            );

            await db
              .ref(
                `users/${uid}/balance`
              )
              .transaction(
                v =>
                  (num(v) || 0) +
                  share
              );

            const txId =
              db
                .ref(
                  `users/${uid}/transactions`
                )
                .push().key;

            await db
              .ref(
                `users/${uid}/transactions/${txId}`
              )
              .set({
                type: 'win',
                amount: share,
                roomId,
                status: 'completed',
                createdAt:
                  admin.database.ServerValue
                    .TIMESTAMP
              });

            winnersObj[uid] = {
              cartelaNumber:
                p.cartelaNumber,
              prize: share
            };
          }

          /*
           * Players who did not win also
           * finish their Play Wallet stake.
           */
          for (
            const [uid]
            of Object.entries(players)
          ) {
            if (
              !winners.some(
                ([winnerUid]) =>
                  winnerUid === uid
              )
            ) {
              await consumePlayWallet(
                uid,
                Number(room.stake)
              );
            }
          }

          await roomRef.update({
            payoutStatus: 'paid'
          });

          /*
           * Archive this round with its
           * winner(s) and total prize paid.
           */
          await recordGameHistory({
            roomId,
            stake: room.stake,
            playerCount: count,
            winners: winnersObj,
            totalPrize,
            winningNumber: next
          });
        }
      }
    }

  } catch (e) {
    console.error(
      'advanceAllRooms:',
      e.message
    );
  }
}

setInterval(
  advanceAllRooms,
  CALL_INTERVAL_MS
);


/* =========================================================
   WAITING ROOM TIMER
========================================================= */

async function tickWaitingRooms() {
  try {
    const s =
      await db
        .ref('rooms')
        .orderByChild('state')
        .equalTo('waiting')
        .once('value');

    const rooms =
      s.val() || {};

    const now =
      Date.now();

    for (
      const [roomId, room]
      of Object.entries(rooms)
    ) {
      if (
        !room.countdownEndsAt ||
        room.countdownEndsAt > now
      ) {
        continue;
      }

      const roomRef =
        db.ref(
          `rooms/${roomId}`
        );

      const players =
        room.players || {};

      const count =
        Object.keys(players).length;

      /*
       * Two or more players:
       * start the game.
       */
      if (count >= 2) {
        await roomRef.transaction(
          r => {
            if (
              !r ||
              r.state !== 'waiting'
            ) {
              return;
            }

            return {
              ...r,
              state: 'running',
              startedAt: Date.now(),
              calledNumbers: {}
            };
          }
        );

      } else {
        /*
         * Only one player:
         *
         * Return the stake from
         * Play Wallet to Main Wallet.
         *
         * This fixes the old wallet bug.
         */
        for (
          const uid
          of Object.keys(players)
        ) {
          await movePlayToMain(
            uid,
            Number(room.stake)
          );
        }

        await roomRef.set({
          stake: room.stake,
          state: 'waiting',
          players: {},
          taken: {}
        });
      }
    }

  } catch (e) {
    console.error(
      'tickWaitingRooms:',
      e.message
    );
  }
}

setInterval(
  tickWaitingRooms,
  2000
);


/* =========================================================
   FRONTEND FALLBACK
========================================================= */

app.get(
  '*',
  (req, res) =>
    res.sendFile(
      path.join(
        __dirname,
        'public',
        'index.html'
      )
    )
);


/* =========================================================
   TELEGRAM BOT
========================================================= */

const bot =
  createBot(
    db,
    admin
  );

const WEBHOOK_SECRET =
  process.env.TELEGRAM_WEBHOOK_SECRET ||
  '';

app.post(
  '/telegram/webhook',
  (req, res) => {
    if (WEBHOOK_SECRET) {
      const got =
        req.headers[
          'x-telegram-bot-api-secret-token'
        ];

      if (
        got !== WEBHOOK_SECRET
      ) {
        return res.sendStatus(401);
      }
    }

    res.sendStatus(200);

    bot
      .handleUpdate(req.body)
      .catch(
        e =>
          console.error(
            'handleUpdate:',
            e
          )
      );
  }
);


/* =========================================================
   SERVER
========================================================= */

const PORT =
  Number(
    process.env.PORT || 3000
  );

app.listen(
  PORT,
  async () => {
    console.log(
      `Beteseb Bingo listening on ${PORT}; Firebase project=${serviceAccount.project_id}`
    );

    const publicUrl =
      process.env.PUBLIC_URL ||
      (
        process.env.RAILWAY_PUBLIC_DOMAIN
          ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
          : ''
      );

    if (publicUrl) {
      await bot.setWebhook(
        publicUrl,
        WEBHOOK_SECRET
      );
    } else {
      console.warn(
        'PUBLIC_URL not set — call setWebhook manually or set PUBLIC_URL / rely on RAILWAY_PUBLIC_DOMAIN.'
      );
    }

    await bot
      .setCommands()
      .catch(
        e =>
          console.error(
            'setCommands failed:',
            e.message
          )
      );
  }
);
