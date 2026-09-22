// SMS Forwarder Automatic Deposit Endpoint
app.post('/api/sms-callback', async (req, res) => {
  try {
    const { message, secret } = req.body;

    if (secret !== process.env.SMS_SECRET) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    if (!message) {
      return res.status(400).json({ error: 'No message provided' });
    }

    const amountMatch = message.match(/ETB\s*([\d.]+)/i) || message.match(/ብር\s*([\d.]+)/i);
    const txnMatch = message.match(/(TX[A-Z0-9]+)/i) || message.match(/Transaction ID:\s*([A-Z0-9]+)/i);

    if (!amountMatch || !txnMatch) {
      return res.status(400).json({ error: 'Could not parse Telebirr SMS' });
    }

    const amount = parseFloat(amountMatch[1]);
    const telebirrTxnId = txnMatch[1];

    const db = admin.database();

    const requestsRef = db.ref('moneyRequests');
    const snapshot = await requestsRef.once('value');
    const requests = snapshot.val();

    let matchedRequestId = null;
    let matchedRequest = null;

    if (requests) {
      for (const key in requests) {
        const reqData = requests[key];
        if (reqData.status === 'PENDING' && reqData.transactionId === telebirrTxnId) {
          matchedRequestId = key;
          matchedRequest = reqData;
          break;
        }
      }
    }

    if (!matchedRequest) {
      return res.status(404).json({ error: 'Matching pending request not found' });
    }

    const userId = matchedRequest.telegramUserId;
    const userBalanceRef = db.ref(`users/${userId}/balance`);
    await userBalanceRef.transaction((current) => (current || 0) + amount);

    await db.ref(`moneyRequests/${matchedRequestId}`).update({
      status: 'SUCCESS',
      approvedAt: Date.now(),
      autoApproved: true
    });

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const cleanUserId = userId.replace('tg_', '');
    const notificationText = `✅ *Deposit Automatically Approved!*\n\n` +
                             `💵 *Amount:* ${amount} ETB\n` +
                             `🧾 *Txn ID:* ${telebirrTxnId}\n` +
                             `🎉 Your balance has been updated successfully!`;

    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: cleanUserId,
      text: notificationText,
      parse_mode: 'Markdown'
    });

    return res.status(200).json({ success: true, message: 'Balance updated successfully' });

  } catch (error) {
    console.error('SMS Callback Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
