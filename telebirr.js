// telebirr.js — Telebirr integration adapter.
//
// IMPORTANT: Telebirr's exact Business/Merchant API request format, auth
// scheme (some accounts use signed requests with a public/private key pair,
// others use a bearer app secret) and endpoint paths depend on which
// merchant product you were enrolled in. The functions below are a working
// SHAPE (env-configured, used by telegramBot.js) but the two TODO blocks
// marked "FILL IN FROM YOUR TELEBIRR DOCS" must be adjusted to match the
// actual request/response your documentation shows, or real money flows
// will fail silently into the manual fallback. Send me the docs/credentials
// and I will fill these in exactly — until then, deposit/withdraw keep
// working the old manual (admin-approve) way automatically.

const TELEBIRR_API_BASE = process.env.TELEBIRR_API_BASE || '';
const TELEBIRR_APP_ID = process.env.TELEBIRR_APP_ID || '';
const TELEBIRR_APP_SECRET = process.env.TELEBIRR_APP_SECRET || '';
const TELEBIRR_SHORT_CODE = process.env.TELEBIRR_SHORT_CODE || '';

const ENABLED = Boolean(TELEBIRR_API_BASE && TELEBIRR_APP_ID && TELEBIRR_APP_SECRET);

/**
 * Checks whether a deposit transaction ID is real, unused, and matches the
 * claimed amount. Must return { ok: true } only when Telebirr itself
 * confirms the payment — never trust the user-entered amount alone.
 */
async function verifyDeposit(transactionId, claimedAmount) {
  if (!ENABLED) return { ok: false, reason: 'not_configured' };
  try {
    // ---- FILL IN FROM YOUR TELEBIRR DOCS ----
    // Example shape only — replace path/body/headers with the real spec:
    const res = await fetch(`${TELEBIRR_API_BASE}/transaction/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TELEBIRR_APP_SECRET}` },
      body: JSON.stringify({ appId: TELEBIRR_APP_ID, shortCode: TELEBIRR_SHORT_CODE, transactionId }),
    });
    const data = await res.json();
    // Adjust these field names to match the real response body:
    const success = data && (data.status === 'SUCCESS' || data.resultCode === '0');
    const amount = data && Number(data.amount);
    if (!success) return { ok: false, reason: 'not_found_or_failed' };
    if (Number(claimedAmount) !== amount) return { ok: false, reason: 'amount_mismatch', amount };
    return { ok: true, amount };
    // ---- END FILL IN ----
  } catch (e) {
    console.error('telebirr.verifyDeposit error:', e.message);
    return { ok: false, reason: 'error' };
  }
}

/**
 * Sends a real payout to the player's Telebirr phone number.
 */
async function sendPayout(phone, amount) {
  if (!ENABLED) return { ok: false, reason: 'not_configured' };
  if (!phone) return { ok: false, reason: 'no_phone_on_file' };
  try {
    // ---- FILL IN FROM YOUR TELEBIRR DOCS ----
    const res = await fetch(`${TELEBIRR_API_BASE}/transfer/payout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TELEBIRR_APP_SECRET}` },
      body: JSON.stringify({ appId: TELEBIRR_APP_ID, shortCode: TELEBIRR_SHORT_CODE, receiverPhone: phone, amount }),
    });
    const data = await res.json();
    const success = data && (data.status === 'SUCCESS' || data.resultCode === '0');
    if (!success) return { ok: false, reason: data && data.message || 'payout_failed' };
    return { ok: true, providerRef: data.transactionId || data.txnId || null };
    // ---- END FILL IN ----
  } catch (e) {
    console.error('telebirr.sendPayout error:', e.message);
    return { ok: false, reason: 'error' };
  }
}

module.exports = { ENABLED, verifyDeposit, sendPayout };
