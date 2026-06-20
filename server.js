const express = require('express');
const cors = require('cors');
const axios = require('axios');
const xml2js = require('xml2js');
const nodemailer = require('nodemailer');
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

// ── EMAIL CONFIG ────────────────────────────────────────────────────────
const emailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || 'your-email@gmail.com',
    pass: process.env.EMAIL_PASSWORD || 'your-app-password',
  },
});

// ── RSS SOURCES (Updated & More Reliable) ────────────────────────────────
const NEWS_SOURCES = {
  finance: [
    { name: 'Reuters Finance', url: 'https://feeds.reuters.com/reuters/businessNews' },
    { name: 'CNBC', url: 'https://feeds.cnbc.com/cnbc/latest/' },
  ],
  crypto: [
    { name: 'CoinDesk', url: 'https://www.coindesk.com/feed/' },
    { name: 'Cointelegraph', url: 'https://cointelegraph.com/feed' },
  ],
  ai: [
    { name: 'AI News', url: 'https://feeds.bloomberg.com/markets/news.rss' },
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

// OTP Store (in-memory, use Redis in production)
const otpStore = new Map();

// ── PARSE RSS FEED ──────────────────────────────────────────────────────
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

// ── FETCH ALL NEWS ──────────────────────────────────────────────────────
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
        console.warn(`⚠️  ${source.name} failed: ${error.message}`);
      }
    }
  }
  
  allNews.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  console.log(`📊 Total news fetched: ${allNews.length}`);
  return allNews;
}

// ── TRANSLATE TEXT (LibreTranslate - FREE) ──────────────────────────────
async function translateText(text, targetLang = 'id') {
  try {
    const res = await axios.post('https://libretranslate.de/translate', {
      q: text,
      source: 'en',
      target: targetLang,
    }, {
      timeout: 5000,
    });
    return res.data.translatedText || text;
  } catch (error) {
    console.warn('Translation failed:', error.message);
    return text; // Fallback ke bahasa asli
  }
}

// ── GENERATE OTP ────────────────────────────────────────────────────────
function generateOTP(email) {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore.set(email, {
    otp,
    createdAt: Date.now(),
    attempts: 0,
  });
  
  // Auto-expire OTP after 10 minutes
  setTimeout(() => otpStore.delete(email), 10 * 60 * 1000);
  
  return otp;
}

// ── SEND OTP EMAIL ──────────────────────────────────────────────────────
async function sendOTPEmail(email, otp) {
  try {
    await emailTransporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: '🔐 NewsPulse OTP Verification',
      html: `
        <h2>Welcome to NewsPulse!</h2>
        <p>Your OTP verification code is:</p>
        <h1 style="color: #3b82f6; font-size: 36px; letter-spacing: 4px;">${otp}</h1>
        <p>This code expires in 10 minutes.</p>
        <p>If you didn't request this, please ignore this email.</p>
      `,
    });
    console.log(`✅ OTP sent to ${email}`);
    return true;
  } catch (error) {
    console.error('Error sending OTP:', error);
    return false;
  }
}

// ── VERIFY OTP ──────────────────────────────────────────────────────────
function verifyOTP(email, inputOTP) {
  const storedData = otpStore.get(email);
  
  if (!storedData) {
    return { ok: false, error: 'OTP expired or not found' };
  }
  
  if (storedData.attempts >= 3) {
    otpStore.delete(email);
    return { ok: false, error: 'Too many attempts. Request new OTP.' };
  }
  
  if (storedData.otp !== inputOTP) {
    storedData.attempts += 1;
    return { ok: false, error: 'Invalid OTP' };
  }
  
  otpStore.delete(email);
  return { ok: true };
}

// ── API ENDPOINTS ────────────────────────────────────────────────────────

// Register (Generate OTP)
app.post('/api/auth/register-request', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ ok: false, error: 'Email, password, and name required' });
    }

    const existingUser = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ ok: false, error: 'Email already registered' });
    }

    // Generate & Send OTP
    const otp = generateOTP(email);
    const sent = await sendOTPEmail(email, otp);

    if (!sent) {
      return res.status(500).json({ ok: false, error: 'Failed to send OTP' });
    }

    // Store pending registration data (in memory, use Redis in production)
    app.locals.pendingReg = app.locals.pendingReg || {};
    app.locals.pendingReg[email] = { password, name };

    res.json({
      ok: true,
      message: 'OTP sent to email. Check your inbox.',
      email: email,
    });
  } catch (error) {
    console.error('Register request error:', error);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// Register (Verify OTP & Create Account)
app.post('/api/auth/register-verify', async (req, res) => {
  try {
    const { email, otp } = req.body;

    const otpResult = verifyOTP(email, otp);
    if (!otpResult.ok) {
      return res.status(400).json({ ok: false, error: otpResult.error });
    }

    const pending = (app.locals.pendingReg || {})[email];
    if (!pending) {
      return res.status(400).json({ ok: false, error: 'Registration session expired' });
    }

    const hashedPassword = await hashPassword(pending.password);
    const isAdmin = email === 'admin@newspulse.com';
    const adminRole = isAdmin ? 'admin' : 'user';
    const adminStatus = isAdmin ? 'admin' : 'free_trial';

    const result = await query(
      `INSERT INTO users (email, password, name, subscription_status, trial_start_date, role)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5)
       RETURNING id, email, name, subscription_status, trial_start_date, role`,
      [email, hashedPassword, pending.name, adminStatus, adminRole]
    );

    delete app.locals.pendingReg[email];

    const user = result.rows[0];
    const token = generateToken(user.id, user.email);

    res.status(201).json({
      ok: true,
      message: 'Registration successful!',
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
    console.error('Register verify error:', error);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// Login (Generate OTP)
app.post('/api/auth/login-request', async (req, res) => {
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

    // Generate & Send OTP (skip for admin)
    if (user.role === 'admin' || email === 'admin@newspulse.com') {
      // Admin: direct login
      const token = generateToken(user.id, user.email);
      return res.json({
        ok: true,
        message: 'Admin login successful',
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          subscription_status: 'admin',
          trial_days_remaining: 999,
          is_admin: true,
        },
        token: token,
      });
    }

    // Non-admin: send OTP
    const otp = generateOTP(email);
    const sent = await sendOTPEmail(email, otp);

    if (!sent) {
      return res.status(500).json({ ok: false, error: 'Failed to send OTP' });
    }

    // Store user data for OTP verification
    app.locals.pendingLogin = app.locals.pendingLogin || {};
    app.locals.pendingLogin[email] = user;

    res.json({
      ok: true,
      message: 'OTP sent to email. Check your inbox.',
      email: email,
    });
  } catch (error) {
    console.error('Login request error:', error);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// Login (Verify OTP)
app.post('/api/auth/login-verify', async (req, res) => {
  try {
    const { email, otp } = req.body;

    const otpResult = verifyOTP(email, otp);
    if (!otpResult.ok) {
      return res.status(400).json({ ok: false, error: otpResult.error });
    }

    const user = (app.locals.pendingLogin || {})[email];
    if (!user) {
      return res.status(400).json({ ok: false, error: 'Login session expired' });
    }

    delete app.locals.pendingLogin[email];

    const token = generateToken(user.id, user.email);
    const isExpired = isTrialExpired(user.trial_start_date);
    const trialDaysRemaining = getTrialDaysRemaining(user.trial_start_date);

    res.json({
      ok: true,
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        subscription_status: isExpired ? 'expired' : user.subscription_status,
        trial_days_remaining: trialDaysRemaining,
        is_admin: false,
      },
      token: token,
    });
  } catch (error) {
    console.error('Login verify error:', error);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// Get Current User
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const result = await query('SELECT id, email, name, subscription_status, trial_start_date, role FROM users WHERE id = $1', [req.user.id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'User not found' });
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

// Get News (with Translation)
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
    
    // Translate to Indonesian if user requested (query param: translate=id)
    const shouldTranslate = req.query.translate === 'id';
    if (shouldTranslate && news.length > 0) {
      console.log('🌐 Translating news to Indonesian...');
      for (let i = 0; i < news.length; i++) {
        news[i].title_id = await translateText(news[i].title, 'id');
        news[i].description_id = await translateText(news[i].description, 'id');
      }
    }

    cache.news = news;
    cache.lastUpdate = now;

    res.json({
      ok: true,
      cached: false,
      count: news.length,
      news: news,
    });
  } catch (error) {
    console.error('News fetch error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    status: 'Server running',
    version: '3.0.0',
    features: ['auth', 'database', 'subscription', 'otp', 'translation'],
  });
});

// Admin Stats (Protected)
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

// Admin Users List (Protected)
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

// ── START SERVER ────────────────────────────────────────────────────────
async function startServer() {
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Connected to PostgreSQL');

    await initializeDatabase();

    app.listen(PORT, async () => {
      console.log('\n');
      console.log('╔════════════════════════════════════════════════════════╗');
      console.log('║      🚀 NEWSPULSE PHASE 3 SERVER STARTED              ║');
      console.log('╚════════════════════════════════════════════════════════╝');
      console.log('');
      console.log(`📍 Server URL: http://localhost:${PORT}`);
      console.log('');
      console.log('📌 Auth Endpoints:');
      console.log('   POST   /api/auth/register-request (Generate OTP)');
      console.log('   POST   /api/auth/register-verify (Verify OTP & Create)');
      console.log('   POST   /api/auth/login-request (Generate OTP)');
      console.log('   POST   /api/auth/login-verify (Verify OTP & Login)');
      console.log('   GET    /api/auth/me (Protected)');
      console.log('');
      console.log('📌 News Endpoints:');
      console.log('   GET    /api/news (Protected, add ?translate=id for Indonesian)');
      console.log('');
      console.log('📌 Admin Endpoints:');
      console.log('   GET    /api/admin/stats (Protected, admin only)');
      console.log('   GET    /api/admin/users (Protected, admin only)');
      console.log('');
      console.log('Tekan Ctrl+C untuk stop server');
      console.log('');

      // Fetch news on startup
      await fetchAllNews();
      
      // Auto-refresh news every 10 minutes
      setInterval(fetchAllNews, 10 * 60 * 1000);
    });
  } catch (error) {
    console.error('❌ Startup error:', error);
    process.exit(1);
  }
}

startServer();
