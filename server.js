'use strict';

require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const TIME_ZONE = 'America/Sao_Paulo';
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'sema@barbeariadosema.com.br').trim().toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || 'Sema@2026!');
const JWT_SECRET = process.env.JWT_SECRET || 'development-only-change-me-before-deploying-2026';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'barbearia.db');
const SMTP_HOST = String(process.env.SMTP_HOST || '').trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const SMTP_USER = String(process.env.SMTP_USER || '').trim();
const SMTP_PASS = String(process.env.SMTP_PASS || '');
const EMAIL_FROM = String(process.env.EMAIL_FROM || SMTP_USER).trim();
const PUBLIC_URL = String(process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const SMTP_CONFIGURED = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS && EMAIL_FROM);
const mailer = SMTP_CONFIGURED ? nodemailer.createTransport({
  host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
  connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000
}) : null;
if (process.env.NODE_ENV === 'production' && (!process.env.ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12 || /troque|sema@2026|change-me|password/i.test(ADMIN_PASSWORD) || !process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 || /troque|gere-uma-chave|change-me|development-only/i.test(JWT_SECRET))) {
  throw new Error('Em produção, defina ADMIN_PASSWORD e um JWT_SECRET único antes de iniciar.');
}

if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Horários e durações reais vêm do banco. Durações quebradas são arredondadas para slots de 30 minutos.
db.exec(`
CREATE TABLE IF NOT EXISTS servicos (
  id INTEGER PRIMARY KEY,
  nome TEXT NOT NULL UNIQUE,
  preco_cents INTEGER NOT NULL,
  duracao_minutos INTEGER NOT NULL,
  descricao TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agendamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_nome TEXT NOT NULL,
  cliente_telefone TEXT NOT NULL,
  cliente_email TEXT,
  servico_id INTEGER NOT NULL REFERENCES servicos(id),
  data_agendamento TEXT NOT NULL,
  hora_agendamento TEXT NOT NULL,
  starts_at_utc TEXT NOT NULL,
  duracao_minutos INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'agendado' CHECK(status IN ('agendado','presente','cancelado')),
  motivo_cancelamento TEXT,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  lembrete_24h_enviado_em TEXT,
  lembrete_3h_enviado_em TEXT
);
CREATE TABLE IF NOT EXISTS clientes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_nome TEXT NOT NULL,
  cliente_telefone TEXT NOT NULL,
  cliente_email TEXT NOT NULL COLLATE NOCASE,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  UNIQUE(cliente_telefone, cliente_email)
);
CREATE TABLE IF NOT EXISTS horarios_bloqueados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data TEXT NOT NULL,
  hora TEXT NOT NULL,
  motivo TEXT NOT NULL DEFAULT 'Horário bloqueado pelo barbeiro',
  UNIQUE(data, hora)
);
CREATE TABLE IF NOT EXISTS feriados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data TEXT NOT NULL UNIQUE,
  motivo TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  email TEXT NOT NULL,
  senha_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
  telefone TEXT PRIMARY KEY,
  tentativas INTEGER NOT NULL DEFAULT 0,
  dia TEXT NOT NULL,
  bloqueado_ate TEXT
);
`);

// Migração automática: remove o antigo código de confirmação sem apagar os agendamentos já salvos.
function appointmentColumns() { return db.prepare('PRAGMA table_info(agendamentos)').all().map(column => column.name); }
const migratedFromCode = appointmentColumns().includes('confirmation_code');
if (migratedFromCode) {
  const migrateAppointments = db.transaction(() => {
    db.exec(`DROP INDEX IF EXISTS idx_agendamentos_data; DROP INDEX IF EXISTS idx_agendamentos_telefone;
      ALTER TABLE agendamentos RENAME TO agendamentos_com_codigo;
      CREATE TABLE agendamentos (
        id INTEGER PRIMARY KEY AUTOINCREMENT, cliente_nome TEXT NOT NULL, cliente_telefone TEXT NOT NULL, cliente_email TEXT,
        servico_id INTEGER NOT NULL REFERENCES servicos(id), data_agendamento TEXT NOT NULL, hora_agendamento TEXT NOT NULL,
        starts_at_utc TEXT NOT NULL, duracao_minutos INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'agendado' CHECK(status IN ('agendado','presente','cancelado')),
        motivo_cancelamento TEXT, criado_em TEXT NOT NULL, atualizado_em TEXT NOT NULL,
        lembrete_24h_enviado_em TEXT, lembrete_3h_enviado_em TEXT
      );
      INSERT INTO agendamentos (id,cliente_nome,cliente_telefone,cliente_email,servico_id,data_agendamento,hora_agendamento,starts_at_utc,duracao_minutos,status,motivo_cancelamento,criado_em,atualizado_em)
      SELECT id,cliente_nome,cliente_telefone,cliente_email,servico_id,data_agendamento,hora_agendamento,starts_at_utc,duracao_minutos,status,motivo_cancelamento,criado_em,atualizado_em FROM agendamentos_com_codigo;
      DROP TABLE agendamentos_com_codigo;`);
  });
  migrateAppointments();
}
// Garante as colunas de lembrete em bancos criados em versões intermediárias.
const existingColumns = appointmentColumns();
if (!existingColumns.includes('lembrete_24h_enviado_em')) db.exec('ALTER TABLE agendamentos ADD COLUMN lembrete_24h_enviado_em TEXT');
if (!existingColumns.includes('lembrete_3h_enviado_em')) db.exec('ALTER TABLE agendamentos ADD COLUMN lembrete_3h_enviado_em TEXT');
db.exec(`CREATE INDEX IF NOT EXISTS idx_agendamentos_data ON agendamentos(data_agendamento, hora_agendamento);
CREATE INDEX IF NOT EXISTS idx_agendamentos_telefone ON agendamentos(cliente_telefone);
CREATE INDEX IF NOT EXISTS idx_agendamentos_email ON agendamentos(cliente_email);`);
// Pré-cadastra os clientes encontrados em agendamentos antigos que já tinham e-mail.
const backfillCustomers = db.prepare(`INSERT INTO clientes (cliente_nome,cliente_telefone,cliente_email,criado_em,atualizado_em) VALUES (?,?,?,?,?) ON CONFLICT(cliente_telefone,cliente_email) DO UPDATE SET cliente_nome=excluded.cliente_nome, atualizado_em=excluded.atualizado_em`);
for (const oldCustomer of db.prepare(`SELECT cliente_nome,cliente_telefone,cliente_email,MIN(criado_em) AS criado_em,MAX(atualizado_em) AS atualizado_em FROM agendamentos WHERE cliente_email IS NOT NULL AND trim(cliente_email) != '' GROUP BY cliente_telefone,cliente_email`).all()) {
  backfillCustomers.run(oldCustomer.cliente_nome, oldCustomer.cliente_telefone, oldCustomer.cliente_email.toLowerCase(), oldCustomer.criado_em, oldCustomer.atualizado_em);
}
// Limpa bloqueios do método antigo apenas uma vez, durante a migração.
if (migratedFromCode) db.prepare('DELETE FROM login_attempts').run();

const seed = db.prepare(`INSERT INTO servicos (id,nome,preco_cents,duracao_minutos,descricao) VALUES (@id,@nome,@preco_cents,@duracao_minutos,@descricao) ON CONFLICT(id) DO NOTHING`);
[
  { id: 1, nome: 'Corte de cabelo', preco_cents: 5000, duracao_minutos: 30, descricao: 'Corte na régua, do clássico ao moderno.' },
  { id: 2, nome: 'Barba', preco_cents: 3500, duracao_minutos: 20, descricao: 'Acabamento preciso e cuidado nos detalhes.' },
  { id: 3, nome: 'Sobrancelha', preco_cents: 2000, duracao_minutos: 15, descricao: 'Design limpo e natural para valorizar o olhar.' },
  { id: 4, nome: 'Pintura capilar', preco_cents: 8000, duracao_minutos: 60, descricao: 'Cor uniforme com atenção ao acabamento.' },
  { id: 5, nome: 'Combo corte + barba', preco_cents: 7500, duracao_minutos: 45, descricao: 'Visual renovado: corte e barba no mesmo atendimento.' }
].forEach(service => seed.run(service));
const adminHash = bcrypt.hashSync(ADMIN_PASSWORD, 12);
db.prepare(`INSERT INTO admin (id,email,senha_hash) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email, senha_hash=excluded.senha_hash`).run(ADMIN_EMAIL, adminHash);

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false })); // CSS e scripts locais; CSP pode ser habilitada ao personalizar a hospedagem.
app.use(express.json({ limit: '40kb' }));
app.use(express.urlencoded({ extended: false, limit: '40kb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/admin/login', rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' } }));

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir, { extensions: ['html'] }));

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const pad = n => String(n).padStart(2, '0');
const dateOnly = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localToday = () => { const p = localParts(new Date()); return `${p.year}-${p.month}-${p.day}`; };
function localParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}
function localToUtc(dateStr, timeStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const desired = Date.UTC(y, mo - 1, d, h, mi, 0);
  let guess = desired;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(guess));
    const represented = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    guess += desired - represented;
  }
  return new Date(guess);
}
function utcToLocal(iso) {
  const p = localParts(new Date(iso));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
function normalizePhone(input) {
  let n = String(input || '').replace(/\D/g, '');
  if ((n.length === 12 || n.length === 13) && n.startsWith('55')) n = n.slice(2);
  return n;
}
function validBrazilianPhone(input) {
  const n = normalizePhone(input);
  return /^\d{10,11}$/.test(n) && /^[1-9]\d/.test(n) && (n.length !== 11 || n[2] === '9');
}
function formatPhone(input) {
  const n = normalizePhone(input);
  if (n.length === 11) return `(${n.slice(0,2)}) ${n.slice(2,7)}-${n.slice(7)}`;
  if (n.length === 10) return `(${n.slice(0,2)}) ${n.slice(2,6)}-${n.slice(6)}`;
  return n;
}
function cleanText(v, max = 120) { return String(v ?? '').trim().replace(/[<>]/g, '').slice(0, max); }
function normalizeEmail(input) { return cleanText(input, 160).toLowerCase(); }
function validEmail(input) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(input || '')); }
function registerCustomer({ name, phone, email, now = new Date().toISOString() }) {
  db.prepare(`INSERT INTO clientes (cliente_nome,cliente_telefone,cliente_email,criado_em,atualizado_em) VALUES (?,?,?,?,?)
    ON CONFLICT(cliente_telefone,cliente_email) DO UPDATE SET cliente_nome=excluded.cliente_nome, atualizado_em=excluded.atualizado_em`).run(name, phone, email, now, now);
}
function getService(id) { return db.prepare('SELECT id,nome,preco_cents,duracao_minutos,descricao FROM servicos WHERE id=?').get(Number(id)); }
function getAppointment(id) {
  return db.prepare(`SELECT a.*, s.nome AS servico_nome, s.preco_cents AS preco_cents FROM agendamentos a JOIN servicos s ON s.id=a.servico_id WHERE a.id=?`).get(Number(id));
}
function publicAppointment(a) {
  return {
    id: a.id,
    nome: a.cliente_nome,
    telefone: formatPhone(a.cliente_telefone),
    telefone_normalizado: a.cliente_telefone,
    email: a.cliente_email || null,
    servico_id: a.servico_id,
    servico: a.servico_nome,
    preco: (a.preco_cents / 100),
    data: a.data_agendamento,
    hora: a.hora_agendamento,
    duracao_minutos: a.duracao_minutos,
    status: a.status,
    motivo_cancelamento: a.motivo_cancelamento || null,
    criado_em: a.criado_em
  };
}
function ensureDate(dateStr, { allowToday = false } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) throw new HttpError(400, 'Informe uma data válida.');
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) throw new HttpError(400, 'Informe uma data válida.');
  const today = localToday();
  if (dateStr < today || (!allowToday && dateStr === today)) throw new HttpError(400, 'Escolha uma data futura.');
  const max = new Date(`${today}T12:00:00Z`); max.setUTCDate(max.getUTCDate() + 30);
  const maxDate = `${max.getUTCFullYear()}-${pad(max.getUTCMonth() + 1)}-${pad(max.getUTCDate())}`;
  if (dateStr > maxDate) throw new HttpError(400, 'Os agendamentos podem ser feitos com até 30 dias de antecedência.');
  if (date.getUTCDay() === 0) throw new HttpError(400, 'A barbearia fecha aos domingos. Escolha outro dia.');
  if (db.prepare('SELECT 1 FROM feriados WHERE data=?').get(dateStr)) throw new HttpError(400, 'A barbearia não atende nesta data. Escolha outro dia.');
  return date;
}
function startUtc(dateStr, timeStr) { return localToUtc(dateStr, timeStr); }
function durationSlots(mins) { return Math.ceil(Number(mins) / 30); }
function isValidTimeFormat(t) { return /^([01]\d|2[0-3]):(00|30)$/.test(String(t || '')); }
function hasOverlap(dateStr, timeStr, durationMinutes, ignoreId = null) {
  const start = startUtc(dateStr, timeStr).getTime();
  const end = start + durationMinutes * 60_000;
  const appts = db.prepare(`SELECT id,hora_agendamento,duracao_minutos FROM agendamentos WHERE data_agendamento=? AND status!='cancelado' ${ignoreId ? 'AND id != ?' : ''}`).all(...(ignoreId ? [dateStr, ignoreId] : [dateStr]));
  for (const a of appts) {
    const otherStart = startUtc(dateStr, a.hora_agendamento).getTime();
    const otherEnd = otherStart + a.duracao_minutos * 60_000;
    if (start < otherEnd && end > otherStart) return true;
  }
  // Explicit manual blocks have 30-minute granularity and collide with every slot touched by the service.
  const blocks = db.prepare('SELECT hora FROM horarios_bloqueados WHERE data=?').all(dateStr);
  for (const b of blocks) {
    const blockStart = startUtc(dateStr, b.hora).getTime();
    if (start < blockStart + 30 * 60_000 && end > blockStart) return true;
  }
  // Lunch is always unavailable, even if an admin forgets to add a block.
  const lunchStart = startUtc(dateStr, '12:00').getTime();
  const lunchEnd = startUtc(dateStr, '13:00').getTime();
  if (start < lunchEnd && end > lunchStart) return true;
  return false;
}
function validateBookable({ date, time, service, isAdmin = false, ignoreId = null }) {
  ensureDate(date, { allowToday: isAdmin });
  if (!service) throw new HttpError(400, 'Selecione um serviço válido.');
  if (!isValidTimeFormat(time)) throw new HttpError(400, 'Selecione um horário válido.');
  const minsFromMidnight = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  if (minsFromMidnight < 9 * 60 || minsFromMidnight >= 19 * 60 + 30) throw new HttpError(400, 'O horário precisa estar entre 09h e 19h30.');
  if (minsFromMidnight + service.duracao_minutos > 19 * 60 + 30) throw new HttpError(400, 'Esse serviço ultrapassa o horário de fechamento.');
  if (date === localToday() && !isAdmin) throw new HttpError(400, 'Para agendar, escolha um dia a partir de amanhã.');
  const start = startUtc(date, time);
  if (start.getTime() - Date.now() < 2 * 60 * 60_000) throw new HttpError(400, 'O agendamento precisa ser feito com pelo menos 2 horas de antecedência.');
  if (hasOverlap(date, time, service.duracao_minutos, ignoreId)) throw new HttpError(409, 'Esse horário acabou de ficar indisponível. Escolha outro horário.');
}
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') throw new Error('wrong role');
    req.admin = decoded;
    next();
  } catch { res.status(401).json({ error: 'Sessão expirada. Entre novamente.' }); }
}
function validCustomerAuth(phoneInput, emailInput) {
  const phone = normalizePhone(phoneInput);
  const email = normalizeEmail(emailInput);
  if (!validBrazilianPhone(phone) || !validEmail(email)) return { ok: false, phone };
  const today = localToday();
  const attempt = db.prepare('SELECT * FROM login_attempts WHERE telefone=?').get(phone);
  if (attempt && attempt.dia === today && attempt.bloqueado_ate && new Date(attempt.bloqueado_ate) > new Date()) return { ok: false, phone, blocked: true };
  const ok = !!db.prepare('SELECT id FROM clientes WHERE cliente_telefone=? AND cliente_email=? COLLATE NOCASE').get(phone, email);
  if (ok) { db.prepare('DELETE FROM login_attempts WHERE telefone=?').run(phone); return { ok: true, phone, email }; }
  let tries = attempt && attempt.dia === today ? attempt.tentativas : 0;
  tries += 1;
  const blockedUntil = tries >= 3 ? new Date(Date.now() + 24 * 60 * 60_000).toISOString() : null;
  db.prepare(`INSERT INTO login_attempts (telefone,tentativas,dia,bloqueado_ate) VALUES (?,?,?,?) ON CONFLICT(telefone) DO UPDATE SET tentativas=excluded.tentativas,dia=excluded.dia,bloqueado_ate=excluded.bloqueado_ate`).run(phone, tries, today, blockedUntil);
  return { ok: false, phone, blocked: tries >= 3 };
}
function catchRoute(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }

app.get('/api/health', (req, res) => res.json({ ok: true, timezone: TIME_ZONE, service: 'Barbearia do Semá API' }));
app.get('/api/services', (req, res) => {
  const services = db.prepare('SELECT id,nome,preco_cents,duracao_minutos,descricao FROM servicos ORDER BY id').all();
  res.json(services.map(s => ({ id: s.id, nome: s.nome, preco: s.preco_cents / 100, duracao_minutos: s.duracao_minutos, slots: durationSlots(s.duracao_minutos), descricao: s.descricao })));
});

app.get('/api/available-slots/:data/:service_id', (req, res, next) => {
  try {
    const date = req.params.data;
    const service = getService(req.params.service_id);
    // Reuse date validation but allow date today to return an empty list rather than break the booking UI.
    ensureDate(date, { allowToday: true });
    if (date === localToday()) return res.json({ data: date, service_id: service?.id, slots: [], message: 'Agendamentos online devem ser feitos a partir de amanhã.' });
    if (!service) throw new HttpError(404, 'Serviço não encontrado.');
    const slots = [];
    for (let minutes = 9 * 60; minutes < 19 * 60 + 30; minutes += 30) {
      const time = `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
      if (minutes + service.duracao_minutos > 19 * 60 + 30) continue;
      const start = startUtc(date, time);
      if (start.getTime() - Date.now() < 2 * 60 * 60_000) continue;
      if (!hasOverlap(date, time, service.duracao_minutos)) slots.push(time);
    }
    res.json({ data: date, service_id: service.id, slots });
  } catch (e) { next(e); }
});

app.post('/api/appointments', (req, res, next) => {
  try {
    const name = cleanText(req.body.nome, 80);
    const phone = normalizePhone(req.body.telefone);
    const email = normalizeEmail(req.body.email);
    const service = getService(req.body.servico_id);
    const date = String(req.body.data || '');
    const time = String(req.body.hora || '');
    if (name.length < 2) throw new HttpError(400, 'Informe seu nome completo.');
    if (!validBrazilianPhone(phone)) throw new HttpError(400, 'Informe um telefone brasileiro válido com DDD.');
    if (!validEmail(email)) throw new HttpError(400, 'Informe um e-mail válido para cadastrar seu contato e receber os lembretes.');
    validateBookable({ date, time, service });
    const now = new Date().toISOString();
    let id;
    const create = db.transaction(() => {
      if (hasOverlap(date, time, service.duracao_minutos)) throw new HttpError(409, 'Esse horário acabou de ficar indisponível. Escolha outro horário.');
      registerCustomer({ name, phone, email, now });
      const result = db.prepare(`INSERT INTO agendamentos (cliente_nome,cliente_telefone,cliente_email,servico_id,data_agendamento,hora_agendamento,starts_at_utc,duracao_minutos,status,criado_em,atualizado_em) VALUES (?,?,?,?,?,?,?,?, 'agendado',?,?)`).run(name, phone, email, service.id, date, time, startUtc(date, time).toISOString(), service.duracao_minutos, now, now);
      id = Number(result.lastInsertRowid);
    });
    create();
    res.status(201).json({ message: 'Agendamento realizado!', lembretes_email_ativos: SMTP_CONFIGURED, agendamento: { id, nome: name, telefone: formatPhone(phone), email, servico: service.nome, preco: service.preco_cents / 100, data: date, hora: time, status: 'agendado' } });
  } catch (e) { next(e); }
});

app.post('/api/authenticate', (req, res, next) => {
  try {
    const auth = validCustomerAuth(req.body.telefone, req.body.email);
    if (!auth.ok) throw new HttpError(401, auth.blocked ? 'Acesso temporariamente bloqueado por segurança. Tente novamente amanhã.' : 'Telefone e e-mail não conferem. Confira os dados e tente novamente.');
    const rows = db.prepare(`SELECT a.*,s.nome AS servico_nome,s.preco_cents FROM agendamentos a JOIN servicos s ON s.id=a.servico_id WHERE a.cliente_telefone=? AND lower(a.cliente_email)=? ORDER BY a.data_agendamento DESC,a.hora_agendamento DESC`).all(auth.phone, auth.email);
    res.json({ agendamentos: rows.map(publicAppointment) });
  } catch (e) { next(e); }
});

app.put('/api/appointments/:id', (req, res, next) => {
  try {
    const auth = validCustomerAuth(req.body.telefone, req.body.email);
    if (!auth.ok) throw new HttpError(401, auth.blocked ? 'Acesso temporariamente bloqueado por segurança. Tente novamente amanhã.' : 'Telefone e e-mail não conferem.');
    const old = getAppointment(req.params.id);
    if (!old || old.cliente_telefone !== auth.phone || normalizeEmail(old.cliente_email) !== auth.email) throw new HttpError(404, 'Agendamento não encontrado.');
    if (old.status === 'cancelado') throw new HttpError(400, 'Este agendamento já foi cancelado.');
    if (startUtc(old.data_agendamento, old.hora_agendamento).getTime() - Date.now() < 2 * 60 * 60_000) throw new HttpError(400, 'Não é possível editar faltando menos de 2 horas para o horário marcado.');
    const service = getService(req.body.servico_id);
    const date = String(req.body.data || ''); const time = String(req.body.hora || '');
    validateBookable({ date, time, service, ignoreId: old.id });
    const update = db.transaction(() => {
      if (hasOverlap(date, time, service.duracao_minutos, old.id)) throw new HttpError(409, 'Esse horário acabou de ficar indisponível. Escolha outro horário.');
      db.prepare(`UPDATE agendamentos SET servico_id=?,data_agendamento=?,hora_agendamento=?,starts_at_utc=?,duracao_minutos=?,atualizado_em=?,lembrete_24h_enviado_em=NULL,lembrete_3h_enviado_em=NULL WHERE id=?`).run(service.id, date, time, startUtc(date, time).toISOString(), service.duracao_minutos, new Date().toISOString(), old.id);
    });
    update();
    res.json({ message: 'Agendamento atualizado.', agendamento: publicAppointment(getAppointment(old.id)) });
  } catch (e) { next(e); }
});

app.delete('/api/appointments/:id', (req, res, next) => {
  try {
    const auth = validCustomerAuth(req.body.telefone, req.body.email);
    if (!auth.ok) throw new HttpError(401, auth.blocked ? 'Acesso temporariamente bloqueado por segurança. Tente novamente amanhã.' : 'Telefone e e-mail não conferem.');
    const a = getAppointment(req.params.id);
    if (!a || a.cliente_telefone !== auth.phone || normalizeEmail(a.cliente_email) !== auth.email) throw new HttpError(404, 'Agendamento não encontrado.');
    if (a.status === 'cancelado') throw new HttpError(400, 'Este agendamento já foi cancelado.');
    if (startUtc(a.data_agendamento, a.hora_agendamento).getTime() - Date.now() < 2 * 60 * 60_000) throw new HttpError(400, 'Não é possível cancelar faltando menos de 2 horas para o horário marcado.');
    db.prepare(`UPDATE agendamentos SET status='cancelado',motivo_cancelamento=?,atualizado_em=? WHERE id=?`).run('Cancelado pelo cliente', new Date().toISOString(), a.id);
    res.json({ message: 'Agendamento cancelado.' });
  } catch (e) { next(e); }
});

app.post('/admin/login', (req, res, next) => {
  try {
    const email = cleanText(req.body.email, 160).toLowerCase();
    const password = String(req.body.senha || '');
    const admin = db.prepare('SELECT * FROM admin WHERE id=1').get();
    if (!admin || email !== admin.email || !bcrypt.compareSync(password, admin.senha_hash)) throw new HttpError(401, 'E-mail ou senha incorretos.');
    const token = jwt.sign({ role: 'admin', email: admin.email }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, email: admin.email, expires_in: 28800 });
  } catch (e) { next(e); }
});
app.get('/admin/available-slots/:data/:service_id', requireAdmin, (req, res, next) => {
  try {
    const date = req.params.data;
    const service = getService(req.params.service_id);
    ensureDate(date, { allowToday: true });
    if (!service) throw new HttpError(404, 'Serviço não encontrado.');
    const slots = [];
    for (let minutes = 9 * 60; minutes < 19 * 60 + 30; minutes += 30) {
      const time = `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
      if (minutes + service.duracao_minutos > 19 * 60 + 30) continue;
      if (startUtc(date, time).getTime() - Date.now() < 2 * 60 * 60_000) continue;
      if (!hasOverlap(date, time, service.duracao_minutos)) slots.push(time);
    }
    res.json({ data: date, service_id: service.id, slots });
  } catch (e) { next(e); }
});
app.post('/admin/appointments', requireAdmin, (req, res, next) => {
  try {
    const name = cleanText(req.body.nome, 80);
    const phone = normalizePhone(req.body.telefone);
    const email = normalizeEmail(req.body.email);
    const service = getService(req.body.servico_id);
    const date = String(req.body.data || '');
    const time = String(req.body.hora || '');
    if (name.length < 2) throw new HttpError(400, 'Informe o nome do cliente.');
    if (!validBrazilianPhone(phone)) throw new HttpError(400, 'Informe um telefone brasileiro válido com DDD.');
    if (!validEmail(email)) throw new HttpError(400, 'Informe um e-mail válido para que os lembretes possam ser enviados.');
    validateBookable({ date, time, service, isAdmin: true });
    const now = new Date().toISOString();
    let id;
    const create = db.transaction(() => {
      if (hasOverlap(date, time, service.duracao_minutos)) throw new HttpError(409, 'Esse horário acabou de ficar indisponível. Escolha outro horário.');
      registerCustomer({ name, phone, email, now });
      const result = db.prepare(`INSERT INTO agendamentos (cliente_nome,cliente_telefone,cliente_email,servico_id,data_agendamento,hora_agendamento,starts_at_utc,duracao_minutos,status,criado_em,atualizado_em) VALUES (?,?,?,?,?,?,?,?, 'agendado',?,?)`).run(name, phone, email, service.id, date, time, startUtc(date, time).toISOString(), service.duracao_minutos, now, now);
      id = Number(result.lastInsertRowid);
    });
    create();
    res.status(201).json({ message: 'Agendamento criado pelo painel.', lembretes_email_ativos: SMTP_CONFIGURED, agendamento: { id, nome: name, telefone: formatPhone(phone), email, servico: service.nome, preco: service.preco_cents / 100, data, hora: time, status: 'agendado' } });
  } catch (e) { next(e); }
});

app.get('/admin/appointments', requireAdmin, (req, res, next) => {
  try {
    const from = req.query.de ? String(req.query.de) : localToday();
    const to = req.query.ate ? String(req.query.ate) : from;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new HttpError(400, 'Período inválido.');
    const rows = db.prepare(`SELECT a.*,s.nome AS servico_nome,s.preco_cents FROM agendamentos a JOIN servicos s ON s.id=a.servico_id WHERE a.data_agendamento BETWEEN ? AND ? ORDER BY a.data_agendamento,a.hora_agendamento`).all(from, to);
    res.json({ agendamentos: rows.map(publicAppointment), feriados: db.prepare('SELECT * FROM feriados WHERE data BETWEEN ? AND ? ORDER BY data').all(from, to), bloqueios: db.prepare('SELECT * FROM horarios_bloqueados WHERE data BETWEEN ? AND ? ORDER BY data,hora').all(from, to) });
  } catch (e) { next(e); }
});
app.post('/admin/appointments/:id/confirm', requireAdmin, (req, res, next) => {
  try {
    const a = getAppointment(req.params.id);
    if (!a) throw new HttpError(404, 'Agendamento não encontrado.');
    if (a.status === 'cancelado') throw new HttpError(400, 'Não é possível confirmar um agendamento cancelado.');
    db.prepare(`UPDATE agendamentos SET status='presente',atualizado_em=? WHERE id=?`).run(new Date().toISOString(), a.id);
    res.json({ message: 'Presença confirmada.', agendamento: publicAppointment(getAppointment(a.id)) });
  } catch (e) { next(e); }
});
app.post('/admin/appointments/:id/cancel', requireAdmin, (req, res, next) => {
  try {
    const a = getAppointment(req.params.id);
    if (!a) throw new HttpError(404, 'Agendamento não encontrado.');
    if (a.status === 'cancelado') throw new HttpError(400, 'Este agendamento já está cancelado.');
    const reason = cleanText(req.body.motivo, 180) || 'Cancelado pela barbearia';
    db.prepare(`UPDATE agendamentos SET status='cancelado',motivo_cancelamento=?,atualizado_em=? WHERE id=?`).run(reason, new Date().toISOString(), a.id);
    res.json({ message: 'Agendamento cancelado.' });
  } catch (e) { next(e); }
});
app.post('/admin/block-slots', requireAdmin, (req, res, next) => {
  try {
    const date = String(req.body.data || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Informe uma data válida.');
    const [y,m,d] = date.split('-').map(Number); const parsed = new Date(Date.UTC(y,m-1,d));
    if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m-1 || parsed.getUTCDate() !== d) throw new HttpError(400, 'Informe uma data válida.');
    if (!isValidTimeFormat(req.body.hora) || Number(req.body.hora.slice(0,2))*60+Number(req.body.hora.slice(3)) < 9*60 || Number(req.body.hora.slice(0,2))*60+Number(req.body.hora.slice(3)) >= 19*60+30) throw new HttpError(400, 'Escolha um horário de meia em meia hora, entre 09h e 19h.');
    const reason = cleanText(req.body.motivo, 140) || 'Horário bloqueado pelo barbeiro';
    db.prepare(`INSERT INTO horarios_bloqueados (data,hora,motivo) VALUES (?,?,?) ON CONFLICT(data,hora) DO UPDATE SET motivo=excluded.motivo`).run(date, req.body.hora, reason);
    res.status(201).json({ message: 'Horário bloqueado.' });
  } catch (e) { next(e); }
});
app.delete('/admin/block-slots/:id', requireAdmin, (req, res, next) => {
  try { const result = db.prepare('DELETE FROM horarios_bloqueados WHERE id=?').run(Number(req.params.id)); if (!result.changes) throw new HttpError(404, 'Bloqueio não encontrado.'); res.json({ message: 'Bloqueio removido.' }); }
  catch (e) { next(e); }
});
app.post('/admin/holidays', requireAdmin, (req, res, next) => {
  try {
    const date = String(req.body.data || ''); const reason = cleanText(req.body.motivo, 140) || 'Feriado';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Informe uma data válida.');
    const [y,m,d] = date.split('-').map(Number); const parsed = new Date(Date.UTC(y,m-1,d));
    if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m-1 || parsed.getUTCDate() !== d) throw new HttpError(400, 'Informe uma data válida.');
    db.prepare('INSERT INTO feriados (data,motivo) VALUES (?,?) ON CONFLICT(data) DO UPDATE SET motivo=excluded.motivo').run(date, reason);
    res.status(201).json({ message: 'Feriado cadastrado.' });
  } catch (e) { next(e); }
});
app.delete('/admin/holidays/:id', requireAdmin, (req, res, next) => {
  try { const result = db.prepare('DELETE FROM feriados WHERE id=?').run(Number(req.params.id)); if (!result.changes) throw new HttpError(404, 'Feriado não encontrado.'); res.json({ message: 'Feriado removido.' }); }
  catch (e) { next(e); }
});

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
function formattedAppointmentDate(dateStr, timeStr) {
  const instant = startUtc(dateStr, timeStr);
  return {
    date: new Intl.DateTimeFormat('pt-BR', { timeZone: TIME_ZONE, weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }).format(instant),
    time: timeStr
  };
}
async function sendReminderEmail(appointment, type) {
  if (!mailer || !appointment.cliente_email) return false;
  const when = formattedAppointmentDate(appointment.data_agendamento, appointment.hora_agendamento);
  const isDayBefore = type === '24h';
  const localTodayString = localToday();
  const dayAfterToday = new Date(`${localTodayString}T12:00:00Z`); dayAfterToday.setUTCDate(dayAfterToday.getUTCDate() + 1);
  const tomorrowString = `${dayAfterToday.getUTCFullYear()}-${pad(dayAfterToday.getUTCMonth() + 1)}-${pad(dayAfterToday.getUTCDate())}`;
  const dayBeforeTitle = appointment.data_agendamento === tomorrowString ? 'Seu horário é amanhã!' : 'Seu atendimento está chegando!';
  const title = isDayBefore ? dayBeforeTitle : 'Faltam cerca de 3 horas para seu horário!';
  const subject = isDayBefore ? 'Lembrete: sua visita à Barbearia do Semá está chegando' : 'Lembrete: seu horário na Barbearia do Semá é daqui a 3 horas';
  const name = htmlEscape(appointment.cliente_nome);
  const service = htmlEscape(appointment.servico_nome);
  const date = htmlEscape(when.date);
  const time = htmlEscape(when.time);
  const site = htmlEscape(PUBLIC_URL);
  const plain = `Olá, ${appointment.cliente_nome}!\n\n${title}\nServiço: ${appointment.servico_nome}\nData: ${when.date}\nHorário: ${when.time}\n\nAtenção: o cancelamento pelo site só pode ser feito até 2 horas antes do horário marcado.\n\nBarbearia do Semá\nRua Tiradentes, 377, Itacolomi, Sabará/MG\n${PUBLIC_URL}`;
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f1e9;font-family:Arial,sans-serif;color:#282b24"><div style="max-width:560px;margin:24px auto;padding:32px;background:#fffdf8;border:1px solid #e3ddcf;border-radius:16px"><p style="letter-spacing:2px;font-size:11px;color:#a8783f;font-weight:bold">BARBEARIA DO SEMÁ · SABARÁ/MG</p><h1 style="font-size:27px;line-height:1.2">${htmlEscape(title)}</h1><p>Olá, <strong>${name}</strong>! Passando para lembrar do seu atendimento:</p><div style="padding:20px;background:#f4f1e9;border-radius:10px;margin:22px 0"><p style="margin:0 0 8px"><strong>Serviço:</strong> ${service}</p><p style="margin:0 0 8px"><strong>Data:</strong> ${date}</p><p style="margin:0"><strong>Horário:</strong> ${time}</p></div><p style="padding:14px;border-left:4px solid #b9874d;background:#faf4e9"><strong>Importante:</strong> o cancelamento pelo site só pode ser feito até 2 horas antes do horário marcado.</p><p>Até lá! Estamos te esperando.</p><p style="margin-top:28px;font-size:12px;color:#777">Rua Tiradentes, 377 · Itacolomi · Sabará/MG<br><a href="${site}" style="color:#946a36">Acessar a Barbearia do Semá</a></p></div></body></html>`;
  await mailer.sendMail({ from: EMAIL_FROM, to: appointment.cliente_email, subject, text: plain, html });
  return true;
}
let reminderJobRunning = false;
async function dispatchDueReminders() {
  if (!mailer || reminderJobRunning) return;
  reminderJobRunning = true;
  try {
    const rows = db.prepare(`SELECT a.*,s.nome AS servico_nome,s.preco_cents FROM agendamentos a JOIN servicos s ON s.id=a.servico_id WHERE a.status='agendado' AND a.cliente_email IS NOT NULL AND trim(a.cliente_email) != '' AND a.starts_at_utc > ? ORDER BY a.starts_at_utc`).all(new Date().toISOString());
    const now = Date.now();
    const dayMs = 24 * 60 * 60_000;
    const threeHoursMs = 3 * 60 * 60_000;
    for (const appointment of rows) {
      const delta = new Date(appointment.starts_at_utc).getTime() - now;
      if (!Number.isFinite(delta) || delta <= 0) continue;
      if (!appointment.lembrete_24h_enviado_em && delta <= dayMs && delta > threeHoursMs) {
        try {
          if (await sendReminderEmail(appointment, '24h')) db.prepare('UPDATE agendamentos SET lembrete_24h_enviado_em=? WHERE id=? AND lembrete_24h_enviado_em IS NULL').run(new Date().toISOString(), appointment.id);
        } catch (error) { console.error(`[lembretes] Falha no lembrete de 24h do agendamento ${appointment.id}:`, error.message); }
      }
      // Se o servidor ficou desligado e perdeu o lembrete de 24h, prioriza o de 3h ao reabrir perto do atendimento.
      if (!appointment.lembrete_3h_enviado_em && delta <= threeHoursMs) {
        try {
          if (await sendReminderEmail(appointment, '3h')) db.prepare('UPDATE agendamentos SET lembrete_3h_enviado_em=? WHERE id=? AND lembrete_3h_enviado_em IS NULL').run(new Date().toISOString(), appointment.id);
        } catch (error) { console.error(`[lembretes] Falha no lembrete de 3h do agendamento ${appointment.id}:`, error.message); }
      }
    }
  } finally { reminderJobRunning = false; }
}

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/admin/')) return next();
  res.sendFile(path.join(publicDir, 'index.html'));
});
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number(err.status) || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Ocorreu um erro inesperado. Tente novamente.' : err.message });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Barbearia do Semá disponível em http://localhost:${PORT}`);
    if (JWT_SECRET === 'development-only-change-me-before-deploying-2026') console.warn('AVISO: configure JWT_SECRET antes de publicar.');
    if (ADMIN_PASSWORD === 'Sema@2026!') console.warn('AVISO: configure ADMIN_PASSWORD antes de publicar.');
    if (!SMTP_CONFIGURED) console.warn('AVISO: configure SMTP_HOST, SMTP_USER, SMTP_PASS e EMAIL_FROM para ativar os lembretes por e-mail.');
    dispatchDueReminders().catch(error => console.error('[lembretes] Erro no ciclo inicial:', error.message));
    const reminderTimer = setInterval(() => dispatchDueReminders().catch(error => console.error('[lembretes] Erro no ciclo:', error.message)), 60_000);
    reminderTimer.unref();
  });
}
module.exports = { app, db, localToUtc, utcToLocal, durationSlots, validBrazilianPhone, hasOverlap, ensureDate, validEmail, dispatchDueReminders };
