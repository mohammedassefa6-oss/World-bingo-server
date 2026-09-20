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
const MAX_CARTELA = 600;
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
