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
const BookingRules = require('./public/booking-rules.js');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const TIME_ZONE = 'America/Sao_Paulo';
const MIN_BOOKING_NOTICE_MS = 10 * 60_000;
const REMINDER_DELIVERY_WINDOW_MS = 15 * 60_000;
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
  programado_em TEXT NOT NULL,
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
        motivo_cancelamento TEXT, criado_em TEXT NOT NULL, atualizado_em TEXT NOT NULL, programado_em TEXT NOT NULL,
        lembrete_24h_enviado_em TEXT, lembrete_3h_enviado_em TEXT
      );
      INSERT INTO agendamentos (id,cliente_nome,cliente_telefone,cliente_email,servico_id,data_agendamento,hora_agendamento,starts_at_utc,duracao_minutos,status,motivo_cancelamento,criado_em,atualizado_em,programado_em)
      SELECT id,cliente_nome,cliente_telefone,cliente_email,servico_id,data_agendamento,hora_agendamento,starts_at_utc,duracao_minutos,status,motivo_cancelamento,criado_em,atualizado_em,COALESCE(atualizado_em,criado_em) FROM agendamentos_com_codigo;
      DROP TABLE agendamentos_com_codigo;`);
  });
  migrateAppointments();
}
// Garante as colunas de lembrete em bancos criados em versões intermediárias.
const existingColumns = appointmentColumns();
if (!existingColumns.includes('lembrete_24h_enviado_em')) db.exec('ALTER TABLE agendamentos ADD COLUMN lembrete_24h_enviado_em TEXT');
if (!existingColumns.includes('lembrete_3h_enviado_em')) db.exec('ALTER TABLE agendamentos ADD COLUMN lembrete_3h_enviado_em TEXT');
if (!existingColumns.includes('programado_em')) db.exec('ALTER TABLE agendamentos ADD COLUMN programado_em TEXT');
if (!existingColumns.includes('telefone_whatsapp')) db.exec('ALTER TABLE agendamentos ADD COLUMN telefone_whatsapp INTEGER NOT NULL DEFAULT 0');
db.exec("UPDATE agendamentos SET programado_em = COALESCE(programado_em, atualizado_em, criado_em) WHERE programado_em IS NULL OR trim(programado_em) = ''");
db.exec(`CREATE INDEX IF NOT EXISTS idx_agendamentos_data ON agendamentos(data_agendamento, hora_agendamento);
CREATE INDEX IF NOT EXISTS idx_agendamentos_telefone ON agendamentos(cliente_telefone);
CREATE INDEX IF NOT EXISTS idx_agendamentos_email ON agendamentos(cliente_email);`);
// Pré-cadastra os clientes encontrados em agendamentos antigos que já tinham e-mail.
const backfillCustomers = db.prepare(`INSERT INTO clientes (cliente_nome,cliente_telefone,cliente_email,criado_em,atualizado_em) VALUES (?,?,?,?,?) ON CONFLICT(cliente_telefone,cliente_email) DO UPDATE SET cliente_nome=excluded.cliente_nome, atualizado_em=excluded.atualizado_em`);
for (const oldCustomer of db.prepare(`SELECT cliente_nome,cliente_telefone,cliente_email,MIN(criado_em) AS criado_em,MAX(atualizado_em) AS atualizado_em FROM agendamentos WHERE cliente_email IS NOT NULL AND trim(cliente_email) != '' GROUP BY cliente_telefone,cliente_email`).all()) {
  backfillCustomers.run(oldCustomer.cliente_nome, oldCustomer.cliente_telefone, oldCustomer.cliente_email.toLowerCase(), oldCustomer.criado_em, oldCustomer.atualizado_em);
}
// Remove a tabela legada de tentativas: a consulta do cliente não usa bloqueio por telefone.
db.exec('DROP TABLE IF EXISTS login_attempts');

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
function normalizePhone(input) { return BookingRules.canonicalPhone(input); }
// Regra única (DDD + 9 + 8 dígitos) compartilhada com o navegador em public/booking-rules.js.
function validPhone(input) { return BookingRules.isValidPhone(input); }
function formatPhone(input) { return BookingRules.formatPhone(input); }
function cleanText(v, max = 120) { return String(v ?? '').trim().replace(/[<>]/g, '').slice(0, max); }
function normalizeEmail(input) { return cleanText(input, 160).toLowerCase(); }
function validEmail(input) { return BookingRules.isValidEmail(input); }
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
    whatsapp: !!a.telefone_whatsapp,
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
function hasMinimumBookingNotice(start, now = Date.now()) {
  const startMs = start instanceof Date ? start.getTime() : new Date(start).getTime();
  return Number.isFinite(startMs) && startMs - now >= MIN_BOOKING_NOTICE_MS;
}
function shouldSendReminder(appointment, type, now = Date.now()) {
  const thresholdMs = type === '24h' ? 24 * 60 * 60_000 : type === '3h' ? 3 * 60 * 60_000 : 0;
  if (!thresholdMs) return false;
  const startMs = Date.parse(appointment.starts_at_utc);
  const programmedAt = Date.parse(appointment.programado_em || appointment.atualizado_em || appointment.criado_em);
  const timeUntilStart = startMs - now;
  const bookingLeadTime = startMs - programmedAt;
  return Number.isFinite(startMs) && Number.isFinite(programmedAt)
    && bookingLeadTime >= thresholdMs
    && timeUntilStart <= thresholdMs
    && timeUntilStart > thresholdMs - REMINDER_DELIVERY_WINDOW_MS;
}
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
  ensureDate(date, { allowToday: true });
  if (!service) throw new HttpError(400, 'Selecione um serviço válido.');
  if (!isValidTimeFormat(time)) throw new HttpError(400, 'Selecione um horário válido.');
  const minsFromMidnight = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  if (minsFromMidnight < 9 * 60 || minsFromMidnight >= 19 * 60 + 30) throw new HttpError(400, 'O horário precisa estar entre 09h e 19h30.');
  if (minsFromMidnight + service.duracao_minutos > 19 * 60 + 30) throw new HttpError(400, 'Esse serviço ultrapassa o horário de fechamento.');
  const start = startUtc(date, time);
  if (!hasMinimumBookingNotice(start)) throw new HttpError(400, 'O agendamento precisa ser feito com pelo menos 10 minutos de antecedência.');
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
  if (!validPhone(phone) || !validEmail(email)) return { ok: false, phone };
  const ok = !!db.prepare('SELECT id FROM clientes WHERE cliente_telefone=? AND cliente_email=? COLLATE NOCASE').get(phone, email);
  return ok ? { ok: true, phone, email } : { ok: false, phone };
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
    ensureDate(date, { allowToday: true });
    if (!service) throw new HttpError(404, 'Serviço não encontrado.');
    const slots = [];
    for (let minutes = 9 * 60; minutes < 19 * 60 + 30; minutes += 30) {
      const time = `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
      if (minutes + service.duracao_minutos > 19 * 60 + 30) continue;
      const start = startUtc(date, time);
      if (!hasMinimumBookingNotice(start)) continue;
      if (!hasOverlap(date, time, service.duracao_minutos)) slots.push(time);
    }
    res.json({ data: date, service_id: service.id, slots });
  } catch (e) { next(e); }
});

app.post('/api/appointments', (req, res, next) => {
  try {
    const name = cleanText(req.body.nome, 80);
    const phone = normalizePhone(req.body.telefone);
    const whatsapp = req.body.whatsapp === true || req.body.whatsapp === "true" ? 1 : 0;
    const email = normalizeEmail(req.body.email);
    const service = getService(req.body.servico_id);
    const date = String(req.body.data || '');
    const time = String(req.body.hora || '');
    if (name.length < 2) throw new HttpError(400, 'Informe seu nome completo.');
    if (!validPhone(phone)) throw new HttpError(400, 'Informe um fixo ou celular com DDD, ou um número internacional começando com +.');
    if (!validEmail(email)) throw new HttpError(400, 'Informe um e-mail válido para cadastrar seu contato e receber os lembretes.');
    validateBookable({ date, time, service });
    const now = new Date().toISOString();
    let id;
    const create = db.transaction(() => {
      if (hasOverlap(date, time, service.duracao_minutos)) throw new HttpError(409, 'Esse horário acabou de ficar indisponível. Escolha outro horário.');
      registerCustomer({ name, phone, email, now });
      const result = db.prepare(`INSERT INTO agendamentos (cliente_nome,cliente_telefone,cliente_email,servico_id,data_agendamento,hora_agendamento,starts_at_utc,duracao_minutos,status,criado_em,atualizado_em,programado_em,telefone_whatsapp) VALUES (?,?,?,?,?,?,?,?, 'agendado',?,?,?,?)`).run(name, phone, email, service.id, date, time, startUtc(date, time).toISOString(), service.duracao_minutos, now, now, now, whatsapp);
      id = Number(result.lastInsertRowid);
    });
    create();
    res.status(201).json({ message: 'Agendamento realizado!', lembretes_email_ativos: SMTP_CONFIGURED, agendamento: { id, nome: name, telefone: formatPhone(phone), whatsapp: !!whatsapp, email, servico: service.nome, preco: service.preco_cents / 100, data: date, hora: time, status: 'agendado' } });
  } catch (e) { next(e); }
});

app.post('/api/authenticate', (req, res, next) => {
  try {
    const auth = validCustomerAuth(req.body.telefone, req.body.email);
    if (!auth.ok) throw new HttpError(401, 'Telefone e e-mail não conferem. Confira os dados e tente novamente.');
    const rows = db.prepare(`SELECT a.*,s.nome AS servico_nome,s.preco_cents FROM agendamentos a JOIN servicos s ON s.id=a.servico_id WHERE a.cliente_telefone=? AND lower(a.cliente_email)=? ORDER BY a.data_agendamento DESC,a.hora_agendamento DESC`).all(auth.phone, auth.email);
    res.json({ agendamentos: rows.map(publicAppointment) });
  } catch (e) { next(e); }
});

app.put('/api/appointments/:id', (req, res, next) => {
  try {
    const auth = validCustomerAuth(req.body.telefone, req.body.email);
    if (!auth.ok) throw new HttpError(401, 'Telefone e e-mail não conferem.');
    const old = getAppointment(req.params.id);
    if (!old || old.cliente_telefone !== auth.phone || normalizeEmail(old.cliente_email) !== auth.email) throw new HttpError(404, 'Agendamento não encontrado.');
    if (old.status === 'cancelado') throw new HttpError(400, 'Este agendamento já foi cancelado.');
    if (startUtc(old.data_agendamento, old.hora_agendamento).getTime() - Date.now() < 2 * 60 * 60_000) throw new HttpError(400, 'Não é possível editar faltando menos de 2 horas para o horário marcado.');
    const service = getService(req.body.servico_id);
    const date = String(req.body.data || ''); const time = String(req.body.hora || '');
    validateBookable({ date, time, service, ignoreId: old.id });
    const update = db.transaction(() => {
      if (hasOverlap(date, time, service.duracao_minutos, old.id)) throw new HttpError(409, 'Esse horário acabou de ficar indisponível. Escolha outro horário.');
      const scheduleUpdatedAt = new Date().toISOString();
      db.prepare(`UPDATE agendamentos SET servico_id=?,data_agendamento=?,hora_agendamento=?,starts_at_utc=?,duracao_minutos=?,atualizado_em=?,programado_em=?,lembrete_24h_enviado_em=NULL,lembrete_3h_enviado_em=NULL WHERE id=?`).run(service.id, date, time, startUtc(date, time).toISOString(), service.duracao_minutos, scheduleUpdatedAt, scheduleUpdatedAt, old.id);
    });
    update();
    res.json({ message: 'Agendamento atualizado.', agendamento: publicAppointment(getAppointment(old.id)) });
  } catch (e) { next(e); }
});

app.delete('/api/appointments/:id', (req, res, next) => {
  try {
    const auth = validCustomerAuth(req.body.telefone, req.body.email);
    if (!auth.ok) throw new HttpError(401, 'Telefone e e-mail não conferem.');
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
      if (!hasMinimumBookingNotice(startUtc(date, time))) continue;
      if (!hasOverlap(date, time, service.duracao_minutos)) slots.push(time);
    }
    res.json({ data: date, service_id: service.id, slots });
  } catch (e) { next(e); }
});
app.post('/admin/appointments', requireAdmin, (req, res, next) => {
  try {
    const name = cleanText(req.body.nome, 80);
    const phone = normalizePhone(req.body.telefone);
    const whatsapp = req.body.whatsapp === true || req.body.whatsapp === "true" ? 1 : 0;
    const email = normalizeEmail(req.body.email);
    const service = getService(req.body.servico_id);
    const date = String(req.body.data || '');
    const time = String(req.body.hora || '');
    if (name.length < 2) throw new HttpError(400, 'Informe o nome do cliente.');
    if (!validPhone(phone)) throw new HttpError(400, 'Informe um fixo ou celular com DDD, ou um número internacional começando com +.');
    if (!validEmail(email)) throw new HttpError(400, 'Informe um e-mail válido para que os lembretes possam ser enviados.');
    validateBookable({ date, time, service, isAdmin: true });
    const now = new Date().toISOString();
    let id;
    const create = db.transaction(() => {
      if (hasOverlap(date, time, service.duracao_minutos)) throw new HttpError(409, 'Esse horário acabou de ficar indisponível. Escolha outro horário.');
      registerCustomer({ name, phone, email, now });
      const result = db.prepare(`INSERT INTO agendamentos (cliente_nome,cliente_telefone,cliente_email,servico_id,data_agendamento,hora_agendamento,starts_at_utc,duracao_minutos,status,criado_em,atualizado_em,programado_em,telefone_whatsapp) VALUES (?,?,?,?,?,?,?,?, 'agendado',?,?,?,?)`).run(name, phone, email, service.id, date, time, startUtc(date, time).toISOString(), service.duracao_minutos, now, now, now, whatsapp);
      id = Number(result.lastInsertRowid);
    });
    create();
    res.status(201).json({ message: 'Agendamento criado pelo painel.', lembretes_email_ativos: SMTP_CONFIGURED, agendamento: { id, nome: name, telefone: formatPhone(phone), whatsapp: !!whatsapp, email, servico: service.nome, preco: service.preco_cents / 100, data: date, hora: time, status: 'agendado' } });
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
    db.prepare(`UPDATE agendamentos SET status='presente' WHERE id=?`).run(a.id);
    res.json({ message: 'Presença pré-confirmada.', agendamento: publicAppointment(getAppointment(a.id)) });
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
    const startTime = String(req.body.hora || '');
    const startMinutes = isValidTimeFormat(startTime) ? Number(startTime.slice(0,2))*60+Number(startTime.slice(3)) : -1;
    if (!isValidTimeFormat(startTime) || startMinutes < 9*60 || startMinutes >= 19*60+30) throw new HttpError(400, 'Escolha um horário de início entre 09h e 19h, de meia em meia hora.');
    const endTime = String(req.body.hora_fim || '');
    const endMinutes = endTime ? (isValidTimeFormat(endTime) ? Number(endTime.slice(0,2))*60+Number(endTime.slice(3)) : -1) : startMinutes + 30;
    if (endMinutes <= startMinutes || endMinutes > 19*60+30 || (endTime && !isValidTimeFormat(endTime))) throw new HttpError(400, 'O horário final deve ser posterior ao inicial e não ultrapassar 19h30.');
    const reason = cleanText(req.body.motivo, 140) || 'Horário bloqueado pelo barbeiro';
    const blockRange = db.transaction(() => {
      const rangeStart = startUtc(date, startTime).getTime();
      const endLabel = `${pad(Math.floor(endMinutes/60))}:${pad(endMinutes%60)}`;
      const rangeEnd = startUtc(date, endLabel).getTime();
      const appointments = db.prepare("SELECT hora_agendamento,duracao_minutos FROM agendamentos WHERE data_agendamento=? AND status!='cancelado'").all(date);
      for (const appointment of appointments) {
        const appointmentStart = startUtc(date, appointment.hora_agendamento).getTime();
        const appointmentEnd = appointmentStart + appointment.duracao_minutos * 60_000;
        if (rangeStart < appointmentEnd && rangeEnd > appointmentStart) throw new HttpError(409, 'Essa faixa coincide com um atendimento já agendado. Cancele ou reorganize o atendimento antes de bloquear.');
      }
      const insert = db.prepare(`INSERT INTO horarios_bloqueados (data,hora,motivo) VALUES (?,?,?) ON CONFLICT(data,hora) DO UPDATE SET motivo=excluded.motivo`);
      for (let minutes = startMinutes; minutes < endMinutes; minutes += 30) {
        insert.run(date, `${pad(Math.floor(minutes/60))}:${pad(minutes%60)}`, reason);
      }
    });
    blockRange();
    const count = (endMinutes - startMinutes) / 30;
    res.status(201).json({ message: count === 1 ? 'Horário bloqueado.' : `${count} horários bloqueados.` });
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
    const now = Date.now();
    const rows = db.prepare("SELECT a.*,s.nome AS servico_nome,s.preco_cents FROM agendamentos a JOIN servicos s ON s.id=a.servico_id WHERE a.status IN ('agendado','presente') AND a.cliente_email IS NOT NULL AND trim(a.cliente_email) != '' AND a.starts_at_utc > ? ORDER BY a.starts_at_utc").all(new Date(now).toISOString());
    for (const appointment of rows) {
      if (!appointment.lembrete_24h_enviado_em && shouldSendReminder(appointment, '24h', now)) {
        try {
          if (await sendReminderEmail(appointment, '24h')) db.prepare('UPDATE agendamentos SET lembrete_24h_enviado_em=? WHERE id=? AND lembrete_24h_enviado_em IS NULL').run(new Date().toISOString(), appointment.id);
        } catch (error) { console.error('[lembretes] Falha no lembrete de 24h do agendamento ' + appointment.id + ':', error.message); }
      }
      if (!appointment.lembrete_3h_enviado_em && shouldSendReminder(appointment, '3h', now)) {
        try {
          if (await sendReminderEmail(appointment, '3h')) db.prepare('UPDATE agendamentos SET lembrete_3h_enviado_em=? WHERE id=? AND lembrete_3h_enviado_em IS NULL').run(new Date().toISOString(), appointment.id);
        } catch (error) { console.error('[lembretes] Falha no lembrete de 3h do agendamento ' + appointment.id + ':', error.message); }
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
module.exports = { app, db, localToUtc, utcToLocal, durationSlots, validPhone, hasOverlap, ensureDate, validEmail, validCustomerAuth, hasMinimumBookingNotice, shouldSendReminder, dispatchDueReminders };
