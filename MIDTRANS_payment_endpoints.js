// ADD THESE TO YOUR FINAL_server.js

const midtransClient = require('midtrans-client');

// Initialize Midtrans Snap
let snap = new midtransClient.Snap({
  isProduction: false,
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY,
});

// ===== PAYMENT ENDPOINTS =====

// POST /api/payment/subscribe
app.post('/api/payment/subscribe', authenticateToken, async (req, res) => {
  try {
    const { plan } = req.body; // 'monthly' or 'yearly'
    const user = req.user;

    // Determine price & duration
    const plans = {
      monthly: { price: 49000, duration: 30, name: 'Premium 1 Month' },
      yearly: { price: 399000, duration: 365, name: 'Premium 1 Year' },
    };

    if (!plans[plan]) {
      return res.status(400).json({ ok: false, error: 'Invalid plan' });
    }

    const planData = plans[plan];

    // Create Midtrans transaction
    const orderId = `ORDER-${user.id}-${Date.now()}`;

    const transactionDetails = {
      transaction_details: {
        order_id: orderId,
        gross_amount: planData.price,
      },
      customer_details: {
        email: user.email,
        first_name: user.name,
        phone: user.phone || '08123456789',
      },
      item_details: [
        {
          id: plan,
          price: planData.price,
          quantity: 1,
          name: planData.name,
        },
      ],
    };

    // Get snap token
    const token = await snap.createTransaction(transactionDetails);

    // Save transaction to DB
    await db.query(
      `INSERT INTO transactions (user_id, order_id, plan, amount, status, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [user.id, orderId, plan, planData.price, 'pending']
    );

    res.json({
      ok: true,
      snapToken: token.token,
      snapUrl: token.redirect_url,
    });
  } catch (error) {
    console.error('Payment error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// POST /api/payment/callback (Midtrans webhook)
app.post('/api/payment/callback', async (req, res) => {
  try {
    const notification = req.body;

    // Verify signature
    const signature = require('crypto')
      .createHash('sha512')
      .update(
        notification.order_id +
        notification.status_code +
        notification.gross_amount +
        process.env.MIDTRANS_SERVER_KEY
      )
      .digest('hex');

    if (signature !== notification.signature_key) {
      return res.status(401).json({ ok: false, error: 'Invalid signature' });
    }

    const transactionStatus = notification.transaction_status;
    const orderId = notification.order_id;

    // Update DB
    let newStatus = 'pending';
    let subscriptionDays = 0;

    if (transactionStatus === 'capture' || transactionStatus === 'settlement') {
      newStatus = 'success';
      // Get plan and set days
      const txResult = await db.query(
        `SELECT plan FROM transactions WHERE order_id = $1`,
        [orderId]
      );
      subscriptionDays = txResult.rows[0].plan === 'yearly' ? 365 : 30;
    } else if (transactionStatus === 'cancel' || transactionStatus === 'deny') {
      newStatus = 'failed';
    }

    // Update transaction
    await db.query(
      `UPDATE transactions SET status = $1, updated_at = NOW()
       WHERE order_id = $2`,
      [newStatus, orderId]
    );

    // If success, update user subscription
    if (newStatus === 'success') {
      const userResult = await db.query(
        `SELECT id FROM transactions WHERE order_id = $1`,
        [orderId]
      );
      const userId = userResult.rows[0].user_id;

      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + subscriptionDays);

      await db.query(
        `UPDATE users SET subscription_status = 'active', 
         subscription_expiry = $1, trial_days_remaining = 0
         WHERE id = $2`,
        [expiryDate, userId]
      );

      console.log(`✅ Payment success for user ${userId}`);
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('Callback error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/payment/status/:orderId
app.get('/api/payment/status/:orderId', authenticateToken, async (req, res) => {
  try {
    const { orderId } = req.params;

    const result = await db.query(
      `SELECT * FROM transactions WHERE order_id = $1 AND user_id = $2`,
      [orderId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Transaction not found' });
    }

    const transaction = result.rows[0];

    res.json({
      ok: true,
      transaction,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});
