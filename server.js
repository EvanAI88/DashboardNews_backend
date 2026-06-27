bash

cat > /mnt/user-data/outputs/server.js << 'EOF'
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

// ===== CORS =====
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ===== DATABASE =====
const db = new Pool({ connectionString: process.env.DATABASE_URL });

// ===== MIDTRANS =====
const snap = new midtransClient.Snap({
  isProduction: false,
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY,
});

// ===== CONFIG =====
const JWT_SECRET = process.env.JWT_SECRET || 'newspulse-secret-2024';
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 jam
let newsCache = null;
let lastFetchTime = 0;

// ===== RSS SOURCES =====
const RSS_SOURCES = {
  finance: [
    'https://feeds.bloomberg.com/markets/news.rss',
    'https://www.marketwatch.com/rss/topstories',
    'https://finance.yahoo.com/news/rssindex',
  ],
  crypto: [
    'https://cryptoslate.com/feed/',
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
    'https://www.theverge.com/rss/index.xml',
    'https://www.wired.com/feed/rss',
    'https://techcrunch.com/feed/',
  ],
};

// ===== TRANSLATE via MyMemory API (FREE) =====
async function translateText(text, retries = 2) {
  if (!text || text.trim().length === 0) return text;

  // Bersihkan HTML tags dulu
  const cleanText = text.replace(/<[^>]*>/g, '').trim();
  // Batasi panjang teks (MyMemory max 500 char per request)
  const shortText = cleanText.substring(0, 450);

  for (let i = 0; i <= retries; i++) {
    try {
      const encoded = encodeURIComponent(shortText);
      const url = `https://api.mymemory.translated.net/get?q=${encoded}&langpair=en|id`;
      const res = await axios.get(url, { timeout: 8000 });

      if (
        res.data &&
        res.data.responseStatus === 200 &&
        res.data.responseData &&
        res.data.responseData.translatedText
      ) {
        const translated = res.data.responseData.translatedText;
        // Kalau hasil translate masih sama persis dengan input → kembalikan original
        if (translated.toLowerCase() === shortText.toLowerCase()) return cleanText;
        return translated;
      }
    } catch (err) {
      if (i < retries) {
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      }
    }
  }
  return cleanText; // fallback ke original kalau semua gagal
}

// Translate judul + deskripsi secara paralel (max 3 concurrent)
async function translateNewsItem(item) {
  try {
    const [titleID, descID] = await Promise.all([
      translateText(item.title),
      translateText(item.description ? item.description.substring(0, 400) : ''),
    ]);
    return {
      ...item,
      title_id: titleID,
      description_id: descID,
    };
  } catch {
    return { ...item, title_id: item.title, description_id: item.description };
  }
}

// Translate batch dengan concurrency limit
async function translateBatch(items, concurrency = 3) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const translated = await Promise.all(batch.map(translateNewsItem));
    results.push(...translated);
    // Jeda kecil antar batch agar tidak kena rate limit
    if (i + concurrency < items.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return results;
}

// ===== FETCH + TRANSLATE NEWS =====
async function fetchNews() {
  const now = Date.now();
  if (newsCache && now - lastFetchTime < CACHE_TTL) {
    console.log(`📦 Using cached news (${newsCache.length} items)`);
    return newsCache;
  }

  console.log('🔄 Fetching fresh news...');
  const parser = new Parser();
  let allNews = [];

  for (const [category, sources] of Object.entries(RSS_SOURCES)) {
    for (const source of sources) {
      try {
        const feed = await parser.parseURL(source);
        feed.items.slice(0, 4).forEach(item => {
          allNews.push({
            category,
            title: item.title || 'No title',
            description: (item.contentSnippet || item.summary || item.content || '').substring(0, 400),
            link: item.link || '#',
            source: feed.title || 'Unknown',
            pubDate: item.pubDate || new Date().toISOString(),
          });
        });
        console.log(`✅ ${category} - ${feed.title}: ${feed.items.length} items`);
      } catch (err) {
        console.warn(`⚠️  ${source} failed: ${err.message}`);
      }
    }
  }

  // Deduplicate
  const seen = new Set();
  allNews = allNews.filter(item => {
    const key = item.title.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort newest first
  allNews.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  console.log(`📊 Total: ${allNews.length} berita. Mulai translate...`);

  // Translate semua berita
  allNews = await translateBatch(allNews, 3);

  console.log(`✅ Translate selesai! ${allNews.length} berita siap.`);

  newsCache = allNews;
  lastFetchTime = now;
  return allNews;
}

// ===== AUTH MIDDLEWARE =====
function authenticateToken(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ ok: false, error: 'No token' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(401).json({ ok: false, error: 'Invalid token' });
    req.user = user;
    next();
  });
}

// ===== AUTH ENDPOINTS =====

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name)
      return res.status(400).json({ ok: false, error: 'Missing fields' });

    const exists = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rows.length > 0)
      return res.status(400).json({ ok: false, error: 'Email already exists' });

    const hashed = await bcrypt.hash(password, 10);
    const result = await db.query(
      `INSERT INTO users (email, password, name, subscription_status, created_at)
       VALUES ($1, $2, $3, 'trial', NOW()) RETURNING id, email, name`,
      [email, hashed, name]
    );
    const user = result.rows[0];
    const isAdmin = user.email === 'admin@newspulse.com';
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name, isAdmin }, JWT_SECRET, { expiresIn: '30d' });

    res.json({ ok: true, token, user: { ...user, isAdmin, trial_days_remaining: 5 } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ ok: false, error: 'Missing fields' });

    const result = await db.query('SELECT id, email, password, name FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0)
      return res.status(401).json({ ok: false, error: 'Invalid credentials' });

    const user = result.rows[0];
    if (!await bcrypt.compare(password, user.password))
      return res.status(401).json({ ok: false, error: 'Invalid credentials' });

    const isAdmin = user.email === 'admin@newspulse.com';
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name, isAdmin }, JWT_SECRET, { expiresIn: '30d' });

    res.json({ ok: true, token, user: { id: user.id, email: user.email, name: user.name, isAdmin } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, email, name, created_at, subscription_status, subscription_expiry FROM users WHERE id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ ok: false, error: 'User not found' });

    const user = result.rows[0];
    const isAdmin = user.email === 'admin@newspulse.com';

    // Auto-patch NULL subscription_status
    if (!isAdmin && !user.subscription_status) {
      await db.query("UPDATE users SET subscription_status = 'trial' WHERE id = $1", [user.id]);
      user.subscription_status = 'trial';
    }
    if (!user.created_at) {
      await db.query('UPDATE users SET created_at = NOW() WHERE id = $1', [user.id]);
      user.created_at = new Date();
    }

    let trialDaysRemaining = 0;
    let subscriptionStatus = user.subscription_status;

    if (isAdmin) {
      subscriptionStatus = 'admin';
    } else if (user.subscription_status === 'active' && user.subscription_expiry) {
      subscriptionStatus = new Date(user.subscription_expiry) > new Date() ? 'active' : 'expired';
    } else if (user.subscription_status === 'trial') {
      const days = Math.floor((new Date() - new Date(user.created_at)) / (1000 * 60 * 60 * 24));
      trialDaysRemaining = Math.max(0, 5 - days);
      subscriptionStatus = trialDaysRemaining > 0 ? 'trial' : 'expired';
    }

    res.json({
      ok: true,
      user: {
        id: user.id, email: user.email, name: user.name,
        isAdmin, trial_days_remaining: trialDaysRemaining,
        subscription_status: subscriptionStatus,
        subscription_expiry: user.subscription_expiry,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== NEWS =====
app.get('/api/news', authenticateToken, async (req, res) => {
  try {
    const news = await fetchNews();
    res.json({ ok: true, news });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== ADMIN =====
app.get('/api/admin/stats', authenticateToken, async (req, res) => {
  try {
    if (req.user.email !== 'admin@newspulse.com')
      return res.status(403).json({ ok: false, error: 'Not authorized' });

    const [total, premium, trial, revenue] = await Promise.all([
      db.query('SELECT COUNT(*) as count FROM users'),
      db.query("SELECT COUNT(*) as count FROM users WHERE subscription_status = 'active'"),
      db.query("SELECT COUNT(*) as count FROM users WHERE subscription_status = 'trial'"),
      db.query("SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE status = 'success'"),
    ]);

    res.json({
      ok: true,
      stats: {
        totalUsers: parseInt(total.rows[0].count),
        premiumUsers: parseInt(premium.rows[0].count),
        trialUsers: parseInt(trial.rows[0].count),
        revenue: parseFloat(revenue.rows[0].total) / 100 || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/admin/users', authenticateToken, async (req, res) => {
  try {
    if (req.user.email !== 'admin@newspulse.com')
      return res.status(403).json({ ok: false, error: 'Not authorized' });

    const result = await db.query(
      'SELECT id, email, name, subscription_status, subscription_expiry, created_at FROM users ORDER BY created_at DESC'
    );
    res.json({ ok: true, users: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== PAYMENT =====
app.post('/api/payment/subscribe', authenticateToken, async (req, res) => {
  try {
    const { plan } = req.body;
    const plans = {
      monthly: { price: 49000, duration: 30, name: 'Premium 1 Bulan' },
      yearly: { price: 399000, duration: 365, name: 'Premium 1 Tahun' },
    };
    if (!plans[plan]) return res.status(400).json({ ok: false, error: 'Invalid plan' });

    const planData = plans[plan];
    const orderId = `ORDER-${req.user.id}-${Date.now()}`;

    const token = await snap.createTransaction({
      transaction_details: { order_id: orderId, gross_amount: planData.price },
      customer_details: { email: req.user.email, first_name: req.user.name || 'User' },
      item_details: [{ id: plan, price: planData.price, quantity: 1, name: planData.name }],
    });

    await db.query(
      "INSERT INTO transactions (user_id, order_id, plan, amount, status, created_at) VALUES ($1, $2, $3, $4, 'pending', NOW())",
      [req.user.id, orderId, plan, planData.price]
    );

    res.json({ ok: true, snapToken: token.token, snapUrl: token.redirect_url, orderId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/payment/callback', async (req, res) => {
  try {
    const n = req.body;
    const sig = crypto.createHash('sha512')
      .update(n.order_id + n.status_code + n.gross_amount + process.env.MIDTRANS_SERVER_KEY)
      .digest('hex');

    if (sig !== n.signature_key)
      return res.status(401).json({ ok: false, error: 'Invalid signature' });

    let newStatus = 'pending';
    let days = 0;

    if (n.transaction_status === 'capture' || n.transaction_status === 'settlement') {
      newStatus = 'success';
      const tx = await db.query('SELECT plan FROM transactions WHERE order_id = $1', [n.order_id]);
      days = tx.rows[0]?.plan === 'yearly' ? 365 : 30;
    } else if (['cancel', 'deny', 'expire'].includes(n.transaction_status)) {
      newStatus = 'failed';
    }

    await db.query("UPDATE transactions SET status = $1, updated_at = NOW() WHERE order_id = $2", [newStatus, n.order_id]);

    if (newStatus === 'success' && days > 0) {
      const tx = await db.query('SELECT user_id FROM transactions WHERE order_id = $1', [n.order_id]);
      if (tx.rows.length > 0) {
        const expiry = new Date();
        expiry.setDate(expiry.getDate() + days);
        await db.query(
          "UPDATE users SET subscription_status = 'active', subscription_expiry = $1 WHERE id = $2",
          [expiry, tx.rows[0].user_id]
        );
        console.log(`✅ Payment success user ${tx.rows[0].user_id}, expires ${expiry}`);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== HEALTH =====
app.get('/api/health', (req, res) => {
  res.json({
    ok: true, status: 'Server running',
    news_cached: newsCache ? `${newsCache.length} items` : 'no',
    time: new Date().toLocaleString('id-ID'),
  });
});

// ===== START =====
const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    await db.query('SELECT NOW()');
    console.log('✅ Database connected');

    await db.query(
      "UPDATE users SET subscription_status = 'trial' WHERE subscription_status IS NULL AND email != 'admin@newspulse.com'"
    );

    app.listen(PORT, () => {
      console.log(`✅ NewsPulse backend running on port ${PORT}`);
      console.log(`📰 News: ${Object.keys(RSS_SOURCES).length} categories`);
      console.log(`💳 Midtrans: ${process.env.MIDTRANS_SERVER_KEY ? 'enabled' : 'disabled'}`);
      console.log(`🌐 Translate: MyMemory API (free)`);
    });

    // Fetch + translate news di background saat startup
    fetchNews().catch(err => console.warn('Initial fetch failed:', err.message));

  } catch (err) {
    console.error('❌ Startup error:', err.message);
    process.exit(1);
  }
}

startServer();
EOF
echo "server.js done"
