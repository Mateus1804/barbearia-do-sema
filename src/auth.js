'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { HttpError } = require('./http');

function createAdminAuth(db, config) {
  const { JWT_SECRET } = config;
  function requireAdmin(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    try {
      const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
      if (decoded.role !== 'admin') throw new Error('wrong role');
      req.admin = decoded;
      next();
    } catch { res.status(401).json({ error: 'Sessão expirada. Entre novamente.' }); }
  }

  function login(req, res) {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.senha || '');
    const admin = db.prepare('SELECT * FROM admin WHERE id=1').get();
    if (!admin || email !== admin.email || !bcrypt.compareSync(password, admin.senha_hash)) throw new HttpError(401, 'E-mail ou senha incorretos.');
    const token = jwt.sign({ role: 'admin', email: admin.email }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '8h' });
    res.json({ token, email: admin.email, expires_in: 28800 });
  }

  return { requireAdmin, login };
}

module.exports = { createAdminAuth };
