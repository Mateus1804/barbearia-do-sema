'use strict';

const path = require('node:path');

function readConfig(env = process.env) {
  const PORT = Number(env.PORT || 3000);
  const ADMIN_EMAIL = String(env.ADMIN_EMAIL || 'sema@barbeariadosema.com.br')
    .trim()
    .toLowerCase();
  const ADMIN_PASSWORD = String(env.ADMIN_PASSWORD || 'Sema@2026!');
  const JWT_SECRET = env.JWT_SECRET || 'development-only-change-me-before-deploying-2026';
  const DB_PATH = env.DB_PATH || path.join(__dirname, '..', 'data', 'barbearia.db');
  const SMTP_HOST = String(env.SMTP_HOST || '').trim();
  const SMTP_PORT = Number(env.SMTP_PORT || 587);
  const SMTP_SECURE = String(env.SMTP_SECURE || 'false').toLowerCase() === 'true';
  const SMTP_USER = String(env.SMTP_USER || '').trim();
  const SMTP_PASS = String(env.SMTP_PASS || '');
  const EMAIL_FROM = String(env.EMAIL_FROM || SMTP_USER).trim();
  const PUBLIC_URL = String(env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
  const SMTP_CONFIGURED = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS && EMAIL_FROM);
  if (
    env.NODE_ENV === 'production' &&
    (!env.ADMIN_PASSWORD ||
      ADMIN_PASSWORD.length < 12 ||
      /troque|sema@2026|change-me|password/i.test(ADMIN_PASSWORD) ||
      !env.JWT_SECRET ||
      env.JWT_SECRET.length < 32 ||
      /troque|gere-uma-chave|change-me|development-only/i.test(JWT_SECRET))
  ) {
    throw new Error('Em produção, defina ADMIN_PASSWORD e um JWT_SECRET único antes de iniciar.');
  }

  const BACKUP_ENABLED = String(env.BACKUP_ENABLED || 'true').toLowerCase() !== 'false';
  const BACKUP_DIR = env.BACKUP_DIR || path.join(path.dirname(path.resolve(DB_PATH)), 'backups');
  const BACKUP_KEEP = Number(env.BACKUP_KEEP || 7);
  const BACKUP_INTERVAL_HOURS = Number(env.BACKUP_INTERVAL_HOURS || 24);
  const REMINDERS_ENABLED = String(env.REMINDERS_ENABLED || 'true').toLowerCase() !== 'false';
  if (!Number.isInteger(BACKUP_KEEP) || BACKUP_KEEP < 2 || BACKUP_KEEP > 1000 ||
      !Number.isFinite(BACKUP_INTERVAL_HOURS) || BACKUP_INTERVAL_HOURS < 1 || BACKUP_INTERVAL_HOURS > 168)
    throw new Error('Confira BACKUP_KEEP (2 a 1000) e BACKUP_INTERVAL_HOURS (1 a 168).');

  return {
    BACKUP_ENABLED, BACKUP_DIR, BACKUP_KEEP, BACKUP_INTERVAL_HOURS, REMINDERS_ENABLED,
    PORT,
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    JWT_SECRET,
    DB_PATH,
    SMTP_HOST,
    SMTP_PORT,
    SMTP_SECURE,
    SMTP_USER,
    SMTP_PASS,
    EMAIL_FROM,
    PUBLIC_URL,
    SMTP_CONFIGURED
  };
}

module.exports = { readConfig };
