// telebirr.js — Ethio Telecom TeleBirr C2B WebCheckout integration.
//
// Flow implemented here (matches the Node.js sample code + tools.js +
// test.js you shared from the Developer Portal's C2B WebCheckout demo):
//
//   1. applyFabricToken() -> POST {API_BASE}/payment/v1/token
//        Exchanges our App Secret for a short-lived fabric token.
//
//   2. createCheckoutOrder() -> POST {API_BASE}/payment/v1/merchant/preOrder
//        Creates a prepay order signed with our PRIVATE key, gets back a
//        prepay_id, then builds the signed checkout URL the player's
//        browser must be sent to (payment/web/paygate?...).
//
//   3. parseNotify() — call this from the /telegram/telebirr-notify route.
//        Telebirr POSTs the payment result to NOTIFY_URL; we verify the
//        signature with Telebirr's PUBLIC key (never our private key) and
//        return whether it's a genuine, completed payment.
//
// sendPayout() (withdrawals TO a player) is left as a stub: the C2B
// WebCheckout demo only covers customer -> merchant payments. Sending
// money out uses a separate Telebirr B2C/disbursement product that needs
// its own credentials/docs — until then withdrawals keep working the old
// manual (admin-approve) way automatically.

const rs = require('jsrsasign');

/*
 * IMPORTANT — confirm these two base URLs against your config.js:
 * they were inferred from your screenshots (the ApplyFabricToken "Request
 * URL" hint + the paygate links in test.js). If your config.js has
 * different values, override them with TELEBIRR_API_BASE /
 * TELEBIRR_CHECKOUT_BASE env vars instead of editing this file.
 */
const API_BASE =
  process.env.TELEBIRR_API_BASE ||
  'https://developerportal.ethiotelebirr.et:38443/apiaccess';

const CHECKOUT_BASE =
  process.env.TELEBIRR_CHECKOUT_BASE ||
  'https://developerportal.ethiotelebirr.et:38443/payment/web/paygate';

const FABRIC_APP_ID = process.env.TELEBIRR_FABRIC_APP_ID || '';
const APP_SECRET = process.env.TELEBIRR_APP_SECRET || '';
const MERCHANT_APP_ID = process.env.TELEBIRR_MERCHANT_APP_ID || '';
const MERCHANT_CODE = process.env.TELEBIRR_MERCHANT_CODE || ''; // ShortCode

// Railway env vars can't hold real newlines — store the PEM with "\n"
// escapes and we un-escape it here.
const PRIVATE_KEY = (process.env.TELEBIRR_PRIVATE_KEY || '').replace(
  /\\n/g,
  '\n'
);

// Telebirr's PUBLIC key (from the Keys tab's "Public Key" field), used to
// verify the notify callback is genuinely from Telebirr.
const TELEBIRR_PUBLIC_KEY = (
  process.env.TELEBIRR_PUBLIC_KEY || ''
).replace(/\\n/g, '\n');

// Your own server's notify endpoint, e.g.
// https://<your-app>.up.railway.app/telegram/telebirr-notify
const NOTIFY_URL = process.env.TELEBIRR_NOTIFY_URL || '';

const ENABLED = Boolean(
  FABRIC_APP_ID &&
    APP_SECRET &&
    MERCHANT_APP_ID &&
    MERCHANT_CODE &&
    PRIVATE_KEY
);

const EXCLUDE_FIELDS = [
  'sign',
  'sign_type',
  'header',
  'refund_info',
  'openType',
  'raw_request',
  'biz_content',
];

function createNonceStr() {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let str = '';
  for (let i = 0; i < 32; i++) {
    str += chars[Math.floor(Math.random() * chars.length)];
  }
  return str;
}

function createTimestamp() {
  return Math.round(Date.now() / 1000) + '';
}

/*
 * Collect every field of `obj` (plus its biz_content, if any) except
 * EXCLUDE_FIELDS, sort by ASCII key, join as key=value with '&'.
 * This exact string is what gets signed / verified.
 */
function buildSignString(obj) {
  const fields = [];
  const map = {};

  for (const key in obj) {
    if (EXCLUDE_FIELDS.includes(key)) continue;
    fields.push(key);
    map[key] = obj[key];
  }

  if (obj.biz_content) {
    const biz =
      typeof obj.biz_content === 'string'
        ? JSON.parse(obj.biz_content)
        : obj.biz_content;

    for (const key in biz) {
      if (EXCLUDE_FIELDS.includes(key)) continue;
      fields.push(key);
      map[key] = biz[key];
    }
  }

  fields.sort();

  return fields.map(k => `${k}=${map[k]}`).join('&');
}

function signObject(obj, privateKey) {
  const signStr = buildSignString(obj);

  const sig = new rs.KJUR.crypto.Signature({
    alg: 'SHA256withRSAandMGF1',
  });
  sig.init(privateKey);
  sig.updateString(signStr);
  return rs.hextob64(sig.sign());
}

function verifySignature(obj, signatureB64, publicKey) {
  try {
    const signStr = buildSignString(obj);

    const sig = new rs.KJUR.crypto.Signature({
      alg: 'SHA256withRSAandMGF1',
    });
    sig.init(publicKey);
    sig.updateString(signStr);
    return sig.verify(rs.b64tohex(signatureB64));
  } catch (e) {
    console.error('telebirr.verifySignature error:', e.message);
    return false;
  }
}

/*
 * Step 1: exchange our App Secret for a short-lived fabric token.
 */
async function applyFabricToken() {
  const res = await fetch(`${API_BASE}/payment/v1/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-APP-Key': FABRIC_APP_ID,
    },
    body: JSON.stringify({ appSecret: APP_SECRET }),
  });

  const data = await res.json();

  if (!data || !data.token) {
    throw new Error(
      'applyFabricToken failed: ' + JSON.stringify(data)
    );
  }

  return data.token;
}

/*
 * Steps 2 + 3: create a prepay order, then build the signed checkout URL
 * the player's browser (or Telegram in-app browser) should be sent to.
 *
 * `merchOrderId` should be OUR OWN reference (pass the Firebase
 * moneyRequests/{id} key) so the notify callback can be matched back to
 * the right deposit request.
 */
async function createCheckoutOrder({ merchOrderId, title, amount }) {
  if (!ENABLED) {
    throw new Error(
      'Telebirr is not configured — missing one of TELEBIRR_FABRIC_APP_ID / ' +
        'TELEBIRR_APP_SECRET / TELEBIRR_MERCHANT_APP_ID / TELEBIRR_MERCHANT_CODE / ' +
        'TELEBIRR_PRIVATE_KEY'
    );
  }

  const fabricToken = await applyFabricToken();

  const orderReq = {
    timestamp: createTimestamp(),
    nonce_str: createNonceStr(),
    method: 'payment.preorder',
    version: '1.0',
    biz_content: {
      notify_url: NOTIFY_URL,
      trade_type: 'Checkout',
      appid: MERCHANT_APP_ID,
      merch_code: MERCHANT_CODE,
      merch_order_id: merchOrderId,
      title: title || 'Beteseb Bingo Deposit',
      total_amount: String(amount),
      trans_currency: 'ETB',
      timeout_express: '120m',
      business_type: 'BuyGoods',
      payee_identifier: MERCHANT_CODE,
      payee_identifier_type: '04',
      payee_type: '5000',
    },
  };

  orderReq.sign = signObject(orderReq, PRIVATE_KEY);
  orderReq.sign_type = 'SHA256WithRSA';

  const res = await fetch(`${API_BASE}/payment/v1/merchant/preOrder`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-APP-Key': FABRIC_APP_ID,
      Authorization: fabricToken,
    },
    body: JSON.stringify(orderReq),
  });

  const data = await res.json();

  if (
    !data ||
    data.result !== 'SUCCESS' ||
    !data.biz_content ||
    !data.biz_content.prepay_id
  ) {
    throw new Error('createOrder failed: ' + JSON.stringify(data));
  }

  const prepayId = data.biz_content.prepay_id;

  const checkoutFields = {
    appid: MERCHANT_APP_ID,
    merch_code: MERCHANT_CODE,
    nonce_str: createNonceStr(),
    prepay_id: prepayId,
    timestamp: createTimestamp(),
    version: '1.0',
    trade_type: 'Checkout',
  };

  const sign = signObject(checkoutFields, PRIVATE_KEY);

  const query = [
    `appid=${encodeURIComponent(checkoutFields.appid)}`,
    `merch_code=${encodeURIComponent(checkoutFields.merch_code)}`,
    `nonce_str=${encodeURIComponent(checkoutFields.nonce_str)}`,
    `prepay_id=${encodeURIComponent(checkoutFields.prepay_id)}`,
    `timestamp=${encodeURIComponent(checkoutFields.timestamp)}`,
    `sign=${encodeURIComponent(sign)}`,
    'sign_type=SHA256WithRSA',
    'version=1.0',
    'trade_type=Checkout',
  ].join('&');

  return {
    checkoutUrl: `${CHECKOUT_BASE}?${query}`,
    prepayId,
    merchOrderId,
  };
}

/*
 * Call this from your POST /telegram/telebirr-notify route with the raw
 * parsed JSON body Telebirr sent you.
 *
 * Returns:
 *   { ok: true, merchOrderId, amount }               on a verified success
 *   { ok: false, reason: '...' }                      otherwise — do NOT
 *                                                      credit any balance
 */
function parseNotify(body) {
  if (!TELEBIRR_PUBLIC_KEY) {
    return { ok: false, reason: 'public_key_not_configured' };
  }

  if (!body || !body.sign) {
    return { ok: false, reason: 'missing_signature' };
  }

  const verified = verifySignature(body, body.sign, TELEBIRR_PUBLIC_KEY);

  if (!verified) {
    return { ok: false, reason: 'bad_signature' };
  }

  const biz =
    typeof body.biz_content === 'string'
      ? JSON.parse(body.biz_content)
      : body.biz_content || {};

  const success =
    body.result === 'SUCCESS' || biz.trade_status === 'Completed';

  if (!success) {
    return { ok: false, reason: 'not_completed' };
  }

  return {
    ok: true,
    merchOrderId: biz.merch_order_id,
    amount: Number(biz.total_amount),
  };
}

/*
 * Withdrawals TO a player use a different Telebirr product (B2C /
 * disbursement) not covered by the C2B WebCheckout demo. Left as a stub
 * so nothing breaks — withdrawals keep going through the existing manual
 * admin-approve flow until you get separate B2C credentials.
 */
async function sendPayout(phone, amount) {
  return { ok: false, reason: 'not_configured_b2c' };
}

module.exports = {
  ENABLED,
  createCheckoutOrder,
  parseNotify,
  sendPayout,
};
