const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const Parser = require('rss-parser');
const midtransClient = require('midtrans-client');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ===== CORS MIDDLEWARE =====
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ===== DATABASE =====
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ===== MIDTRANS SETUP =====
let snap = new midtransClient.Snap({
  isProduction: false,
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY,
});

// ===== CONFIG =====
const JWT_SECRET = process.env.JWT_SECRET || 'newspulse-secret-2024';
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
let newsCache = null;
let lastFetchTime = 0;

// ===== RSS SOURCES =====
const RSS_SOURCES = {
  finance: [
    'https://feeds.bloomberg.com/markets/news.rss',
    'https://feeds.businessinsider.com/finance',
    'https://www.marketwatch.com/rss/topstories',
    'https://finance.yahoo.com/news/rssindex',
  ],
  crypto: [
    'https://feeds.coindesk.com/latest',
    'https://feeds.cointelegraph.com/rss',
    'https://bitcoinmagazine.com/feed',
    'https://www.crypto-news-flash.com/feed/',
    'https://www.theblock.co/post/rss.xml',
    'https://cryptoslate.com/feed/',
    'https://bitcoinmagazine.com/.rss/full/',
    'https://cryptopotato.com/feed/',
    'https://coingape.com/feed/',
    'https://protos.com/feed/',
    'https://blog.ethereum.org/feed.xml',
  ],
  ai: [
    'https://feeds.bloomberg.com/technology/news.rss',
    'https://techcrunch.com/category/artificial-intelligence/feed/',
    'https://www.wired.com/feed/tag/ai/latest/rss',
  ],
  tech: [
    'https://feeds.techcrunch.com/',
    'https://www.theverge.com/rss/index.xml',
    'https://www.wired.com/feed/rss',
  ],
};

// ===== MIDDLEWARE =====
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ ok: false, error: 'No token provided' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(401).json({ ok: false, error: 'Invalid token' });
    req.user = user;
    next();
  });
}

// ===== AUTH ENDPOINTS =====

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ ok: false, error: 'Missing fields' });
    }

    const userCheck = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (userCheck.rows.length > 0) {
      return res.status(400).json({ ok: false, error: 'Email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // FIX 1: Set subscription_status = 'trial' dan created_at saat register
    const result = await db.query(
      `INSERT INTO users (email, password, name, subscription_status, created_at)
       VALUES ($1, $2, $3, 'trial', NOW())
       RETURNING id, email, name`,
      [email, hashedPassword, name]
    );

    const user = result.rows[0];
    const isAdmin = user.email === 'admin@newspulse.com';

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, isAdmin },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isAdmin,
        trial_days_remaining: 5,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'Missing fields' });
    }

    const result = await db.query(
      `SELECT id, email, password, name FROM users WHERE email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    }

    const isAdmin = user.email === 'admin@newspulse.com';

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, isAdmin },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isAdmin,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, email, name, created_at, subscription_status, subscription_expiry 
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    const user = result.rows[0];
    const isAdmin = user.email === 'admin@newspulse.com';

    // FIX 2: Patch existing users yang subscription_status masih NULL
    if (!isAdmin && !user.subscription_status) {
      await db.query(
        `UPDATE users SET subscription_status = 'trial' WHERE id = $1`,
        [user.id]
      );
      user.subscription_status = 'trial';
    }

    // FIX 3: Kalau created_at NULL, set ke sekarang
    if (!user.created_at) {
      await db.query(
        `UPDATE users SET created_at = NOW() WHERE id = $1`,
        [user.id]
      );
      user.created_at = new Date();
    }

    // Calculate trial days remaining
    let trialDaysRemaining = 0;
    let subscriptionLabel = 'expired';

    if (isAdmin) {
      subscriptionLabel = 'admin';
    } else if (user.subscription_status === 'active' && user.subscription_expiry) {
      const expiry = new Date(user.subscription_expiry);
      if (expiry > new Date()) {
        subscriptionLabel = 'active';
        trialDaysRemaining = 0;
      } else {
        subscriptionLabel = 'expired';
      }
    } else if (user.subscription_status === 'trial') {
      const createdDate = new Date(user.created_at);
      const now = new Date();
      const daysElapsed = Math.floor((now - createdDate) / (1000 * 60 * 60 * 24));
      trialDaysRemaining = Math.max(0, 5 - daysElapsed);
      subscriptionLabel = trialDaysRemaining > 0 ? 'trial' : 'expired';
    }

    res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isAdmin,
        trial_days_remaining: trialDaysRemaining,
        subscription_status: subscriptionLabel,
        subscription_expiry: user.subscription_expiry,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ===== NEWS ENDPOINTS =====

async function fetchNews() {
  const now = Date.now();

  if (newsCache && now - lastFetchTime < CACHE_TTL) {
    console.log('📦 Using cached news');
    return newsCache;
  }

  console.log('🔄 Fetching fresh news...');
  const parser = new Parser();
  let allNews = [];

  for (const [category, sources] of Object.entries(RSS_SOURCES)) {
    for (const source of sources) {
      try {
        const feed = await parser.parseURL(source);
        feed.items.slice(0, 3).forEach(item => {
          allNews.push({
            category,
            title: item.title || 'No title',
            description: item.content || item.summary || item.contentSnippet || 'No description',
            link: item.link || '#',
            source: feed.title || 'Unknown',
            pubDate: item.pubDate || new Date().toISOString(),
          });
        });
        console.log(`✅ ${category} - ${feed.title}: ${feed.items.length} items`);
      } catch (error) {
        console.warn(`⚠️  ${source} failed:`, error.message);
      }
    }
  }

  // Deduplicate by title
  const seen = new Set();
  allNews = allNews.filter(item => {
    const key = item.title.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by date (newest first)
  allNews.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  console.log(`📊 Total news fetched: ${allNews.length}`);
  newsCache = allNews;
  lastFetchTime = now;
  return allNews;
}

// GET /api/news
app.get('/api/news', authenticateToken, async (req, res) => {
  try {
    const news = await fetchNews();
    res.json({ ok: true, news });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ===== ADMIN ENDPOINTS =====

// GET /api/admin/stats
app.get('/api/admin/stats', authenticateToken, async (req, res) => {
  try {
    if (req.user.email !== 'admin@newspulse.com') {
      return res.status(403).json({ ok: false, error: 'Not authorized' });
    }

    const totalUsersResult = await db.query('SELECT COUNT(*) as count FROM users');
    const premiumResult = await db.query(
      "SELECT COUNT(*) as count FROM users WHERE subscription_status = 'active'"
    );
    const trialResult = await db.query(
      "SELECT COUNT(*) as count FROM users WHERE subscription_status = 'trial'"
    );
    const revenueResult = await db.query(
      "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE status = 'success'"
    );

    res.json({
      ok: true,
      stats: {
        totalUsers: parseInt(totalUsersResult.rows[0].count),
        premiumUsers: parseInt(premiumResult.rows[0].count),
        trialUsers: parseInt(trialResult.rows[0].count),
        revenue: parseFloat(revenueResult.rows[0].total) / 100 || 0,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET /api/admin/users
app.get('/api/admin/users', authenticateToken, async (req, res) => {
  try {
    if (req.user.email !== 'admin@newspulse.com') {
      return res.status(403).json({ ok: false, error: 'Not authorized' });
    }

    const result = await db.query(
      `SELECT id, email, name, subscription_status, created_at 
       FROM users ORDER BY created_at DESC`
    );

    res.json({
      ok: true,
      users: result.rows.map(u => ({
        id: u.id,
        email: u.email,
        name: u.name,
        status: u.subscription_status || 'trial',
        created_at: u.created_at,
      })),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ===== PAYMENT ENDPOINTS =====

// POST /api/payment/subscribe
app.post('/api/payment/subscribe', authenticateToken, async (req, res) => {
  try {
    const { plan } = req.body;
    const user = req.user;

    const plans = {
      monthly: { price: 49000, duration: 30, name: 'Premium 1 Bulan' },
      yearly: { price: 399000, duration: 365, name: 'Premium 1 Tahun' },
    };

    if (!plans[plan]) {
      return res.status(400).json({ ok: false, error: 'Invalid plan' });
    }

    const planData = plans[plan];
    const orderId = `ORDER-${user.id}-${Date.now()}`;

    const transactionDetails = {
      transaction_details: {
        order_id: orderId,
        gross_amount: planData.price,
      },
      customer_details: {
        email: user.email,
        first_name: user.name || 'User',
        phone: '08123456789',
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

    const token = await snap.createTransaction(transactionDetails);

    await db.query(
      `INSERT INTO transactions (user_id, order_id, plan, amount, status, created_at)
       VALUES ($1, $2, $3, $4, 'pending', NOW())`,
      [user.id, orderId, plan, planData.price]
    );

    res.json({
      ok: true,
      snapToken: token.token,
      snapUrl: token.redirect_url,
      orderId,
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

    const signature = crypto
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

    let newStatus = 'pending';
    let subscriptionDays = 0;

    if (transactionStatus === 'capture' || transactionStatus === 'settlement') {
      newStatus = 'success';
      const txResult = await db.query(
        'SELECT plan FROM transactions WHERE order_id = $1',
        [orderId]
      );
      if (txResult.rows.length > 0) {
        subscriptionDays = txResult.rows[0].plan === 'yearly' ? 365 : 30;
      }
    } else if (transactionStatus === 'cancel' || transactionStatus === 'deny' || transactionStatus === 'expire') {
      newStatus = 'failed';
    }

    await db.query(
      `UPDATE transactions SET status = $1, updated_at = NOW()
       WHERE order_id = $2`,
      [newStatus, orderId]
    );

    if (newStatus === 'success' && subscriptionDays > 0) {
      const userResult = await db.query(
        `SELECT user_id FROM transactions WHERE order_id = $1`,
        [orderId]
      );

      if (userResult.rows.length > 0) {
        const userId = userResult.rows[0].user_id;
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + subscriptionDays);

        await db.query(
          `UPDATE users 
           SET subscription_status = 'active', subscription_expiry = $1
           WHERE id = $2`,
          [expiryDate, userId]
        );

        console.log(`✅ Payment success for user ${userId}, expires ${expiryDate}`);
      }
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

    res.json({ ok: true, transaction: result.rows[0] });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ===== HEALTH CHECK =====
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    status: 'Server running',
    news_cached: newsCache ? `${newsCache.length} items` : 'no',
    time: new Date().toLocaleString('id-ID'),
  });
});

// ===== START SERVER =====
const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    await db.query('SELECT NOW()');
    console.log('✅ Database connected');

    // Patch existing users: set subscription_status = 'trial' where NULL
    await db.query(
      `UPDATE users SET subscription_status = 'trial' 
       WHERE subscription_status IS NULL AND email != 'admin@newspulse.com'`
    );
    console.log('✅ Patched existing users subscription_status');

    app.listen(PORT, () => {
      console.log(`✅ NewsPulse backend running on port ${PORT}`);
      console.log(`📰 News sources: ${Object.keys(RSS_SOURCES).length} categories`);
      console.log(`💳 Payment: Midtrans ${process.env.MIDTRANS_SERVER_KEY ? 'enabled' : 'disabled'}`);
    });

    // Fetch news on startup
    fetchNews().catch(err => console.warn('Initial news fetch failed:', err.message));

  } catch (err) {
    console.error('❌ Failed to start:', err.message);
    process.exit(1);
  }
}

startServer();
