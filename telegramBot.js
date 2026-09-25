// telegramBot.js — Beteseb Bingo Telegram bot + Mini App integration.
// Main menu runs inside Telegram chat.
// The Play button opens the Bingo Mini App.
// Register, Balance, Deposit, Withdraw, Transfer, Invite, Support,
// Instructions and Convert Bonus remain available inside Telegram chat.

const crypto = require('crypto');
const { getCard, hasBingo, letterFor } = require('./cartela');
const telebirr = require('./telebirr');
const telebirrC2B = require('./telebirrC2B');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ============================================================
// ADMIN / TELEBIRR
// ============================================================

const ADMIN_CHAT_ID =
  String(process.env.ADMIN_CHAT_ID || '').trim();

const TELEBIRR_NUMBER =
  String(process.env.TELEBIRR_NUMBER || '').trim();

const ALLOWED_STAKES = [10, 20, 50, 100];

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

const MAX_CARTELA = 500;
const CARDS_PER_PAGE = 96;

const SUPPORT_CONTACT =
  process.env.SUPPORT_CONTACT || '@BetesebSupport';

const BOT_USERNAME = String(
  process.env.TELEGRAM_BOT_USERNAME || ''
).replace(/^@/, '');

const SIGNUP_BONUS = Number(
  process.env.SIGNUP_BONUS || 0
);

const REFERRAL_BONUS = Number(
  process.env.REFERRAL_BONUS || 0
);


// ============================================================
// MINI APP URL
// ============================================================

const MINI_APP_URL = String(
  process.env.TELEGRAM_MINI_APP_LINK_BASE ||
  process.env.PUBLIC_URL ||
  (
    process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : 'https://world-bingo-server-production-e1c2.up.railway.app/'
  )
).trim().replace(/\/$/, '');


// ============================================================
// MAIN MENU
// ============================================================

const MENU_TEXT = {
  play: '🎮 Play',
  register: '📝 Register',
  balance: '💰 Check Balance',
  deposit: '💵 Deposit',
  support: '☎️ Contact Support',
  instruction: '📖 Instruction',
  transfer: '🎁 Transfer',
  withdraw: '🤑 Withdraw',
  invite: '🔗 Invite',
  bonus: '🎉 Convert Bonus',
};


function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: MENU_TEXT.play,
          web_app: {
            url: MINI_APP_URL
          }
        },
        {
          text: MENU_TEXT.register,
          callback_data: 'menu:register'
        }
      ],

      [
        {
          text: MENU_TEXT.balance,
          callback_data: 'menu:balance'
        },
        {
          text: MENU_TEXT.deposit,
          callback_data: 'menu:deposit'
        }
      ],

      [
        {
          text: MENU_TEXT.support,
          callback_data: 'menu:support'
        },
        {
          text: MENU_TEXT.instruction,
          callback_data: 'menu:instruction'
        }
      ],

      [
        {
          text: MENU_TEXT.transfer,
          callback_data: 'menu:transfer'
        },
        {
          text: MENU_TEXT.withdraw,
          callback_data: 'menu:withdraw'
        }
      ],

      [
        {
          text: MENU_TEXT.invite,
          callback_data: 'menu:invite'
        },
        {
          text: MENU_TEXT.bonus,
          callback_data: 'menu:bonus'
        }
      ]
    ]
  };
}


// ============================================================
// SESSION
// ============================================================

const sessions = new Map();

function getSession(chatId) {
  return sessions.get(chatId) || {};
}

function setSession(chatId, patch) {
  sessions.set(chatId, {
    ...getSession(chatId),
    ...patch
  });
}

function clearSession(chatId) {
  sessions.delete(chatId);
}


// ============================================================
// TELEGRAM API
// ============================================================

function tgCall(method, body) {
  return fetch(`${API}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
    .then(r => r.json())
    .catch(e => {
      console.error(`tg ${method} failed:`, e.message);
      return null;
    });
}


const sendMessage = (chatId, text, extra = {}) =>
  tgCall('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...extra
  });


const editMessage = (
  chatId,
  messageId,
  text,
  extra = {}
) =>
  tgCall('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    ...extra
  });


const answerCallback = (
  id,
  text,
  alert = false
) =>
  tgCall('answerCallbackQuery', {
    callback_query_id: id,
    text,
    show_alert: alert
  });


// ============================================================
// BOT
// ============================================================

module.exports = function createBot(db, admin) {

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


  const money = v => {
    const n = Number(v);

    return Number.isFinite(n) &&
      n > 0 &&
      n <= 1000000
      ? Math.round(n * 100) / 100
      : null;
  };


  // ==========================================================
  // USER
  // ==========================================================

  async function getOrCreateUser(from) {

    const uid = `tg_${from.id}`;

    const ref = db.ref(`users/${uid}`);

    const snap = await ref.once('value');

    if (!snap.exists()) {

      const code = String(from.id);

      await ref.set({
        balance: 0,
        bonus: SIGNUP_BONUS || 0,
        referrals: 0,
        cards: 0,

        name: from.first_name || 'Player',

        telegramId: from.id,
        username: from.username || '',

        referralCode: code,

        registered: false,

        createdAt:
          admin.database.ServerValue.TIMESTAMP
      });

      await db
        .ref(`referralCodes/${code}`)
        .set(uid);

      return (
        await ref.once('value')
      ).val();
    }

    return snap.val();
  }


  // ==========================================================
  // REFERRAL
  // ==========================================================

  async function applyReferral(uid, startParam) {

    if (!startParam) {
      return;
    }

    const refSnap = await db
      .ref(`referralCodes/${String(startParam)}`)
      .once('value');

    const refUid = refSnap.val();

    if (!refUid || refUid === uid) {
      return;
    }

    const already = (
      await db
        .ref(`users/${uid}/referredBy`)
        .once('value')
    ).val();

    if (already) {
      return;
    }

    await db
      .ref(`users/${refUid}/referrals`)
      .transaction(
        v => (Number(v) || 0) + 1
      );

    if (REFERRAL_BONUS) {

      await db
        .ref(`users/${refUid}/bonus`)
        .transaction(
          v =>
            (Number(v) || 0) +
            REFERRAL_BONUS
        );
    }

    await db
      .ref(`users/${uid}`)
      .update({
        referredBy: refUid
      });
  }


  // ==========================================================
  // REGISTER
  // ==========================================================

  async function handleRegister(
    chatId,
    uid,
    contact
  ) {

    if (contact) {

      await db
        .ref(`users/${uid}`)
        .update({
          phone: contact.phone_number,
          registered: true
        });

      setSession(chatId, {
        awaiting: null
      });

      await sendMessage(
        chatId,
        '✅ Registration complete! Your phone number is saved.',
        {
          reply_markup:
            mainMenuKeyboard()
        }
      );

      return;
    }

    setSession(chatId, {
      awaiting: 'register_contact'
    });

    await sendMessage(
      chatId,
      '📱 Please share your phone number to complete registration.',
      {
        reply_markup: {
          keyboard: [
            [
              {
                text:
                  '📲 Share phone number',
                request_contact: true
              }
            ]
          ],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      }
    );
  }


  // ==========================================================
  // BALANCE
  // ==========================================================

  async function getActiveStake(uid) {

    for (const stake of ALLOWED_STAKES) {

      const s = await db
        .ref(`rooms/stake_${stake}_open`)
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
  }


  async function handleBalance(
    chatId,
    uid
  ) {

    const s = await db
      .ref(`users/${uid}`)
      .once('value');

    const u = s.val() || {};

    const playWallet =
      await getActiveStake(uid);

    await sendMessage(
      chatId,

      `💰 <b>Main Wallet:</b> ${Number(
        u.balance || 0
      )} ETB\n` +

      `🎮 <b>Play Wallet:</b> ${playWallet} ETB\n` +

      `🎁 <b>Bonus:</b> ${Number(
        u.bonus || 0
      )} ETB`,

      {
        reply_markup:
          mainMenuKeyboard()
      }
    );
  }


  // ==========================================================
  // INSTRUCTION
  // ==========================================================

  async function handleInstruction(chatId) {

    await sendMessage(
      chatId,

      '📖 <b>እንዴት ይጫወቱ</b>\n' +

      '1️⃣ "🎮 Play" ተጫን\n' +

      '2️⃣ Stake (10/20/50/100 ETB) ምረጥ\n' +

      '3️⃣ የፈለከውን cartela ቁጥር ምረጥ\n' +

      '4️⃣ ቁጥሮች ሲጠሩ ካርድህ ላይ ራሱ ይምረቃል\n' +

      '5️⃣ Bingo ስትሰራ "🏆 BINGO" ን ተጫን\n\n' +

      '💵 Deposit/Withdraw ከ menu በኩል በቀላሉ ይላካል፣ ማረጋገጫ ከ admin በኋላ ይጠናቀቃል።',

      {
        reply_markup:
          mainMenuKeyboard()
      }
    );
  }


  // ==========================================================
  // SUPPORT
  // ==========================================================

  async function handleSupport(chatId) {

    await sendMessage(
      chatId,

      `☎️ <b>Contact Support</b>\nማንኛውም ጥያቄ ካለህ ወደ ${SUPPORT_CONTACT} መልእክት ላክ።`,

      {
        reply_markup:
          mainMenuKeyboard()
      }
    );
  }


  // ==========================================================
  // INVITE
  // ==========================================================

  async function handleInvite(
    chatId,
    uid
  ) {

    const s = await db
      .ref(`users/${uid}`)
      .once('value');

    const u = s.val() || {};

    const code =
      u.referralCode ||
      String(u.telegramId || '');

    const link =
      BOT_USERNAME
        ? `https://t.me/${BOT_USERNAME}?start=${encodeURIComponent(code)}`
        : null;

    await sendMessage(
      chatId,

      link
        ? `🔗 <b>Invitation Link</b>\n${link}\n\n👥 Referrals: ${Number(u.referrals || 0)}`
        : `🔗 Your referral code: <code>${code}</code>\n(Set TELEGRAM_BOT_USERNAME to get a shareable link)\n👥 Referrals: ${Number(u.referrals || 0)}`,

      {
        reply_markup:
          mainMenuKeyboard()
      }
    );
  }


  // ==========================================================
  // BONUS
  // ==========================================================

  async function handleConvertBonus(
    chatId,
    uid
  ) {

    const bonusRef =
      db.ref(`users/${uid}/bonus`);

    const snap =
      await bonusRef.once('value');

    const bonus =
      Number(snap.val() || 0);

    if (bonus <= 0) {

      await sendMessage(
        chatId,
        '🎉 No bonus available to convert right now.',
        {
          reply_markup:
            mainMenuKeyboard()
        }
      );

      return;
    }

    const tx =
      await bonusRef.transaction(
        v => 0
      );

    if (!tx.committed) {

      await sendMessage(
        chatId,
        '⚠️ Could not convert bonus, try again.',
        {
          reply_markup:
            mainMenuKeyboard()
        }
      );

      return;
    }

    await db
      .ref(`users/${uid}/balance`)
      .transaction(
        v =>
          Math.round(
            (
              (Number(v) || 0) +
              bonus
            ) * 100
          ) / 100
      );

    await sendMessage(
      chatId,
      `🎉 Converted ${bonus} ETB bonus into your balance!`,
      {
        reply_markup:
          mainMenuKeyboard()
      }
    );
  }


  // ==========================================================
  // DEPOSIT
  // ==========================================================

  async function startDeposit(chatId) {

    setSession(chatId, {
      awaiting: 'deposit_amount'
    });

    const numberText =
      TELEBIRR_NUMBER
        ? `\n\n📲 <b>Telebirr Number:</b> <code>${TELEBIRR_NUMBER}</code>`
        : '\n\n⚠️ Telebirr number is not configured.';

    await sendMessage(
      chatId,

      `💵 <b>Deposit</b>${numberText}\n\n` +
      'የምትያስገባውን መጠን በETB ላክ።\n' +
      'ለምሳሌ: <code>100</code>',

      {
        reply_markup: {
          remove_keyboard: true
        }
      }
    );
  }


  async function finishDeposit(
    chatId,
    uid,
    text
  ) {

    const amount = money(text);

    if (amount === null) {

      await sendMessage(
        chatId,
        '⚠️ Invalid amount, please enter a number, e.g. 100'
      );

      return;
    }

    // ========================================================
    // If Telebirr C2B checkout is configured, skip the manual
    // "send to this number + paste transaction ID" flow entirely
    // and create a real Telebirr order with a checkout link.
    // ========================================================
    if (telebirrC2B.configured) {
      return startTelebirrCheckout(chatId, uid, amount);
    }

    const numberText =
      TELEBIRR_NUMBER
        ? `<b>Telebirr Number:</b> <code>${TELEBIRR_NUMBER}</code>`
        : '⚠️ Telebirr number is not configured.';

    setSession(chatId, {
      awaiting: 'deposit_txn_id',
      depositAmount: amount
    });

    await sendMessage(
      chatId,

      `💵 <b>Deposit ${amount} ETB</b>\n\n` +
      `📲 ${numberText}\n\n` +
      `1️⃣ ${amount} ETB ወደ ከላይ ያለው Telebirr ቁጥር ላክ።\n` +
      `2️⃣ ክፍያውን ከፈጸምክ በኋላ <b>Telebirr Transaction ID</b> እዚህ ላክ።\n\n` +
      `ℹ️ Transaction ID ካልተረጋገጠ ለAdmin በmanual approval ይላካል።`
    );
  }


  // ==========================================================
  // TELEBIRR C2B CHECKOUT (automatic, in-chat)
  // ==========================================================

  async function startTelebirrCheckout(chatId, uid, amount) {

    clearSession(chatId);

    await sendMessage(
      chatId,
      '🔎 Telebirr checkout link በመፍጠር ላይ...'
    );

    const requestId =
      db.ref('moneyRequests').push().key;

    const merchantOrderId =
      `TB${Date.now()}` +
      `${String(uid).replace(/\D/g, '').slice(-10)}` +
      `${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    const request = {
      uid,
      type: 'deposit',
      amount,
      status: 'pending',
      transactionId: merchantOrderId,
      paymentMethod: 'telebirr_c2b',
      createdAt: admin.database.ServerValue.TIMESTAMP
    };

    await db.ref().update({
      [`moneyRequests/${requestId}`]: request,
      [`users/${uid}/transactions/${requestId}`]: request,
      [`telebirrOrders/${merchantOrderId}`]: {
        requestId,
        uid,
        amount,
        status: 'pending',
        createdAt: admin.database.ServerValue.TIMESTAMP
      }
    });

    try {

      const result =
        await telebirrC2B.createOrder({
          title: `Beteseb Bingo Deposit ${amount} ETB`,
          amount,
          merchantOrderId
        });

      await db
        .ref(`telebirrOrders/${merchantOrderId}`)
        .update({
          prepayId: result.prepayId,
          checkoutCreatedAt: admin.database.ServerValue.TIMESTAMP
        });

      await sendMessage(
        chatId,

        `💵 <b>Deposit ${amount} ETB</b>\n\n` +
        `ከታች ያለውን ይጫኑ እና በ Telebirr ይክፈሉ። ክፍያው ሲረጋገጥ balance ራሱ በራሱ ይጨምራል።`,

        {
          reply_markup: {
            inline_keyboard: [
              [{
                text: '💳 Pay with Telebirr',
                url: result.checkoutUrl
              }],
              [{
                text: '🔄 ክፍያ ፈትሽ / Check payment',
                callback_data: `telebirr_check:${merchantOrderId}`
              }]
            ]
          }
        }
      );

    } catch (e) {

      console.error('telebirr createOrder failed:', e.message);

      await db.ref().update({
        [`moneyRequests/${requestId}/status`]: 'failed',
        [`moneyRequests/${requestId}/error`]: String(e.message || e),
        [`telebirrOrders/${merchantOrderId}/status`]: 'failed'
      });

      await sendMessage(
        chatId,
        '⚠️ Telebirr checkout link መፍጠር አልተቻለም። እባክህ ትንሽ ቆይተህ ደግመህ ሞክር ወይም Admin ን አነጋግር።',
        {
          reply_markup:
            mainMenuKeyboard()
        }
      );
    }
  }


  async function checkTelebirrDeposit(
    chatId,
    uid,
    merchantOrderId,
    cqId
  ) {

    const orderRef =
      db.ref(`telebirrOrders/${merchantOrderId}`);

    const snap =
      await orderRef.once('value');

    const order =
      snap.val();

    if (!order || order.uid !== uid) {
      if (cqId) await answerCallback(cqId, 'Order not found.', true);
      return;
    }

    if (order.status === 'paid') {
      if (cqId) await answerCallback(cqId, '✅ Already credited.');
      return;
    }

    if (cqId) await answerCallback(cqId, 'Checking...');

    let status;

    try {
      status = await telebirrC2B.queryOrder(merchantOrderId);
    } catch (e) {
      console.error('telebirr queryOrder failed:', e.message);
      await sendMessage(chatId, '⚠️ Telebirr ን አሁን ማግኘት አልተቻለም፣ ትንሽ ቆይተህ ደግመህ ሞክር።');
      return;
    }

    if (!status.paid) {
      await orderRef.update({
        lastTradeStatus: status.tradeStatus || 'UNKNOWN',
        lastCheckedAt: admin.database.ServerValue.TIMESTAMP
      });
      await sendMessage(
        chatId,
        `⏳ ክፍያው ገና አልተረጋገጠም (${status.tradeStatus || 'pending'})። ከከፈልክ በኋላ ደግመህ ሞክር።`
      );
      return;
    }

    const expected = Number(order.amount);

    if (
      !Number.isFinite(status.amount) ||
      Math.abs(status.amount - expected) > 0.000001
    ) {
      await orderRef.update({
        status: 'amount_mismatch',
        lastTradeStatus: status.tradeStatus,
        lastCheckedAt: admin.database.ServerValue.TIMESTAMP,
        providerAmount: status.amount
      });
      await sendMessage(chatId, '⚠️ የመጠን ልዩነት ተገኝቷል፣ Support ን አነጋግር።');
      return;
    }

    const requestRef =
      db.ref(`moneyRequests/${order.requestId}`);

    // Claim the pending request first so a concurrent webhook call
    // (/telebirr/notify) and this button cannot both credit the wallet.
    const claim =
      await requestRef.transaction(current => {
        if (!current || current.status !== 'pending') return;
        return {
          ...current,
          status: 'approved',
          processedAt: admin.database.ServerValue.TIMESTAMP,
          processedBy: 'telebirr-auto',
          processedByTelegramId: 'telebirr-auto',
          transactionId: status.paymentOrderId || current.transactionId || merchantOrderId,
          telebirrTradeStatus: status.tradeStatus
        };
      });

    if (!claim.committed) {
      const fresh = (await orderRef.once('value')).val();
      if (fresh && fresh.status === 'paid') {
        await sendMessage(chatId, '✅ Deposit already credited.');
      }
      return;
    }

    await db
      .ref(`users/${uid}/balance`)
      .transaction(v => Math.round(((num(v) || 0) + expected) * 100) / 100);

    await db
      .ref(`users/${uid}/transactions/${order.requestId}`)
      .update({
        status: 'approved',
        processedAt: admin.database.ServerValue.TIMESTAMP,
        processedBy: 'telebirr-auto',
        transactionId: status.paymentOrderId || merchantOrderId
      });

    await orderRef.update({
      status: 'paid',
      paidAt: admin.database.ServerValue.TIMESTAMP,
      paymentOrderId: status.paymentOrderId || null,
      lastTradeStatus: status.tradeStatus
    });

    await sendMessage(
      chatId,
      `✅ Deposit of ${expected} ETB confirmed and credited automatically!`,
      {
        reply_markup:
          mainMenuKeyboard()
      }
    );
  }


  async function finishDepositTxnId(
    chatId,
    uid,
    text
  ) {

    const s =
      getSession(chatId);

    const amount =
      s.depositAmount;

    const transactionId =
      String(text || '').trim();

    if (!amount) {

      clearSession(chatId);

      await sendMessage(
        chatId,
        '⚠️ Deposit session expired. Please start Deposit again.',
        {
          reply_markup:
            mainMenuKeyboard()
        }
      );

      return;
    }

    if (!transactionId) {

      await sendMessage(
        chatId,
        '⚠️ Please paste a valid Telebirr transaction ID.'
      );

      return;
    }

    await sendMessage(
      chatId,
      '🔎 Checking your transaction...'
    );

    // ========================================================
    // If real Telebirr API is configured, try automatic verify.
    // If it fails or is not configured, send to admin.
    // ========================================================

    const result =
      await telebirr.verifyDeposit(
        transactionId,
        amount
      );

    if (result.ok) {

      const usedRef =
        db.ref(
          `usedTelebirrTxns/${transactionId}`
        );

      const claim =
        await usedRef.transaction(
          v =>
            v
              ? undefined
              : {
                  uid,
                  amount,
                  at: Date.now()
                }
        );

      if (!claim.committed) {

        clearSession(chatId);

        await sendMessage(
          chatId,
          '⚠️ This transaction ID has already been used.',
          {
            reply_markup:
              mainMenuKeyboard()
          }
        );

        return;
      }

      await db
        .ref(`users/${uid}/balance`)
        .transaction(
          v =>
            Math.round(
              (
                (Number(v) || 0) +
                amount
              ) * 100
            ) / 100
        );

      const txId =
        db
          .ref(`users/${uid}/transactions`)
          .push().key;

      await db
        .ref(`users/${uid}/transactions/${txId}`)
        .set({
          type: 'deposit',
          amount,
          status: 'completed',
          provider: 'telebirr',
          transactionId,
          createdAt:
            admin.database.ServerValue.TIMESTAMP
        });

      clearSession(chatId);

      await sendMessage(
        chatId,
        `✅ Deposit of ${amount} ETB confirmed and credited automatically!`,
        {
          reply_markup:
            mainMenuKeyboard()
        }
      );

      return;
    }

    // ========================================================
    // Automatic verification failed/not configured.
    // Send deposit to ADMIN for manual approval.
    // ========================================================

    clearSession(chatId);

    await createManualMoneyRequest(
      chatId,
      uid,
      'deposit',
      amount,
      transactionId,
      false,
      result.reason || 'manual_review'
    );
  }


  // ==========================================================
  // WITHDRAW
  // ==========================================================

  async function startWithdraw(chatId) {

    setSession(chatId, {
      awaiting: 'withdraw_amount'
    });

    await sendMessage(
      chatId,
      '🤑 Enter the amount (ETB) you want to withdraw:',
      {
        reply_markup: {
          remove_keyboard: true
        }
      }
    );
  }


  async function finishWithdraw(
    chatId,
    uid,
    text
  ) {

    const amount = money(text);

    if (amount === null) {

      await sendMessage(
        chatId,
        '⚠️ Invalid amount, please enter a number, e.g. 100'
      );

      return;
    }

    const balRef =
      db.ref(`users/${uid}/balance`);

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

      await sendMessage(
        chatId,
        '⚠️ Insufficient balance.'
      );

      clearSession(chatId);

      await sendMessage(
        chatId,
        'Menu:',
        {
          reply_markup:
            mainMenuKeyboard()
        }
      );

      return;
    }

    if (telebirr.ENABLED) {

      const uSnap =
        await db
          .ref(`users/${uid}`)
          .once('value');

      const phone =
        (uSnap.val() || {}).phone;

      const payout =
        await telebirr.sendPayout(
          phone,
          amount
        );

      if (payout.ok) {

        const txId =
          db
            .ref(`users/${uid}/transactions`)
            .push().key;

        await db
          .ref(`users/${uid}/transactions/${txId}`)
          .set({
            type: 'withdrawal',
            amount,
            status: 'completed',
            provider: 'telebirr',
            providerRef:
              payout.providerRef || null,
            createdAt:
              admin.database.ServerValue.TIMESTAMP
          });

        clearSession(chatId);

        await sendMessage(
          chatId,
          `✅ ${amount} ETB sent to your Telebirr automatically!`,
          {
            reply_markup:
              mainMenuKeyboard()
          }
        );

        return;
      }

      await balRef.transaction(
        v =>
          (num(v) || 0) +
          amount
      );

      await sendMessage(
        chatId,
        `⚠️ Automatic payout failed (${payout.reason}). Sending to admin for manual processing.`
      );

      await createManualMoneyRequest(
        chatId,
        uid,
        'withdrawal',
        amount,
        null,
        true
      );

      return;
    }

    await createManualMoneyRequest(
      chatId,
      uid,
      'withdrawal',
      amount
    );
  }


  // ==========================================================
  // MANUAL MONEY REQUEST + ADMIN APPROVAL
  // ==========================================================

  async function createManualMoneyRequest(
    chatId,
    uid,
    type,
    amount,
    transactionId,
    alreadyDeducted,
    verificationReason
  ) {

    if (
      type === 'withdrawal' &&
      !alreadyDeducted
    ) {

      const balRef =
        db.ref(`users/${uid}/balance`);

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

        await sendMessage(
          chatId,
          '⚠️ Insufficient balance.'
        );

        clearSession(chatId);

        await sendMessage(
          chatId,
          'Menu:',
          {
            reply_markup:
              mainMenuKeyboard()
          }
        );

        return;
      }
    }

    const id =
      db.ref('moneyRequests').push().key;

    const request = {
      uid,
      type,
      amount,
      status: 'pending',
      transactionId:
        transactionId || null,
      verificationReason:
        verificationReason || null,
      createdAt:
        admin.database.ServerValue.TIMESTAMP
    };

    await db.ref().update({

      [`moneyRequests/${id}`]:
        request,

      [`users/${uid}/transactions/${id}`]:
        request
    });

    clearSession(chatId);

    // ========================================================
    // SEND REQUEST TO ADMIN
    // ========================================================

    if (ADMIN_CHAT_ID) {

      const adminText =
        `🚨 <b>NEW ${type.toUpperCase()} REQUEST</b>\n\n` +

        `💵 <b>Amount:</b> ${amount} ETB\n` +

        `👤 <b>User:</b> <code>${uid}</code>\n` +

        `🆔 <b>Request ID:</b> <code>${id}</code>\n` +

        `💳 <b>Transaction ID:</b> <code>${
          transactionId || 'N/A'
        }</code>\n` +

        `📌 <b>Status:</b> PENDING\n\n` +

        (
          type === 'deposit'
            ? `📲 <b>Deposit verification required.</b>\n` +
              `Check the Telebirr transaction before approving.`
            : `💸 <b>Withdrawal request.</b>\n` +
              `Process the user's withdrawal before approving.`
        );

      const adminKeyboard = {
        inline_keyboard: [
          [
            {
              text: '✅ Approve',
              callback_data:
                `admin:approve:${id}`
            },
            {
              text: '❌ Reject',
              callback_data:
                `admin:reject:${id}`
            }
          ]
        ]
      };

      const adminResult =
        await sendMessage(
          ADMIN_CHAT_ID,
          adminText,
          {
            reply_markup:
              adminKeyboard
          }
        );

      if (
        !adminResult ||
        !adminResult.ok
      ) {
        console.error(
          'Admin notification failed:',
          adminResult
        );
      }

    } else {

      console.error(
        'ADMIN_CHAT_ID is not configured. Deposit/withdrawal approval cannot be sent to admin.'
      );
    }

    // ========================================================
    // USER NOTIFICATION
    // ========================================================

    await sendMessage(
      chatId,

      `✅ ${
        type === 'deposit'
          ? 'Deposit'
          : 'Withdrawal'
      } request sent successfully.\n\n` +

      `💵 Amount: <b>${amount} ETB</b>\n` +

      `🆔 Request ID: <code>${id}</code>\n` +

      `📌 Status: <b>Pending Admin Approval</b>\n\n` +

      `⏳ Admin ካረጋገጠ በኋላ ይጨመርልሃል/ይላክልሃል።`,

      {
        reply_markup:
          mainMenuKeyboard()
      }
    );
  }


  // ==========================================================
  // TRANSFER
  // ==========================================================

  async function startTransfer(chatId) {

    setSession(chatId, {
      awaiting: 'transfer_recipient'
    });

    await sendMessage(
      chatId,
      '🎁 Enter the recipient\'s Telegram ID:',
      {
        reply_markup: {
          remove_keyboard: true
        }
      }
    );
  }


  async function transferRecipient(
    chatId,
    text
  ) {

    const targetTelegramId =
      String(text).trim();

    if (!/^\d+$/.test(targetTelegramId)) {

      await sendMessage(
        chatId,
        '⚠️ Please send a numeric Telegram ID.'
      );

      return;
    }

    const targetUid =
      `tg_${targetTelegramId}`;

    const exists =
      await db
        .ref(`users/${targetUid}`)
        .once('value');

    if (!exists.exists()) {

      await sendMessage(
        chatId,
        '⚠️ No user found with that Telegram ID.'
      );

      return;
    }

    setSession(chatId, {
      awaiting: 'transfer_amount',
      transferTarget: targetUid
    });

    await sendMessage(
      chatId,
      '💵 Enter the amount (ETB) to transfer:'
    );
  }


  async function finishTransfer(
    chatId,
    uid,
    text
  ) {

    const s =
      getSession(chatId);

    const targetUid =
      s.transferTarget;

    const amount =
      money(text);

    if (amount === null) {

      await sendMessage(
        chatId,
        '⚠️ Invalid amount.'
      );

      return;
    }

    if (targetUid === uid) {

      await sendMessage(
        chatId,
        '⚠️ You cannot transfer to yourself.'
      );

      clearSession(chatId);

      return;
    }

    const balRef =
      db.ref(`users/${uid}/balance`);

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

      await sendMessage(
        chatId,
        '⚠️ Insufficient balance.'
      );

      clearSession(chatId);

      await sendMessage(
        chatId,
        'Menu:',
        {
          reply_markup:
            mainMenuKeyboard()
        }
      );

      return;
    }

    await db
      .ref(`users/${targetUid}/balance`)
      .transaction(
        v =>
          Math.round(
            (
              (Number(v) || 0) +
              amount
            ) * 100
          ) / 100
      );

    const id =
      db.ref('moneyRequests').push().key;

    const now =
      admin.database.ServerValue.TIMESTAMP;

    await db.ref().update({

      [`users/${uid}/transactions/${id}`]: {
        type: 'transfer_out',
        amount,
        to: targetUid,
        status: 'completed',
        createdAt: now
      },

      [`users/${targetUid}/transactions/${id}`]: {
        type: 'transfer_in',
        amount,
        from: uid,
        status: 'completed',
        createdAt: now
      }

    });

    clearSession(chatId);

    await sendMessage(
      chatId,
      `✅ Transferred ${amount} ETB.`,
      {
        reply_markup:
          mainMenuKeyboard()
      }
    );
  }


  // ==========================================================
  // MINI APP
  // ==========================================================

  async function showMiniApp(chatId) {

    await sendMessage(
      chatId,

      '🎱 <b>Beteseb Bingo</b>\n\n' +
      '🎮 የBingo ጨዋታውን ለመክፈት ' +
      '<b>Play Bingo</b> ይጫኑ።',

      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '🎮 Play Bingo',
                web_app: {
                  url: MINI_APP_URL
                }
              }
            ]
          ]
        }
      }
    );
  }


  // ==========================================================
  // OLD CHAT GAME FUNCTIONS
  // ==========================================================

  async function showStakeMenu(chatId) {

    await sendMessage(
      chatId,
      '🎮 Choose your stake:',
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: 'Play 10',
                callback_data: 'stake:10'
              },
              {
                text: 'Play 20',
                callback_data: 'stake:20'
              }
            ],

            [
              {
                text: 'Play 50',
                callback_data: 'stake:50'
              },
              {
                text: 'Play 100',
                callback_data: 'stake:100'
              }
            ]
          ]
        }
      }
    );
  }


  async function buildCardGridKeyboard(
    stake,
    page
  ) {

    const roomId =
      `stake_${stake}_open`;

    const takenSnap =
      await db
        .ref(`rooms/${roomId}/taken`)
        .once('value');

    const taken =
      takenSnap.val() || {};

    const start =
      page * CARDS_PER_PAGE + 1;

    const end =
      Math.min(
        start + CARDS_PER_PAGE - 1,
        MAX_CARTELA
      );

    const rows = [];

    let row = [];

    for (
      let n = start;
      n <= end;
      n++
    ) {

      row.push({
        text:
          taken[n]
            ? `❌${n}`
            : `${n}`,

        callback_data:
          `card:${stake}:${n}`
      });

      if (row.length === 8) {

        rows.push(row);
        row = [];
      }
    }

    if (row.length) {
      rows.push(row);
    }

    const nav = [];

    if (page > 0) {

      nav.push({
        text: '⬅️ Prev',
        callback_data:
          `page:${stake}:${page - 1}`
      });
    }

    if (end < MAX_CARTELA) {

      nav.push({
        text: 'Next ➡️',
        callback_data:
          `page:${stake}:${page + 1}`
      });
    }

    if (nav.length) {
      rows.push(nav);
    }

    rows.push([
      {
        text: '← Back',
        callback_data: 'stake:back'
      }
    ]);

    return {
      inline_keyboard: rows
    };
  }


  async function showCardGrid(
    chatId,
    messageId,
    stake,
    page
  ) {

    const kb =
      await buildCardGridKeyboard(
        stake,
        page
      );

    const text =
      `🎯 Choose your cartela (${page * CARDS_PER_PAGE + 1}–${Math.min(
        (page + 1) * CARDS_PER_PAGE,
        MAX_CARTELA
      )}):`;

    if (messageId) {

      await editMessage(
        chatId,
        messageId,
        text,
        {
          reply_markup: kb
        }
      );

    } else {

      await sendMessage(
        chatId,
        text,
        {
          reply_markup: kb
        }
      );
    }
  }


  async function joinRoom(
    chatId,
    uid,
    stake,
    cardNo
  ) {

    const roomId =
      `stake_${stake}_open`;

    const roomRef =
      db.ref(`rooms/${roomId}`);

    const balRef =
      db.ref(`users/${uid}/balance`);

    const btx =
      await balRef.transaction(
        v => {

          const b = num(v);

          if (
            b === null ||
            b < stake
          ) {
            return;
          }

          return Math.round(
            (b - stake) * 100
          ) / 100;
        }
      );

    if (!btx.committed) {

      await sendMessage(
        chatId,
        '⚠️ Insufficient balance for this stake.'
      );

      return;
    }

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

          if (room.players[uid]) {
            return;
          }

          if (
            room.taken[String(cardNo)]
          ) {
            return;
          }

          room.players[uid] = {
            cartelaNumber: cardNo,
            joinedAt: Date.now()
          };

          room.taken[String(cardNo)] =
            true;

          if (!room.countdownEndsAt) {

            room.countdownEndsAt =
              Date.now() +
              CARTELA_SELECTION_SECONDS *
                1000;
          }

          return room;
        }
      );

    if (!jtx.committed) {

      await balRef.transaction(
        v =>
          (num(v) || 0) + stake
      );

      await sendMessage(
        chatId,
        '⚠️ That cartela is already taken, pick another.'
      );

      return;
    }

    const card =
      getCard(cardNo);

    const sent =
      await sendMessage(
        chatId,
        '⏳ Joined! Waiting for the cartela-selection countdown to finish...',
        {
          reply_markup:
            gameKeyboard()
        }
      );

    const messageId =
      sent &&
      sent.result &&
      sent.result.message_id;

    startGameWatcher(
      chatId,
      uid,
      roomId,
      cardNo,
      card,
      messageId
    );
  }


  function gameKeyboard() {

    return {
      inline_keyboard: [

        [
          {
            text: '🏆 BINGO!',
            callback_data: 'bingo'
          }
        ],

        [
          {
            text: '❌ Leave',
            callback_data: 'leave'
          }
        ]

      ]
    };
  }


  function renderWaitingText(room) {

    const count =
      Object.keys(
        room.players || {}
      ).length;

    const secs =
      Math.max(
        0,
        Math.ceil(
          (
            (room.countdownEndsAt ||
              Date.now()) -
            Date.now()
          ) / 1000
        )
      );

    return (
      `⏳ Waiting for players... (${count} joined)\n` +
      `Game starts in <b>${secs}s</b> (needs at least 2 players).`
    );
  }


  function renderGameText(
    card,
    calledArr,
    lastCalled
  ) {

    const cols =
      ['B', 'I', 'N', 'G', 'O'];

    const called =
      new Set(calledArr);

    const mark = v =>
      v === 'FREE'
        ? `[${v}]`
        : (
            called.has(Number(v))
              ? `[${v}]`
              : v
          );

    let grid =
      cols.map(c => c).join('  ') +
      '\n';

    for (let r = 0; r < 5; r++) {

      grid +=
        cols
          .map(c =>
            String(
              mark(card[c][r])
            ).padEnd(4)
          )
          .join('') +
        '\n';
    }

    const calledLabel =
      lastCalled
        ? `${letterFor(lastCalled)} ${lastCalled}`
        : '-';

    return (
      `🔔 Last called: <b>${calledLabel}</b>\n\n` +
      `<pre>${grid}</pre>`
    );
  }


  const watchers = new Map();


  function startGameWatcher(
    chatId,
    uid,
    roomId,
    cardNo,
    card,
    messageId
  ) {

    stopGameWatcher(chatId);

    const intervalId =
      setInterval(
        async () => {

          const snap =
            await db
              .ref(`rooms/${roomId}`)
              .once('value');

          const room =
            snap.val();

          if (!room) {
            return;
          }

          if (room.state === 'waiting') {

            if (messageId) {

              await editMessage(
                chatId,
                messageId,
                renderWaitingText(room),
                {
                  reply_markup:
                    gameKeyboard()
                }
              ).catch(() => {});
            }

            return;
          }

          const calledArr =
            Object.keys(
              room.calledNumbers || {}
            ).map(Number);

          if (messageId) {

            await editMessage(
              chatId,
              messageId,
              renderGameText(
                card,
                calledArr,
                room.lastCalled
              ),
              {
                reply_markup:
                  gameKeyboard()
              }
            ).catch(() => {});
          }

          if (room.state === 'finished') {

            stopGameWatcher(chatId);

            const winners =
              room.winners || {};

            const mine =
              winners[uid];

            if (mine) {

              await sendMessage(
                chatId,
                `🏆 BINGO! You won ${mine.prize} ETB on cartela #${mine.cartelaNumber}!`,
                {
                  reply_markup:
                    mainMenuKeyboard()
                }
              );

            } else if (
              Object.keys(winners).length
            ) {

              const list =
                Object
                  .values(winners)
                  .map(
                    w =>
                      `#${w.cartelaNumber}`
                  )
                  .join(', ');

              await sendMessage(
                chatId,
                `🎉 BINGO! Winning cartela(s): ${list}\n😢 Better luck next time.`,
                {
                  reply_markup:
                    mainMenuKeyboard()
                }
              );

            } else {

              await sendMessage(
                chatId,
                '😢 Round ended — better luck next time.',
                {
                  reply_markup:
                    mainMenuKeyboard()
                }
              );
            }
          }

        },
        Math.min(
          CALL_INTERVAL_MS,
          2000
        )
      );

    watchers.set(
      chatId,
      {
        intervalId,
        roomId,
        uid,
        cardNo
      }
    );
  }


  function stopGameWatcher(chatId) {

    const w =
      watchers.get(chatId);

    if (w) {

      clearInterval(
        w.intervalId
      );

      watchers.delete(chatId);
    }
  }


  async function claimBingo(
    chatId,
    uid
  ) {

    const w =
      watchers.get(chatId);

    if (!w) {

      await sendMessage(
        chatId,
        '⚠️ You are not in an active game.'
      );

      return;
    }

    const roomRef =
      db.ref(`rooms/${w.roomId}`);

    const snap =
      await roomRef.once('value');

    const room =
      snap.val();

    if (
      !room ||
      room.state !== 'running'
    ) {

      await sendMessage(
        chatId,
        '⚠️ Room not active.'
      );

      return;
    }

    const called =
      new Set(
        Object.keys(
          room.calledNumbers || {}
        ).map(Number)
      );

    if (
      !hasBingo(
        w.cardNo,
        called
      )
    ) {

      await sendMessage(
        chatId,
        '⚠️ No BINGO on your card yet.'
      );

      return;
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
            !r.players[uid]
          ) {
            return;
          }

          return {
            ...r,

            state: 'finished',

            winners: {
              [uid]: {
                cartelaNumber:
                  w.cardNo,
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

      await sendMessage(
        chatId,
        '⚠️ This round has already been claimed.'
      );

      return;
    }

    await db
      .ref(`users/${uid}/balance`)
      .transaction(
        v =>
          (num(v) || 0) + prize
      );

    await roomRef.update({
      payoutStatus: 'paid'
    });

    const txId =
      db
        .ref(`users/${uid}/transactions`)
        .push().key;

    await db
      .ref(`users/${uid}/transactions/${txId}`)
      .set({
        type: 'win',
        amount: prize,
        roomId: w.roomId,
        status: 'completed',
        createdAt:
          admin.database.ServerValue.TIMESTAMP
      });
  }


  // ==========================================================
  // WEBHOOK UPDATE
  // ==========================================================

  async function handleUpdate(update) {

    try {

      if (update.callback_query) {

        return await onCallback(
          update.callback_query
        );
      }

      if (update.message) {

        return await onMessage(
          update.message
        );
      }

    } catch (e) {

      console.error(
        'bot handleUpdate:',
        e
      );
    }
  }


  // ==========================================================
  // MESSAGE
  // ==========================================================

  async function onMessage(msg) {

    const chatId =
      msg.chat.id;

    const uid =
      `tg_${msg.from.id}`;

    await getOrCreateUser(
      msg.from
    );


    if (msg.contact) {

      return handleRegister(
        chatId,
        uid,
        msg.contact
      );
    }


    const text =
      (msg.text || '').trim();

    const session =
      getSession(chatId);


    // ========================================================
    // /start
    // ========================================================

    if (
      text.startsWith('/start')
    ) {

      const startParam =
        text.split(/\s+/)[1];

      await applyReferral(
        uid,
        startParam
      );

      clearSession(chatId);

      await sendMessage(
        chatId,

        '👋 <b>Welcome to Beteseb Bingo!</b>\n\n' +
        '🎱 የምትፈልገውን option ከታች ምረጥ 👇',

        {
          reply_markup:
            mainMenuKeyboard()
        }
      );

      return;
    }


    // ========================================================
    // Commands
    // ========================================================

    if (text.startsWith('/')) {

      const cmd =
        text
          .slice(1)
          .split(/[@\s]/)[0]
          .toLowerCase();

      const commandMap = {

        play: () =>
          showMiniApp(chatId),

        register: () =>
          handleRegister(
            chatId,
            uid,
            null
          ),

        balance: () =>
          handleBalance(
            chatId,
            uid
          ),

        deposit: () =>
          startDeposit(chatId),

        withdraw: () =>
          startWithdraw(chatId),

        transfer: () =>
          startTransfer(chatId),

        invite: () =>
          handleInvite(
            chatId,
            uid
          ),

        instruction: () =>
          handleInstruction(chatId),

        support: () =>
          handleSupport(chatId),

        convertbonus: () =>
          handleConvertBonus(
            chatId,
            uid
          ),

        bonus: () =>
          handleConvertBonus(
            chatId,
            uid
          )
      };


      if (commandMap[cmd]) {

        clearSession(chatId);

        return commandMap[cmd]();
      }
    }


    // ========================================================
    // Session handlers
    // ========================================================

    if (
      session.awaiting ===
      'register_contact'
    ) {
      return;
    }


    if (
      session.awaiting ===
      'deposit_amount'
    ) {

      return finishDeposit(
        chatId,
        uid,
        text
      );
    }


    if (
      session.awaiting ===
      'deposit_txn_id'
    ) {

      return finishDepositTxnId(
        chatId,
        uid,
        text
      );
    }


    if (
      session.awaiting ===
      'withdraw_amount'
    ) {

      return finishWithdraw(
        chatId,
        uid,
        text
      );
    }


    if (
      session.awaiting ===
      'transfer_recipient'
    ) {

      return transferRecipient(
        chatId,
        text
      );
    }


    if (
      session.awaiting ===
      'transfer_amount'
    ) {

      return finishTransfer(
        chatId,
        uid,
        text
      );
    }


    // ========================================================
    // Text menu fallback
    // ========================================================

    switch (text) {

      case MENU_TEXT.play:
        return showMiniApp(chatId);

      case MENU_TEXT.register:
        return handleRegister(
          chatId,
          uid,
          null
        );

      case MENU_TEXT.balance:
        return handleBalance(
          chatId,
          uid
        );

      case MENU_TEXT.deposit:
        return startDeposit(chatId);

      case MENU_TEXT.support:
        return handleSupport(chatId);

      case MENU_TEXT.instruction:
        return handleInstruction(chatId);

      case MENU_TEXT.transfer:
        return startTransfer(chatId);

      case MENU_TEXT.withdraw:
        return startWithdraw(chatId);

      case MENU_TEXT.invite:
        return handleInvite(
          chatId,
          uid
        );

      case MENU_TEXT.bonus:
        return handleConvertBonus(
          chatId,
          uid
        );

      default:

        await sendMessage(
          chatId,

          'እባክህ ከታች ካሉት options ውስጥ ምረጥ 👇',

          {
            reply_markup:
              mainMenuKeyboard()
          }
        );
    }
  }


  // ==========================================================
  // CALLBACK
  // ==========================================================

  async function onCallback(cq) {

    const chatId =
      cq.message.chat.id;

    const messageId =
      cq.message.message_id;

    const uid =
      `tg_${cq.from.id}`;

    const data =
      cq.data || '';

    await getOrCreateUser(
      cq.from
    );


    // ========================================================
    // TELEBIRR C2B — "Check payment" button
    // ========================================================

    if (data.startsWith('telebirr_check:')) {

      const merchantOrderId =
        data.slice('telebirr_check:'.length);

      return checkTelebirrDeposit(
        chatId,
        uid,
        merchantOrderId,
        cq.id
      );
    }


    // ========================================================
    // ADMIN APPROVAL
    // ========================================================

    if (data.startsWith('admin:')) {

      // Only the configured admin chat can approve/reject.
      if (
        !ADMIN_CHAT_ID ||
        String(chatId) !== String(ADMIN_CHAT_ID)
      ) {

        return answerCallback(
          cq.id,
          '⛔ Not authorized.',
          true
        );
      }

      const parts =
        data.split(':');

      const action =
        parts[1];

      const requestId =
        parts.slice(2).join(':');

      if (
        !requestId ||
        !['approve', 'reject'].includes(action)
      ) {

        return answerCallback(
          cq.id,
          'Invalid request.',
          true
        );
      }

      const reqRef =
        db.ref(
          `moneyRequests/${requestId}`
        );

      const reqSnap =
        await reqRef.once('value');

      const req =
        reqSnap.val();

      if (!req) {

        return answerCallback(
          cq.id,
          'Request not found.',
          true
        );
      }

      if (req.status !== 'pending') {

        return answerCallback(
          cq.id,
          `Already ${String(req.status).toUpperCase()}.`,
          true
        );
      }

      // ======================================================
      // APPROVE
      // ======================================================

      if (action === 'approve') {

        // Deposit:
        // Add money to user's balance.
        if (req.type === 'deposit') {

          const balanceRef =
            db.ref(
              `users/${req.uid}/balance`
            );

          await balanceRef.transaction(
            v =>
              Math.round(
                (
                  (Number(v) || 0) +
                  Number(req.amount || 0)
                ) * 100
              ) / 100
          );
        }

        // Mark request approved.
        await reqRef.update({
          status: 'approved',
          approvedAt:
            admin.database.ServerValue.TIMESTAMP,
          approvedBy:
            String(cq.from.id)
        });

        // Update user's transaction.
        await db
          .ref(
            `users/${req.uid}/transactions/${requestId}`
          )
          .update({
            status: 'approved',
            approvedAt:
              admin.database.ServerValue.TIMESTAMP
          });

        // Prevent duplicate Telebirr transaction IDs
        // from being approved again.
        if (
          req.type === 'deposit' &&
          req.transactionId
        ) {

          await db
            .ref(
              `usedTelebirrTxns/${req.transactionId}`
            )
            .transaction(
              v =>
                v || {
                  uid: req.uid,
                  amount: req.amount,
                  requestId,
                  manuallyApproved: true,
                  at: Date.now()
                }
            );
        }

        await answerCallback(
          cq.id,
          '✅ Approved'
        );

        await editMessage(
          chatId,
          messageId,

          `✅ <b>${req.type.toUpperCase()} APPROVED</b>\n\n` +

          `💵 Amount: <b>${req.amount} ETB</b>\n` +

          `👤 User: <code>${req.uid}</code>\n` +

          `🆔 Request ID: <code>${requestId}</code>\n` +

          `💳 Transaction ID: <code>${
            req.transactionId || 'N/A'
          }</code>\n\n` +

          `Status: <b>APPROVED ✅</b>`,

          {
            reply_markup: {
              inline_keyboard: []
            }
          }
        );

        // Notify user.
        await notifyUser(
          req.uid,

          `✅ <b>Deposit Approved!</b>\n\n` +

          `💵 Amount: <b>${req.amount} ETB</b>\n` +

          `🆔 Request ID: <code>${requestId}</code>\n\n` +

          `💰 The amount has been added to your balance.`,

        );

        return;
      }


      // ======================================================
      // REJECT
      // ======================================================

      if (action === 'reject') {

        // If withdrawal was already deducted,
        // return the money to the user.
        if (
          req.type === 'withdrawal'
        ) {

          await db
            .ref(
              `users/${req.uid}/balance`
            )
            .transaction(
              v =>
                Math.round(
                  (
                    (Number(v) || 0) +
                    Number(req.amount || 0)
                  ) * 100
                ) / 100
            );
        }

        await reqRef.update({
          status: 'rejected',
          rejectedAt:
            admin.database.ServerValue.TIMESTAMP,
          rejectedBy:
            String(cq.from.id)
        });

        await db
          .ref(
            `users/${req.uid}/transactions/${requestId}`
          )
          .update({
            status: 'rejected',
            rejectedAt:
              admin.database.ServerValue.TIMESTAMP
          });

        await answerCallback(
          cq.id,
          '❌ Rejected'
        );

        await editMessage(
          chatId,
          messageId,

          `❌ <b>${req.type.toUpperCase()} REJECTED</b>\n\n` +

          `💵 Amount: <b>${req.amount} ETB</b>\n` +

          `👤 User: <code>${req.uid}</code>\n` +

          `🆔 Request ID: <code>${requestId}</code>\n` +

          `💳 Transaction ID: <code>${
            req.transactionId || 'N/A'
          }</code>\n\n` +

          `Status: <b>REJECTED ❌</b>`,

          {
            reply_markup: {
              inline_keyboard: []
            }
          }
        );

        await notifyUser(
          req.uid,

          `❌ <b>${req.type === 'deposit' ? 'Deposit' : 'Withdrawal'} Rejected</b>\n\n` +

          `💵 Amount: <b>${req.amount} ETB</b>\n` +

          `🆔 Request ID: <code>${requestId}</code>\n\n` +

          (
            req.type === 'withdrawal'
              ? `💰 The amount has been returned to your balance.`
              : `☎️ Please contact support if you believe this was a mistake.`
          )
        );

        return;
      }
    }


    // ========================================================
    // MAIN MENU CALLBACKS
    // ========================================================

    const menuActions = {

      'menu:register': () =>
        handleRegister(
          chatId,
          uid,
          null
        ),

      'menu:balance': () =>
        handleBalance(
          chatId,
          uid
        ),

      'menu:deposit': () =>
        startDeposit(chatId),

      'menu:support': () =>
        handleSupport(chatId),

      'menu:instruction': () =>
        handleInstruction(chatId),

      'menu:transfer': () =>
        startTransfer(chatId),

      'menu:withdraw': () =>
        startWithdraw(chatId),

      'menu:invite': () =>
        handleInvite(
          chatId,
          uid
        ),

      'menu:bonus': () =>
        handleConvertBonus(
          chatId,
          uid
        )
    };


    if (menuActions[data]) {

      await answerCallback(
        cq.id
      );

      clearSession(chatId);

      return menuActions[data]();
    }


    // ========================================================
    // OLD CHAT GAME CALLBACKS
    // ========================================================

    if (data === 'stake:back') {

      await answerCallback(
        cq.id
      );

      const kb = {
        inline_keyboard: [

          [
            {
              text: 'Play 10',
              callback_data:
                'stake:10'
            },
            {
              text: 'Play 20',
              callback_data:
                'stake:20'
            }
          ],

          [
            {
              text: 'Play 50',
              callback_data:
                'stake:50'
            },
            {
              text: 'Play 100',
              callback_data:
                'stake:100'
            }
          ]

        ]
      };

      return editMessage(
        chatId,
        messageId,
        '🎮 Choose your stake:',
        {
          reply_markup: kb
        }
      );
    }


    if (
      data.startsWith('stake:')
    ) {

      const stake =
        Number(
          data.split(':')[1]
        );

      if (
        !ALLOWED_STAKES.includes(
          stake
        )
      ) {

        return answerCallback(
          cq.id,
          'Invalid stake'
        );
      }

      await answerCallback(
        cq.id
      );

      return showCardGrid(
        chatId,
        messageId,
        stake,
        0
      );
    }


    if (
      data.startsWith('page:')
    ) {

      const [
        ,
        stake,
        page
      ] =
        data.split(':');

      await answerCallback(
        cq.id
      );

      return showCardGrid(
        chatId,
        messageId,
        Number(stake),
        Number(page)
      );
    }


    if (
      data.startsWith('card:')
    ) {

      const [
        ,
        stake,
        cardNo
      ] =
        data.split(':');

      await answerCallback(
        cq.id,
        'Joining...'
      );

      return joinRoom(
        chatId,
        uid,
        Number(stake),
        Number(cardNo)
      );
    }


    if (data === 'bingo') {

      await answerCallback(
        cq.id,
        'Checking...'
      );

      return claimBingo(
        chatId,
        uid
      );
    }


    if (data === 'leave') {

      stopGameWatcher(
        chatId
      );

      await answerCallback(
        cq.id,
        'Left the game'
      );

      return sendMessage(
        chatId,
        'Menu:',
        {
          reply_markup:
            mainMenuKeyboard()
        }
      );
    }


    return answerCallback(
      cq.id
    );
  }


  // ==========================================================
  // WEBHOOK
  // ==========================================================

  async function setWebhook(
    publicUrl,
    secretToken
  ) {

    if (!publicUrl) {

      console.warn(
        'setWebhook skipped: no public URL provided'
      );

      return;
    }

    const res =
      await tgCall(
        'setWebhook',
        {
          url:
            `${publicUrl.replace(/\/$/, '')}/telegram/webhook`,

          secret_token:
            secretToken || undefined
        }
      );

    console.log(
      'setWebhook result:',
      res && res.ok
        ? 'ok'
        : res
    );
  }


  // ==========================================================
  // NOTIFY USER
  // ==========================================================

  async function notifyUser(
    uid,
    text
  ) {

    if (
      !uid ||
      !String(uid).startsWith('tg_')
    ) {
      return;
    }

    const chatId =
      String(uid).slice(3);

    return sendMessage(
      chatId,
      text
    );
  }


  // ==========================================================
  // BOT COMMANDS
  // ==========================================================

  const BOT_COMMANDS = [

    {
      command: 'start',
      description:
        'Show the main menu'
    },

    {
      command: 'play',
      description:
        'Open Bingo Mini App'
    },

    {
      command: 'register',
      description:
        'Register your phone number'
    },

    {
      command: 'balance',
      description:
        'Check your balance'
    },

    {
      command: 'deposit',
      description:
        'Deposit money'
    },

    {
      command: 'withdraw',
      description:
        'Withdraw money'
    },

    {
      command: 'transfer',
      description:
        'Transfer to another player'
    },

    {
      command: 'invite',
      description:
        'Get your invite link'
    },

    {
      command: 'instruction',
      description:
        'How to play'
    },

    {
      command: 'support',
      description:
        'Contact support'
    },

    {
      command: 'convertbonus',
      description:
        'Convert bonus to balance'
    }

  ];


  async function setCommands() {

    return tgCall(
      'setMyCommands',
      {
        commands:
          BOT_COMMANDS
      }
    );
  }


  // ==========================================================
  // RETURN BOT API
  // ==========================================================

  return {
    handleUpdate,
    setWebhook,
    notifyUser,
    setCommands
  };
};
