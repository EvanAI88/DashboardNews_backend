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
    { name: 'FinancialJuice', url: 'https://www.financialjuice.com/feed.ashx?action=r&format=rss&products=1' },
    { name: 'Reuters Business', url: 'https://feeds.reuters.com/reuters/businessNews' },
  ],
  crypto: [
    { name: 'CoinDesk', url: 'https://www.coindesk.com/feed' },
    { name: 'Cointelegraph', url: 'https://cointelegraph.com/feed' },
  ],
  ai: [
    { name: 'OpenAI Blog', url: 'https://openai.com/feed.xml' },
  ],
  tech: [
    { name: 'TechCrunch', url: 'https://feeds.techcrunch.com/TechCrunch/' },
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
      } catch (error) {
        console.warn(`⚠️ ${source.name} failed`);
      }
    }
  }
  
  allNews.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  return allNews;
}

// AUTH ENDPOINTS
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ ok: false, error: 'Email, password, and name required' });
    }

    const existingUser = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ ok: false, error: 'Email already registered' });
    }

    const hashedPassword = await hashPassword(password);
    
    // CHECK IF ADMIN EMAIL
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
    
    let trialDaysRemaining = isAdmin ? 999 : 5;
    let subscriptionStatus = isAdmin ? 'admin' : 'free_trial';

    res.status(201).json({
      ok: true,
      message: 'User registered successfully',
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
    console.error('Register error:', error);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'Email and password required' });
    }

    const result = await query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ ok: false, error: 'Invalid email or password' });
    }

    const user = result.rows[0];

    const passwordMatch = await comparePassword(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ ok: false, error: 'Invalid email or password' });
    }

    const token = generateToken(user.id, user.email);
    
    // CHECK ADMIN
    let subscriptionStatus = user.subscription_status;
    let trialDaysRemaining = 0;
    let isAdmin = user.role === 'admin' || email === 'admin@newspulse.com';

    if (isAdmin) {
      subscriptionStatus = 'admin';
      trialDaysRemaining = 999; // Unlimited
    } else {
      const isExpired = isTrialExpired(user.trial_start_date);
      if (isExpired && subscriptionStatus === 'free_trial') {
        subscriptionStatus = 'expired';
      }
      trialDaysRemaining = getTrialDaysRemaining(user.trial_start_date);
    }

    res.json({
      ok: true,
      message: 'Login successful',
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
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const result = await query('SELECT id, email, name, subscription_status, trial_start_date, role FROM users WHERE id = $1', [req.user.id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    const user = result.rows[0];
    
    // CHECK ADMIN
    let subscriptionStatus = user.subscription_status;
    let trialDaysRemaining = 0;
    let isAdmin = user.role === 'admin' || user.email === 'admin@newspulse.com';

    if (isAdmin) {
      subscriptionStatus = 'admin';
      trialDaysRemaining = 999; // Unlimited
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
        trial_expired: false,
        is_admin: isAdmin,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/news', authMiddleware, async (req, res) => {
  try {
    const now = Date.now();
    
    if (cache.news.length > 0 && now - cache.lastUpdate < cache.CACHE_TTL) {
      return res.json({
        ok: true,
        cached: true,
        count: cache.news.length,
        news: cache.news,
      });
    }

    const news = await fetchAllNews();
    cache.news = news;
    cache.lastUpdate = now;

    res.json({
      ok: true,
      cached: false,
      count: news.length,
      news: news,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    status: 'Server running',
    version: '2.0.0',
    features: ['auth', 'database', 'subscription'],
  });
});

async function startServer() {
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Database connected');

    await initializeDatabase();

    app.listen(PORT, async () => {
      console.log('\n');
      console.log('╔════════════════════════════════════════════════════════╗');
      console.log('║      🚀 NEWSPULSE PHASE 2 SERVER STARTED              ║');
      console.log('╚════════════════════════════════════════════════════════╝');
      console.log('');
      console.log(`📍 Server URL: http://localhost:${PORT}`);
      console.log('');
      console.log('📌 Auth Endpoints:');
      console.log('   POST   /api/auth/register');
      console.log('   POST   /api/auth/login');
      console.log('   GET    /api/auth/me (Protected)');
      console.log('');
      console.log('📌 News Endpoints:');
      console.log('   GET    /api/news (Protected)');
      console.log('');
      console.log('Tekan Ctrl+C untuk stop server');
      console.log('');

      await fetchAllNews();
    });
  } catch (error) {
    console.error('❌ Startup error:', error);
    process.exit(1);
  }
}

startServer();
