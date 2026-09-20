
// telegramBot.js — full "menu inside Telegram chat" experience (no Mini App needed).
// Everything (Register, Balance, Deposit, Withdraw, Transfer, Invite, Support,
// Instructions, Convert Bonus, and the Bingo game itself) runs as bot messages
// and inline keyboards.

const crypto = require('crypto');
const { getCard, hasBingo } = require('./cartela');
const telebirr = require('./telebirr');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const ALLOWED_STAKES = [10, 20, 50, 100];
const HOUSE_CUT = Math.min(Math.max(Number(process.env.HOUSE_CUT || 0.20), 0), 1);
const CALL_INTERVAL_MS = Math.max(Number(process.env.CALL_INTERVAL_MS || 3000), 1000);
const MAX_CARTELA = 500;
const CARDS_PER_PAGE = 96; // 8 columns x 12 rows, same layout as the reference bot
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || '@BetesebSupport';
const BOT_USERNAME = String(process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '');
const SIGNUP_BONUS = Number(process.env.SIGNUP_BONUS || 0);
const REFERRAL_BONUS = Number(process.env.REFERRAL_BONUS || 0);

const MENU_TEXT = {
  play: '🎮 Play', register: '📝 Register', balance: '💰 Check Balance',
  deposit: '💵 Deposit', support: '☎️ Contact Support', instruction: '📖 Instruction',
  transfer: '🎁 Transfer', withdraw: '🤑 Withdraw', invite: '🔗 Invite', bonus: '🎉 Convert Bonus',
};

function mainMenuKeyboard() {
  return { keyboard: [
    [MENU_TEXT.play, MENU_TEXT.register],
    [MENU_TEXT.balance, MENU_TEXT.deposit],
    [MENU_TEXT.support, MENU_TEXT.instruction],
    [MENU_TEXT.transfer, MENU_TEXT.withdraw],
    [MENU_TEXT.invite, MENU_TEXT.bonus],
  ], resize_keyboard: true };
}

// ---- tiny per-chat conversation state (single Railway instance, in-memory) ----
// For multi-instance deployments, move this to Firebase under `sessions/{chatId}`.
const sessions = new Map();
function getSession(chatId) { return sessions.get(chatId) || {}; }
function setSession(chatId, patch) { sessions.set(chatId, { ...getSession(chatId), ...patch }); }
function clearSession(chatId) { sessions.delete(chatId); }

function tgCall(method, body) {
  return fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json()).catch(e => { console.error(`tg ${method} failed:`, e.message); return null; });
}
const sendMessage = (chatId, text, extra = {}) => tgCall('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
const editMessage = (chatId, messageId, text, extra = {}) => tgCall('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...extra });
const answerCallback = (id, text, alert = false) => tgCall('answerCallbackQuery', { callback_query_id: id, text, show_alert: alert });

module.exports = function createBot(db, admin) {
  const num = v => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
  const money = v => { const n = Number(v); return Number.isFinite(n) && n > 0 && n <= 1000000 ? Math.round(n * 100) / 100 : null; };

  async function getOrCreateUser(from) {
    const uid = `tg_${from.id}`;
    const ref = db.ref(`users/${uid}`);
    const snap = await ref.once('value');
    if (!snap.exists()) {
      const code = String(from.id);
      await ref.set({
        balance: SIGNUP_BONUS ? 0 : 0,
        bonus: SIGNUP_BONUS || 0,
        referrals: 0, cards: 0,
        name: from.first_name || 'Player',
        telegramId: from.id,
        username: from.username || '',
        referralCode: code,
        registered: false,
        createdAt: admin.database.ServerValue.TIMESTAMP,
      });
      await db.ref(`referralCodes/${code}`).set(uid);
      return (await ref.once('value')).val();
    }
    return snap.val();
  }

  async function applyReferral(uid, startParam) {
    if (!startParam) return;
    const refSnap = await db.ref(`referralCodes/${String(startParam)}`).once('value');
    const refUid = refSnap.val();
    if (!refUid || refUid === uid) return;
    const already = (await db.ref(`users/${uid}/referredBy`).once('value')).val();
    if (already) return;
    await db.ref(`users/${refUid}/referrals`).transaction(v => (Number(v) || 0) + 1);
    if (REFERRAL_BONUS) await db.ref(`users/${refUid}/bonus`).transaction(v => (Number(v) || 0) + REFERRAL_BONUS);
    await db.ref(`users/${uid}`).update({ referredBy: refUid });
  }

  // ---------------- Register ----------------
  async function handleRegister(chatId, uid, contact) {
    if (contact) {
      await db.ref(`users/${uid}`).update({ phone: contact.phone_number, registered: true });
      setSession(chatId, { awaiting: null });
      await sendMessage(chatId, '✅ Registration complete! Your phone number is saved.', { reply_markup: mainMenuKeyboard() });
      return;
    }
    setSession(chatId, { awaiting: 'register_contact' });
    await sendMessage(chatId, '📱 Please share your phone number to complete registration.', {
      reply_markup: { keyboard: [[{ text: '📲 Share phone number', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
    });
  }

  // ---------------- Balance / Instruction / Support / Invite ----------------
  async function handleBalance(chatId, uid) {
    const s = await db.ref(`users/${uid}`).once('value'); const u = s.val() || {};
    await sendMessage(chatId, `💰 <b>Balance:</b> ${Number(u.balance || 0)} ETB\n🎁 <b>Bonus:</b> ${Number(u.bonus || 0)} ETB`);
  }
  async function handleInstruction(chatId) {
    await sendMessage(chatId,
      '📖 <b>እንዴት ይጫወቱ</b>\n' +
      '1️⃣ "🎮 Play" ተጫን\n' +
      '2️⃣ Stake (10/20/50/100 ETB) ምረጥ\n' +
      '3️⃣ የፈለከውን cartela ቁጥር ምረጥ\n' +
      '4️⃣ ቁጥሮች ሲጠሩ ካርድህ ላይ ራሱ ይምረቃል\n' +
      '5️⃣ Bingo ስትሰራ "🏆 BINGO" ን ተጫን\n\n' +
      '💵 Deposit/Withdraw ከ menu በኩል በቀላሉ ይላካል፣ ማረጋገጫ ከ admin በኋላ ይጠናቀቃል።'
    );
  }
  async function handleSupport(chatId) {
    await sendMessage(chatId, `☎️ <b>Contact Support</b>\nማንኛውም ጥያቄ ካለህ ወደ ${SUPPORT_CONTACT} መልእክት ላክ።`);
  }
  async function handleInvite(chatId, uid) {
    const s = await db.ref(`users/${uid}`).once('value'); const u = s.val() || {};
    const code = u.referralCode || String(u.telegramId || '');
    const link = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=${encodeURIComponent(code)}` : null;
    await sendMessage(chatId, link
      ? `🔗 <b>Invitation Link</b>\n${link}\n\n👥 Referrals: ${Number(u.referrals || 0)}`
      : `🔗 Your referral code: <code>${code}</code>\n(Set TELEGRAM_BOT_USERNAME to get a shareable link)\n👥 Referrals: ${Number(u.referrals || 0)}`);
  }
  async function handleConvertBonus(chatId, uid) {
    const bonusRef = db.ref(`users/${uid}/bonus`);
    const snap = await bonusRef.once('value'); const bonus = Number(snap.val() || 0);
    if (bonus <= 0) { await sendMessage(chatId, '🎉 No bonus available to convert right now.'); return; }
    const tx = await bonusRef.transaction(v => 0);
    if (!tx.committed) { await sendMessage(chatId, '⚠️ Could not convert bonus, try again.'); return; }
    await db.ref(`users/${uid}/balance`).transaction(v => Math.round(((Number(v) || 0) + bonus) * 100) / 100);
    await sendMessage(chatId, `🎉 Converted ${bonus} ETB bonus into your balance!`);
  }

  // ---------------- Deposit / Withdraw / Transfer (conversational) ----------------
  async function startDeposit(chatId) {
    setSession(chatId, { awaiting: 'deposit_amount' });
    await sendMessage(chatId, '💵 Enter the amount (ETB) you want to deposit:', { reply_markup: { remove_keyboard: true } });
  }
  async function finishDeposit(chatId, uid, text) {
    const amount = money(text);
    if (amount === null) { await sendMessage(chatId, '⚠️ Invalid amount, please enter a number, e.g. 100'); return; }
    if (telebirr.ENABLED) {
      setSession(chatId, { awaiting: 'deposit_txn_id', depositAmount: amount });
      await sendMessage(chatId, `📲 Send ${amount} ETB to our Telebirr number, then paste the <b>Telebirr transaction ID</b> here to get it credited automatically.`);
      return;
    }
    await createManualMoneyRequest(chatId, uid, 'deposit', amount);
  }
  async function finishDepositTxnId(chatId, uid, text) {
    const s = getSession(chatId); const amount = s.depositAmount;
    const transactionId = String(text).trim();
    if (!transactionId) { await sendMessage(chatId, '⚠️ Please paste a valid transaction ID.'); return; }
    await sendMessage(chatId, '🔎 Verifying with Telebirr...');
    const result = await telebirr.verifyDeposit(transactionId, amount);
    if (!result.ok) {
      clearSession(chatId);
      await sendMessage(chatId, `⚠️ Could not auto-verify that transaction (${result.reason}). Sending it to admin for manual review instead.`);
      await createManualMoneyRequest(chatId, uid, 'deposit', amount, transactionId);
      return;
    }
    const usedRef = db.ref(`usedTelebirrTxns/${transactionId}`);
    const claim = await usedRef.transaction(v => v ? undefined : { uid, amount, at: Date.now() });
    if (!claim.committed) { clearSession(chatId); await sendMessage(chatId, '⚠️ This transaction ID has already been used.'); return; }
    await db.ref(`users/${uid}/balance`).transaction(v => Math.round(((Number(v) || 0) + amount) * 100) / 100);
    const txId = db.ref(`users/${uid}/transactions`).push().key;
    await db.ref(`users/${uid}/transactions/${txId}`).set({ type: 'deposit', amount, status: 'completed', provider: 'telebirr', transactionId, createdAt: admin.database.ServerValue.TIMESTAMP });
    clearSession(chatId);
    await sendMessage(chatId, `✅ Deposit of ${amount} ETB confirmed and credited automatically!`, { reply_markup: mainMenuKeyboard() });
  }

  async function startWithdraw(chatId) {
    setSession(chatId, { awaiting: 'withdraw_amount' });
    await sendMessage(chatId, '🤑 Enter the amount (ETB) you want to withdraw:', { reply_markup: { remove_keyboard: true } });
  }
  async function finishWithdraw(chatId, uid, text) {
    const amount = money(text);
    if (amount === null) { await sendMessage(chatId, '⚠️ Invalid amount, please enter a number, e.g. 100'); return; }
    const balRef = db.ref(`users/${uid}/balance`);
    const tx = await balRef.transaction(v => { const b = num(v); if (b === null || b < amount) return; return Math.round((b - amount) * 100) / 100; });
    if (!tx.committed) { await sendMessage(chatId, '⚠️ Insufficient balance.'); clearSession(chatId); await sendMessage(chatId, 'Menu:', { reply_markup: mainMenuKeyboard() }); return; }

    if (telebirr.ENABLED) {
      const uSnap = await db.ref(`users/${uid}`).once('value'); const phone = (uSnap.val() || {}).phone;
      const payout = await telebirr.sendPayout(phone, amount);
      if (payout.ok) {
        const txId = db.ref(`users/${uid}/transactions`).push().key;
        await db.ref(`users/${uid}/transactions/${txId}`).set({ type: 'withdrawal', amount, status: 'completed', provider: 'telebirr', providerRef: payout.providerRef || null, createdAt: admin.database.ServerValue.TIMESTAMP });
        clearSession(chatId);
        await sendMessage(chatId, `✅ ${amount} ETB sent to your Telebirr automatically!`, { reply_markup: mainMenuKeyboard() });
        return;
      }
      // auto payout failed — refund the hold and fall back to manual review
      await balRef.transaction(v => (num(v) || 0) + amount);
      await sendMessage(chatId, `⚠️ Automatic payout failed (${payout.reason}). Sending to admin for manual processing.`);
      await createManualMoneyRequest(chatId, uid, 'withdrawal', amount, null, true);
      return;
    }
    await createManualMoneyRequest(chatId, uid, 'withdrawal', amount);
  }

  async function createManualMoneyRequest(chatId, uid, type, amount, transactionId, alreadyDeducted) {
    if (type === 'withdrawal' && !alreadyDeducted) {
      const balRef = db.ref(`users/${uid}/balance`);
      const tx = await balRef.transaction(v => { const b = num(v); if (b === null || b < amount) return; return Math.round((b - amount) * 100) / 100; });
      if (!tx.committed) { await sendMessage(chatId, '⚠️ Insufficient balance.'); clearSession(chatId); await sendMessage(chatId, 'Menu:', { reply_markup: mainMenuKeyboard() }); return; }
    }
    const id = db.ref('moneyRequests').push().key;
    const request = { uid, type, amount, status: 'pending', transactionId: transactionId || null, createdAt: admin.database.ServerValue.TIMESTAMP };
    await db.ref().update({ [`moneyRequests/${id}`]: request, [`users/${uid}/transactions/${id}`]: request });
    clearSession(chatId);
    await sendMessage(chatId, `✅ ${type === 'deposit' ? 'Deposit' : 'Withdrawal'} request sent (ID: ${id}). Waiting for admin approval.`, { reply_markup: mainMenuKeyboard() });
  }

  async function startTransfer(chatId) {
    setSession(chatId, { awaiting: 'transfer_recipient' });
    await sendMessage(chatId, '🎁 Enter the recipient\'s Telegram ID:', { reply_markup: { remove_keyboard: true } });
  }
  async function transferRecipient(chatId, text) {
    const targetTelegramId = String(text).trim();
    if (!/^\d+$/.test(targetTelegramId)) { await sendMessage(chatId, '⚠️ Please send a numeric Telegram ID.'); return; }
    const targetUid = `tg_${targetTelegramId}`;
    const exists = await db.ref(`users/${targetUid}`).once('value');
    if (!exists.exists()) { await sendMessage(chatId, '⚠️ No user found with that Telegram ID.'); return; }
    setSession(chatId, { awaiting: 'transfer_amount', transferTarget: targetUid });
    await sendMessage(chatId, '💵 Enter the amount (ETB) to transfer:');
  }
  async function finishTransfer(chatId, uid, text) {
    const s = getSession(chatId); const targetUid = s.transferTarget;
    const amount = money(text);
    if (amount === null) { await sendMessage(chatId, '⚠️ Invalid amount.'); return; }
    if (targetUid === uid) { await sendMessage(chatId, '⚠️ You cannot transfer to yourself.'); clearSession(chatId); return; }
    const balRef = db.ref(`users/${uid}/balance`);
    const tx = await balRef.transaction(v => { const b = num(v); if (b === null || b < amount) return; return Math.round((b - amount) * 100) / 100; });
    if (!tx.committed) { await sendMessage(chatId, '⚠️ Insufficient balance.'); clearSession(chatId); await sendMessage(chatId, 'Menu:', { reply_markup: mainMenuKeyboard() }); return; }
    await db.ref(`users/${targetUid}/balance`).transaction(v => Math.round(((Number(v) || 0) + amount) * 100) / 100);
    const id = db.ref('moneyRequests').push().key;
    const now = admin.database.ServerValue.TIMESTAMP;
    await db.ref().update({
      [`users/${uid}/transactions/${id}`]: { type: 'transfer_out', amount, to: targetUid, status: 'completed', createdAt: now },
      [`users/${targetUid}/transactions/${id}`]: { type: 'transfer_in', amount, from: uid, status: 'completed', createdAt: now },
    });
    clearSession(chatId);
    await sendMessage(chatId, `✅ Transferred ${amount} ETB.`, { reply_markup: mainMenuKeyboard() });
  }

  // ---------------- Play: stake -> card grid -> live game ----------------
  async function showStakeMenu(chatId) {
    await sendMessage(chatId, '🎮 Choose your stake:', {
      reply_markup: { inline_keyboard: [
        [{ text: 'Play 10', callback_data: 'stake:10' }, { text: 'Play 20', callback_data: 'stake:20' }],
        [{ text: 'Play 50', callback_data: 'stake:50' }, { text: 'Play 100', callback_data: 'stake:100' }],
      ] },
    });
  }

  async function buildCardGridKeyboard(stake, page) {
    const roomId = `stake_${stake}_open`;
    const takenSnap = await db.ref(`rooms/${roomId}/taken`).once('value');
    const taken = takenSnap.val() || {};
    const start = page * CARDS_PER_PAGE + 1;
    const end = Math.min(start + CARDS_PER_PAGE - 1, MAX_CARTELA);
    const rows = [];
    let row = [];
    for (let n = start; n <= end; n++) {
      row.push({ text: taken[n] ? `❌${n}` : `${n}`, callback_data: `card:${stake}:${n}` });
      if (row.length === 8) { rows.push(row); row = []; }
    }
    if (row.length) rows.push(row);
    const nav = [];
    if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: `page:${stake}:${page - 1}` });
    if (end < MAX_CARTELA) nav.push({ text: 'Next ➡️', callback_data: `page:${stake}:${page + 1}` });
    if (nav.length) rows.push(nav);
    rows.push([{ text: '← Back', callback_data: 'stake:back' }]);
    return { inline_keyboard: rows };
  }

  async function showCardGrid(chatId, messageId, stake, page) {
    const kb = await buildCardGridKeyboard(stake, page);
    const text = `🎯 Choose your cartela (${page * CARDS_PER_PAGE + 1}–${Math.min((page + 1) * CARDS_PER_PAGE, MAX_CARTELA)}):`;
    if (messageId) await editMessage(chatId, messageId, text, { reply_markup: kb });
    else await sendMessage(chatId, text, { reply_markup: kb });
  }

  async function joinRoom(chatId, uid, stake, cardNo) {
    const roomId = `stake_${stake}_open`, roomRef = db.ref(`rooms/${roomId}`), balRef = db.ref(`users/${uid}/balance`);
    const btx = await balRef.transaction(v => { const b = num(v); if (b === null || b < stake) return; return Math.round((b - stake) * 100) / 100; });
    if (!btx.committed) { await sendMessage(chatId, '⚠️ Insufficient balance for this stake.'); return; }
    const jtx = await roomRef.transaction(room => {
      room = room || { stake, state: 'waiting', players: {}, taken: {} };
      if (room.state !== 'waiting' || Number(room.stake) !== stake) return;
      room.players = room.players || {}; room.taken = room.taken || {};
      if (room.players[uid]) return;
      if (room.taken[String(cardNo)]) return;
      room.players[uid] = { cartelaNumber: cardNo, joinedAt: Date.now() };
      room.taken[String(cardNo)] = true;
      return room;
    });
    if (!jtx.committed) { await balRef.transaction(v => (num(v) || 0) + stake); await sendMessage(chatId, '⚠️ That cartela is already taken, pick another.'); return; }
    let room = jtx.snapshot.val();
    const count = Object.keys(room.players || {}).length;
    if (count >= 2) { await roomRef.update({ state: 'running', startedAt: admin.database.ServerValue.TIMESTAMP, calledNumbers: {} }); }
    const card = getCard(cardNo);
    const sent = await sendMessage(chatId, renderGameText(card, [], null), { reply_markup: gameKeyboard() });
    const messageId = sent && sent.result && sent.result.message_id;
    startGameWatcher(chatId, uid, roomId, cardNo, card, messageId);
  }

  function gameKeyboard() { return { inline_keyboard: [[{ text: '🏆 BINGO!', callback_data: 'bingo' }], [{ text: '❌ Leave', callback_data: 'leave' }]] }; }
  function renderGameText(card, calledArr, lastCalled) {
    const cols = ['B', 'I', 'N', 'G', 'O'];
    const called = new Set(calledArr);
    const mark = v => v === 'FREE' ? `[${v}]` : (called.has(Number(v)) ? `[${v}]` : `${v}`);
    let grid = cols.map(c => c).join('  ') + '\n';
    for (let r = 0; r < 5; r++) grid += cols.map(c => String(mark(card[c][r])).padEnd(4)).join('') + '\n';
    return `🔔 Last called: <b>${lastCalled ?? '-'}</b>\n\n<pre>${grid}</pre>`;
  }

  const watchers = new Map(); // key: `${chatId}` -> intervalId
  function startGameWatcher(chatId, uid, roomId, cardNo, card, messageId) {
    stopGameWatcher(chatId);
    const intervalId = setInterval(async () => {
      const snap = await db.ref(`rooms/${roomId}`).once('value');
      const room = snap.val();
      if (!room) return;
      const calledArr = Object.keys(room.calledNumbers || {}).map(Number);
      if (messageId) await editMessage(chatId, messageId, renderGameText(card, calledArr, room.lastCalled), { reply_markup: gameKeyboard() }).catch(() => {});
      if (room.state === 'finished') {
        stopGameWatcher(chatId);
        const won = room.winner === uid;
        await sendMessage(chatId, won ? `🏆 You won ${room.prize} ETB!` : '😢 Round ended — better luck next time.', { reply_markup: mainMenuKeyboard() });
      }
    }, CALL_INTERVAL_MS);
    watchers.set(chatId, { intervalId, roomId, uid, cardNo });
  }
  function stopGameWatcher(chatId) { const w = watchers.get(chatId); if (w) { clearInterval(w.intervalId); watchers.delete(chatId); } }

  async function claimBingo(chatId, uid) {
    const w = watchers.get(chatId);
    if (!w) { await sendMessage(chatId, '⚠️ You are not in an active game.'); return; }
    const roomRef = db.ref(`rooms/${w.roomId}`);
    const snap = await roomRef.once('value'); const room = snap.val();
    if (!room || room.state !== 'running') { await sendMessage(chatId, '⚠️ Room not active.'); return; }
    const called = new Set(Object.keys(room.calledNumbers || {}).map(Number));
    if (!hasBingo(w.cardNo, called)) { await sendMessage(chatId, '⚠️ No BINGO on your card yet.'); return; }
    const count = Object.keys(room.players || {}).length;
    const gross = Number(room.stake) * count;
    const prize = Math.floor(gross * (1 - HOUSE_CUT));
    const claimTx = await roomRef.transaction(r => { if (!r || r.state !== 'running' || !r.players || !r.players[uid]) return; return { ...r, state: 'finished', winner: uid, prize, payoutStatus: 'pending', finishedAt: Date.now() }; });
    if (!claimTx.committed) { await sendMessage(chatId, '⚠️ This round has already been claimed.'); return; }
    await db.ref(`users/${uid}/balance`).transaction(v => (num(v) || 0) + prize);
    await roomRef.update({ payoutStatus: 'paid' });
    const txId = db.ref(`users/${uid}/transactions`).push().key;
    await db.ref(`users/${uid}/transactions/${txId}`).set({ type: 'win', amount: prize, roomId: w.roomId, status: 'completed', createdAt: admin.database.ServerValue.TIMESTAMP });
  }

  // ---------------- Webhook entry point ----------------
  async function handleUpdate(update) {
    try {
      if (update.callback_query) return await onCallback(update.callback_query);
      if (update.message) return await onMessage(update.message);
    } catch (e) { console.error('bot handleUpdate:', e); }
  }

  async function onMessage(msg) {
    const chatId = msg.chat.id;
    const uid = `tg_${msg.from.id}`;
    await getOrCreateUser(msg.from);

    if (msg.contact) return handleRegister(chatId, uid, msg.contact);

    const text = (msg.text || '').trim();
    const session = getSession(chatId);

    if (text === '/start') {
      const startParam = text.split(' ')[1];
      await applyReferral(uid, startParam);
      clearSession(chatId);
      await sendMessage(chatId, '👋 Welcome to Beteseb Bingo! Choose an option below.', { reply_markup: mainMenuKeyboard() });
      return;
    }

    if (session.awaiting === 'register_contact') return; // waiting for the contact share button
    if (session.awaiting === 'deposit_amount') return finishDeposit(chatId, uid, text);
    if (session.awaiting === 'deposit_txn_id') return finishDepositTxnId(chatId, uid, text);
    if (session.awaiting === 'withdraw_amount') return finishWithdraw(chatId, uid, text);
    if (session.awaiting === 'transfer_recipient') return transferRecipient(chatId, text);
    if (session.awaiting === 'transfer_amount') return finishTransfer(chatId, uid, text);

    switch (text) {
      case MENU_TEXT.play: return showStakeMenu(chatId);
      case MENU_TEXT.register: return handleRegister(chatId, uid, null);
      case MENU_TEXT.balance: return handleBalance(chatId, uid);
      case MENU_TEXT.deposit: return startDeposit(chatId);
      case MENU_TEXT.support: return handleSupport(chatId);
      case MENU_TEXT.instruction: return handleInstruction(chatId);
      case MENU_TEXT.transfer: return startTransfer(chatId);
      case MENU_TEXT.withdraw: return startWithdraw(chatId);
      case MENU_TEXT.invite: return handleInvite(chatId, uid);
      case MENU_TEXT.bonus: return handleConvertBonus(chatId, uid);
      default: await sendMessage(chatId, 'እባክህ ከታች ካሉት options ውስጥ ምረጥ 👇', { reply_markup: mainMenuKeyboard() });
    }
  }

  async function onCallback(cq) {
    const chatId = cq.message.chat.id;
    const messageId = cq.message.message_id;
    const uid = `tg_${cq.from.id}`;
    const data = cq.data || '';
    await getOrCreateUser(cq.from);

    if (data === 'stake:back') {
      await answerCallback(cq.id);
      const kb = { inline_keyboard: [
        [{ text: 'Play 10', callback_data: 'stake:10' }, { text: 'Play 20', callback_data: 'stake:20' }],
        [{ text: 'Play 50', callback_data: 'stake:50' }, { text: 'Play 100', callback_data: 'stake:100' }],
      ] };
      return editMessage(chatId, messageId, '🎮 Choose your stake:', { reply_markup: kb });
    }
    if (data.startsWith('stake:')) {
      const stake = Number(data.split(':')[1]);
      if (!ALLOWED_STAKES.includes(stake)) return answerCallback(cq.id, 'Invalid stake');
      await answerCallback(cq.id);
      return showCardGrid(chatId, messageId, stake, 0);
    }
    if (data.startsWith('page:')) {
      const [, stake, page] = data.split(':');
      await answerCallback(cq.id);
      return showCardGrid(chatId, messageId, Number(stake), Number(page));
    }
    if (data.startsWith('card:')) {
      const [, stake, cardNo] = data.split(':');
      await answerCallback(cq.id, 'Joining...');
      return joinRoom(chatId, uid, Number(stake), Number(cardNo));
    }
    if (data === 'bingo') { await answerCallback(cq.id, 'Checking...'); return claimBingo(chatId, uid); }
    if (data === 'leave') { stopGameWatcher(chatId); await answerCallback(cq.id, 'Left the game'); return sendMessage(chatId, 'Menu:', { reply_markup: mainMenuKeyboard() }); }
    return answerCallback(cq.id);
  }

  async function setWebhook(publicUrl, secretToken) {
    if (!publicUrl) { console.warn('setWebhook skipped: no public URL provided'); return; }
    const res = await tgCall('setWebhook', { url: `${publicUrl.replace(/\/$/, '')}/telegram/webhook`, secret_token: secretToken || undefined });
    console.log('setWebhook result:', res && res.ok ? 'ok' : res);
  }

  return { handleUpdate, setWebhook };
};
