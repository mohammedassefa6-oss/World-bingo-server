// telebirrC2B.js — Telebirr C2B WebCheckout integration based on
// the Node.js C2B_WebCheckoutDemo supplied by the Telebirr Developer Portal.
// Secrets are read only from environment variables.

const crypto = require('crypto');
const https = require('https');

const BASE_URL = String(
  process.env.TELEBIRR_BASE_URL ||
  'https://developerportal.ethiotelebirr.et:38443/apiaccess/payment/gateway'
).replace(/\\\/$/, '');

const WEB_BASE_URL = String(
  process.env.TELEBIRR_WEB_BASE_URL ||
  'https://developerportal.ethiotelebirr.et:38443/payment/web/paygate?'
);

const FABRIC_APP_ID = String(process.env.TELEBIRR_FABRIC_APP_ID || '');
const APP_SECRET = String(process.env.TELEBIRR_APP_SECRET || '');
const MERCHANT_APP_ID = String(process.env.TELEBIRR_MERCHANT_APP_ID || '');
const MERCHANT_CODE = String(process.env.TELEBIRR_MERCHANT_CODE || '');
const PRIVATE_KEY = String(process.env.TELEBIRR_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const configured = Boolean(
  FABRIC_APP_ID && APP_SECRET && MERCHANT_APP_ID && MERCHANT_CODE && PRIVATE_KEY
);

function nonce() {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

function timestamp() {
  return Math.floor(Date.now() / 1000).toString();
}

function signRequestObject(obj) {
  const fields = [];
  const map = {};
  const excluded = new Set([
    'sign', 'sign_type', 'header', 'refund_info', 'openType', 'raw_request', 'biz_content'
  ]);

  for (const [key, value] of Object.entries(obj || {})) {
    if (!excluded.has(key)) {
      fields.push(key);
      map[key] = value;
    }
  }

  if (obj && obj.biz_content && typeof obj.biz_content === 'object') {
    for (const [key, value] of Object.entries(obj.biz_content)) {
      if (!excluded.has(key)) {
        fields.push(key);
        map[key] = value;
      }
    }
  }

  fields.sort();
  const origin = fields.map(k => `${k}=${map[k]}`).join('&');

  return crypto.sign(
    'sha256',
    Buffer.from(origin, 'utf8'),
    {
      key: PRIVATE_KEY,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32
    }
  ).toString('base64');
}

function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const verifyTls = String(process.env.TELEBIRR_VERIFY_TLS || 'true').toLowerCase() !== 'false';

    const req = https.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers
      },
      rejectUnauthorized: verifyTls
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let parsedBody;
        try { parsedBody = JSON.parse(raw || '{}'); }
        catch { return reject(new Error(`Telebirr returned non-JSON response (HTTP ${res.statusCode})`)); }
        if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
          const msg = parsedBody.errorMsg || parsedBody.msg || `HTTP ${res.statusCode}`;
          return reject(new Error(`Telebirr API error: ${msg}`));
        }
        resolve(parsedBody);
      });
    });

    req.setTimeout(30000, () => req.destroy(new Error('Telebirr request timed out')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function applyFabricToken() {
  if (!configured) throw new Error('Telebirr C2B credentials are not configured');
  return postJson(`${BASE_URL}/payment/v1/token`, { appSecret: APP_SECRET }, {
    'X-APP-Key': FABRIC_APP_ID
  });
}

function createMerchantOrderId() {
  return `TB${Date.now()}${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

async function createOrder({ title, amount, merchantOrderId }) {
  const tokenInfo = await applyFabricToken();
  const fabricToken = tokenInfo.token;
  if (!fabricToken) throw new Error('Telebirr did not return a fabric token');

  const merchOrderId = merchantOrderId || createMerchantOrderId();
  const req = {
    timestamp: timestamp(),
    nonce_str: nonce(),
    method: 'payment.preorder',
    version: '1.0',
    biz_content: {
      notify_url: String(process.env.TELEBIRR_NOTIFY_URL || `${publicUrl()}/telebirr/notify`),
      appid: MERCHANT_APP_ID,
      merch_code: MERCHANT_CODE,
      merch_order_id: merchOrderId,
      trade_type: 'Checkout',
      title: String(title || 'Beteseb Bingo Deposit').slice(0, 100),
      total_amount: Number(amount).toFixed(2),
      trans_currency: 'ETB',
      timeout_express: '120m'
    }
  };
  req.sign = signRequestObject(req);
  req.sign_type = 'SHA256WithRSA';

  const result = await postJson(`${BASE_URL}/payment/v1/merchant/preOrder`, req, {
    'X-APP-Key': FABRIC_APP_ID,
    'Authorization': fabricToken
  });

  const prepayId = result?.biz_content?.prepay_id;
  if (!prepayId) throw new Error(result?.msg || 'Telebirr did not return prepay_id');

  const raw = {
    appid: MERCHANT_APP_ID,
    merch_code: MERCHANT_CODE,
    nonce_str: nonce(),
    prepay_id: prepayId,
    timestamp: timestamp()
  };
  const sign = signRequestObject(raw);
  const rawRequest = [
    `appid=${raw.appid}`,
    `merch_code=${raw.merch_code}`,
    `nonce_str=${raw.nonce_str}`,
    `prepay_id=${raw.prepay_id}`,
    `timestamp=${raw.timestamp}`,
    `sign=${encodeURIComponent(sign)}`,
    'sign_type=SHA256WithRSA'
  ].join('&');

  return {
    merchantOrderId: merchOrderId,
    prepayId,
    checkoutUrl: `${WEB_BASE_URL}${rawRequest}&version=1.0&trade_type=Checkout`,
    rawResponse: result
  };
}

async function queryOrder(merchantOrderId) {
  const tokenInfo = await applyFabricToken();
  const req = {
    timestamp: timestamp(),
    nonce_str: nonce(),
    method: 'payment.queryorder',
    version: '1.0',
    biz_content: {
      appid: MERCHANT_APP_ID,
      merch_code: MERCHANT_CODE,
      merch_order_id: String(merchantOrderId)
    }
  };
  req.sign = signRequestObject(req);
  req.sign_type = 'SHA256WithRSA';

  const result = await postJson(`${BASE_URL}/payment/v1/merchant/queryOrder`, req, {
    'X-APP-Key': FABRIC_APP_ID,
    'Authorization': tokenInfo.token
  });

  const biz = result?.biz_content || {};
  return {
    paid: String(biz.trade_status || '').toUpperCase() === 'PAY_SUCCESS',
    tradeStatus: biz.trade_status || '',
    amount: biz.total_amount != null ? Number(biz.total_amount) : null,
    currency: biz.trans_currency || '',
    paymentOrderId: biz.payment_order_id || null,
    merchantOrderId: biz.merch_order_id || merchantOrderId,
    raw: result
  };
}

function publicUrl() {
  return String(
    process.env.PUBLIC_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
  ).replace(/\\\/$/, '');
}

module.exports = {
  configured,
  createOrder,
  queryOrder,
  publicUrl
};
