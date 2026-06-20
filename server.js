const express = require('express');
const cors = require('cors');
const axios = require('axios');
const xml2js = require('xml2js');
require('dotenv').config();

const { query, pool, initializeDatabase } = require('./database');
const {
  hashPassword,
  comparePassword,
  generateToken,
  verifyToken,
  authMiddleware,
  isTrialExpired,
  getTrialDaysRemaining,
} = require('./auth');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const NEWS_SOURCES = {
  finance: [
    { name: 'MarketWatch', url: 'https://feeds.bloomberg.com/markets/news.rss' },
    { name: 'CNBC', url: 'https://feeds.cnbc.com/cnbc/latest/' },
    { name: 'Yahoo Finance', url: 'https://feeds.finance.yahoo.com/rss/2.0/headline' },
    { name: 'BusinessInsider', url: 'https://feeds.bloomberg.com/markets/news.rss' },
  ],
  crypto: [
    { name: 'CoinDesk', url: 'https://www.coindesk.com/feed/' },
    { name: 'Cointelegraph', url: 'https://cointelegraph.com/feed' },
  ],
  ai: [
    { name: 'AI News', url: 'https://feeds.bloomberg.com/markets/news.rss' },
    { name: 'MIT Tech Review', url: 'https://www.technologyreview.com/feed.rss' },
  ],
  tech: [
    { name: 'TechCrunch', url: 'https://techcrunch.com/feed/' },
    { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
  ],
};

const cache = {
  news: [],
  lastUpdate: 0,
  CACHE_TTL: 5 * 60 * 1000,
};

async function parseRSSFeed(xmlString, source, category) {
  try {
    const parser = new xml2js.Parser({ explicitArray: false });
    const result = await parser.parseStringPromise(xmlString);
    let items = result?.rss?.channel?.item || [];
    if (!Array.isArray(items)) items = [items];
    
    return items
      .filter(item => item.title && item.title.trim())
      .slice(0, 5)
      .map(item => ({
        source: source.name,
        category: category,
        title: item.title?.trim() || 'No title',
        description: (item.description || '')
          .replace(/<[^>]*>/g, '')
          .substring(0, 300),
        link: item.link?.trim() || '#',
        pubDate: item.pubDate || new Date().toISOString(),
      }));
  } catch (error) {
    console.error(`Error parsing ${source.name}:`, error.message);
    return [];
  }
}

async function fetchAllNews() {
  console.log('📰 Fetching news...');
  let allNews = [];
  
  for (const [category, sources] of Object.entries(NEWS_SOURCES)) {
    for (const source of sources) {
      try {
        const response = await axios.get(source.url, {
          timeout: 8000,
          headers: { 'User-Agent': 'Mozilla/5.0 NewsPulseBot/1.0' }
        });
        const news = await parseRSSFeed(response.data, source, category);
        allNews = allNews.concat(news);
        console.log(`✅ ${source.name} fetched (${news.length} items)`);
      } catch (error) {
        console.warn(`⚠️  ${source.name} failed`);
      }
    }
  }
  
  allNews.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  console.log(`📊 Total news fetched: ${allNews.length}`);
  return allNews;
}

async function translateText(text, targetLang = 'id') {
  try {
    const systemPrompt = targetLang === 'id' 
      ? `Terjemahkan teks berikut ke dalam Bahasa Indonesia dengan gaya jurnalis profesional. Gunakan struktur bahasa yang rapi, detail, dan mudah dipahami. Pertahankan konteks dan makna asli. Hindari terjemahan literal. Gunakan terminologi bisnis/ekonomi Indonesia yang tepat. Output hanya terjemahan, tanpa penjelasan tambahan.`
      : text;
    
    const res = await axios.post('https://libretranslate.de/translate', {
      q: text,
      source: 'en',
      target: targetLang,
    }, {
      timeout: 5000,
    });
    
    let translatedText = res.data.translatedText || text;
    
    // Clean up translation
    translatedText = translatedText
      .replace(/\s+/g, ' ')
      .trim();
    
    return translatedText || text;
  } catch (error) {
    console.warn('Translation error:', error.message);
    return text;
  }
}

// REGISTER (DIRECT)
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ ok: false, error: 'Semua field harus diisi' });
    }

    const existingUser = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ ok: false, error: 'Email sudah terdaftar' });
    }

    const hashedPassword = await hashPassword(password);
    const isAdmin = email === 'admin@newspulse.com';
    const adminRole = isAdmin ? 'admin' : 'user';
    const adminStatus = isAdmin ? 'admin' : 'free_trial';

    const result = await query(
      `INSERT INTO users (email, password, name, subscription_status, trial_start_date, role)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5)
       RETURNING id, email, name, subscription_status, trial_start_date, role`,
      [email, hashedPassword, name, adminStatus, adminRole]
    );

    const user = result.rows[0];
    const token = generateToken(user.id, user.email);

    res.status(201).json({
      ok: true,
      message: 'Registrasi berhasil!',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        subscription_status: adminStatus,
        trial_days_remaining: isAdmin ? 999 : 5,
        is_admin: isAdmin,
      },
      token: token,
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// LOGIN (DIRECT)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'Email dan password harus diisi' });
    }

    const result = await query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ ok: false, error: 'Email atau password salah' });
    }

    const user = result.rows[0];
    const passwordMatch = await comparePassword(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ ok: false, error: 'Email atau password salah' });
    }

    const token = generateToken(user.id, user.email);
    const isAdmin = user.role === 'admin' || email === 'admin@newspulse.com';
    let subscriptionStatus = user.subscription_status;
    let trialDaysRemaining = 0;

    if (isAdmin) {
      subscriptionStatus = 'admin';
      trialDaysRemaining = 999;
    } else {
      const isExpired = isTrialExpired(user.trial_start_date);
      if (isExpired && subscriptionStatus === 'free_trial') {
        subscriptionStatus = 'expired';
      }
      trialDaysRemaining = getTrialDaysRemaining(user.trial_start_date);
    }

    res.json({
      ok: true,
      message: 'Login berhasil!',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        subscription_status: subscriptionStatus,
        trial_days_remaining: trialDaysRemaining,
        is_admin: isAdmin,
      },
      token: token,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET CURRENT USER
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const result = await query('SELECT id, email, name, subscription_status, trial_start_date, role FROM users WHERE id = $1', [req.user.id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'User tidak ditemukan' });
    }

    const user = result.rows[0];
    const isAdmin = user.role === 'admin' || user.email === 'admin@newspulse.com';
    let subscriptionStatus = user.subscription_status;
    let trialDaysRemaining = 0;

    if (isAdmin) {
      subscriptionStatus = 'admin';
      trialDaysRemaining = 999;
    } else {
      const isExpired = isTrialExpired(user.trial_start_date);
      trialDaysRemaining = getTrialDaysRemaining(user.trial_start_date);
    }

    res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        subscription_status: subscriptionStatus,
        trial_days_remaining: trialDaysRemaining,
        is_admin: isAdmin,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// GET NEWS (WITH TRANSLATION)
app.get('/api/news', authMiddleware, async (req, res) => {
  try {
    const now = Date.now();
    let news = [];
    
    if (cache.news.length > 0 && now - cache.lastUpdate < cache.CACHE_TTL) {
      news = cache.news;
    } else {
      news = await fetchAllNews();
      cache.news = news;
      cache.lastUpdate = now;
    }

    // TRANSLATE JIKA DIMINTA
    const shouldTranslate = req.query.translate === 'id';
    if (shouldTranslate && news.length > 0) {
      console.log('🌐 Translating to Indonesian...');
      for (let i = 0; i < news.length; i++) {
        news[i].title_id = await translateText(news[i].title, 'id');
        news[i].description_id = await translateText(news[i].description, 'id');
      }
    }

    res.json({
      ok: true,
      count: news.length,
      news: news,
    });
  } catch (error) {
    console.error('News error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ADMIN STATS
app.get('/api/admin/stats', authMiddleware, async (req, res) => {
  try {
    const user = await query('SELECT role FROM users WHERE id = $1', [req.user.id]);
    if (!user.rows.length || user.rows[0].role !== 'admin') {
      return res.status(403).json({ ok: false, error: 'Admin only' });
    }

    const totalUsers = await query('SELECT COUNT(*) FROM users');
    const premiumUsers = await query('SELECT COUNT(*) FROM users WHERE subscription_status = $1', ['premium']);
    const trialUsers = await query('SELECT COUNT(*) FROM users WHERE subscription_status = $1', ['free_trial']);
    const revenue = await query('SELECT SUM(CAST(price AS NUMERIC)) as total FROM subscriptions WHERE payment_status = $1', ['completed']);

    res.json({
      ok: true,
      stats: {
        totalUsers: parseInt(totalUsers.rows[0].count),
        premiumUsers: parseInt(premiumUsers.rows[0].count),
        trialUsers: parseInt(trialUsers.rows[0].count),
        revenue: parseFloat(revenue.rows[0].total) || 0,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ADMIN USERS
app.get('/api/admin/users', authMiddleware, async (req, res) => {
  try {
    const user = await query('SELECT role FROM users WHERE id = $1', [req.user.id]);
    if (!user.rows.length || user.rows[0].role !== 'admin') {
      return res.status(403).json({ ok: false, error: 'Admin only' });
    }

    const users = await query('SELECT id, email, name, subscription_status, created_at FROM users ORDER BY created_at DESC LIMIT 50');
    res.json({
      ok: true,
      users: users.rows,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// HEALTH
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    status: 'Server running',
    version: '3.0.0 (Simplified)',
  });
});

async function startServer() {
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Connected to PostgreSQL');

    await initializeDatabase();

    app.listen(PORT, async () => {
      console.log('\n');
      console.log('╔════════════════════════════════════════════════════════╗');
      console.log('║    🚀 NEWSPULSE PHASE 3 FINAL SERVER STARTED          ║');
      console.log('║       (Simplified - No OTP, Focus on News & Translate  ║');
      console.log('╚════════════════════════════════════════════════════════╝');
      console.log('');
      console.log(`📍 Server: https://dashboardnews-backend.onrender.com`);
      console.log('');
      console.log('📌 Auth: POST /api/auth/register, POST /api/auth/login');
      console.log('📌 News: GET /api/news (?translate=id for Indonesian)');
      console.log('📌 Admin: GET /api/admin/stats, GET /api/admin/users');
      console.log('');

      await fetchAllNews();
      
      setInterval(fetchAllNews, 10 * 60 * 1000);
    });
  } catch (error) {
    console.error('❌ Startup error:', error);
    process.exit(1);
  }
}

startServer();
