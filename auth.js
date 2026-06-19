const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRY = '7d';

async function hashPassword(password) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

async function comparePassword(inputPassword, hashedPassword) {
  return bcrypt.compare(inputPassword, hashedPassword);
}

function generateToken(userId, email) {
  return jwt.sign(
    { id: userId, email: email },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: 'No token provided' });
  }
  
  const token = authHeader.substring(7);
  const decoded = verifyToken(token);
  
  if (!decoded) {
    return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
  }
  
  req.user = decoded;
  next();
}

function isTrialExpired(trialStartDate) {
  const now = new Date();
  const start = new Date(trialStartDate);
  const diffDays = Math.floor((now - start) / (1000 * 60 * 60 * 24));
  return diffDays > 5;
}

function getTrialDaysRemaining(trialStartDate) {
  const now = new Date();
  const start = new Date(trialStartDate);
  const diffDays = Math.floor((now - start) / (1000 * 60 * 60 * 24));
  const remaining = Math.max(0, 5 - diffDays);
  return remaining;
}

module.exports = {
  hashPassword,
  comparePassword,
  generateToken,
  verifyToken,
  authMiddleware,
  isTrialExpired,
  getTrialDaysRemaining,
};
