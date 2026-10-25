'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApplication } = require('../src/app');
const { readConfig } = require('../src/config');
const { utcToLocal } = require('../src/calendar');
const { shouldSendReminder, createReminderService } = require('../src/reminders');
const HOUR_MS = 60 * 60_000;
const NOW = Date.parse('2026-10-21T12:00:00.000Z');

function setup(context, sendMail) {
  const messages = [];
  let now = NOW;
  const config = readConfig({
    DB_PATH: ':memory:',
    ADMIN_PASSWORD: 'test-only-password',
    EMAIL_FROM: 'barbearia@example.com'
  });
  const mailer = {
    sendMail: async (message) => {
      messages.push(message);
      await sendMail?.(message);
    }
  };
  const runtime = createApplication({ config, mailer, clock: () => now });
  context.after(() => runtime.db.close());
  return {
    ...runtime,
    messages,
    advance: (milliseconds) => {
      now += milliseconds;
    }
  };
}

function insert(db, { hours = 3, leadHours = 30, status = 'agendado', name = 'Cliente', ...overrides } = {}) {
  const startsAt = new Date(NOW + hours * HOUR_MS).toISOString();
  const programmedAt = new Date(Date.parse(startsAt) - leadHours * HOUR_MS).toISOString();
  const { date, time } = utcToLocal(startsAt);
  const result = db
    .prepare(
      `INSERT INTO agendamentos (cliente_nome,cliente_telefone,cliente_email,servico_id,
    data_agendamento,hora_agendamento,starts_at_utc,duracao_minutos,status,criado_em,atualizado_em,programado_em)
    VALUES (?,?,?,1,?,?,?,30,?,?,?,?)`
    )
    .run(
      name,
      '31988887777',
      overrides.email || 'cliente@example.com',
      date,
      time,
      startsAt,
      status,
      programmedAt,
      programmedAt,
      programmedAt
    );
  return Number(result.lastInsertRowid);
}

test('lembretes de 24h e 3h são enviados uma vez e escapam o HTML do contato', async (context) => {
  const { db, messages, dispatchDueReminders } = setup(context);
  const dayBefore = insert(db, { hours: 24, name: '<img src=x onerror=alert(1)>' });
  const sameDay = insert(db);
  await Promise.all([dispatchDueReminders(), dispatchDueReminders()]);
  await dispatchDueReminders();
  assert.equal(messages.length, 2);
  assert.ok(
    db.prepare('SELECT lembrete_24h_enviado_em FROM agendamentos WHERE id=?').get(dayBefore)
      .lembrete_24h_enviado_em
  );
  assert.ok(
    db.prepare('SELECT lembrete_3h_enviado_em FROM agendamentos WHERE id=?').get(sameDay)
      .lembrete_3h_enviado_em
  );
  const message = messages.find((item) => item.subject.includes('está chegando'));
  assert.doesNotMatch(message.html, /<img/);
  assert.match(message.html, /&lt;img/);
  assert.match(message.text, /até 2 horas antes/);
});

test('cancelados, reservas tardias e lembretes fora da janela não são enviados', async (context) => {
  const { db, messages, dispatchDueReminders } = setup(context);
  insert(db, { status: 'cancelado' });
  insert(db, { leadHours: 2 });
  insert(db, { hours: 2.75 });
  insert(db, { hours: 24, leadHours: 23 });
  await dispatchDueReminders();
  assert.equal(messages.length, 0);
});

test('a janela inclui o instante previsto e exclui o limite de 15 minutos', () => {
  const appointment = {
    starts_at_utc: new Date(NOW + 3 * HOUR_MS).toISOString(),
    programado_em: new Date(NOW - HOUR_MS).toISOString()
  };
  assert.equal(shouldSendReminder(appointment, '3h', NOW), true);
  assert.equal(shouldSendReminder(appointment, '3h', NOW + 15 * 60_000 - 1), true);
  assert.equal(shouldSendReminder(appointment, '3h', NOW + 15 * 60_000), false);
  assert.equal(shouldSendReminder(appointment, '3h', NOW - 1), false);
});

test('uma falha do transporte mantém o lembrete pendente para a próxima tentativa', async (context) => {
  let calls = 0;
  const runtime = setup(context, () => {
    if (++calls === 1) throw new Error('SMTP simulado indisponível');
  });
  const { db, messages, dispatchDueReminders } = runtime;
  const logs = [];
  context.mock.method(console, 'error', (...args) => logs.push(args));
  const id = insert(db);
  await dispatchDueReminders();
  assert.equal(
    db.prepare('SELECT lembrete_3h_enviado_em FROM agendamentos WHERE id=?').get(id).lembrete_3h_enviado_em,
    null
  );
  await dispatchDueReminders();
  assert.equal(messages.length, 1, 'o recuo impede repetição imediata');
  runtime.advance(60000);
  await dispatchDueReminders();
  assert.equal(messages.length, 2);
  assert.equal(messages[0].messageId, messages[1].messageId);
  assert.equal(logs.length, 1);
  assert.ok(
    db.prepare('SELECT lembrete_3h_enviado_em FROM agendamentos WHERE id=?').get(id).lembrete_3h_enviado_em
  );
});

test('um agendamento cancelado durante o envio anterior é revalidado antes do próximo e-mail', async (context) => {
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  let notify;
  const started = new Promise((resolve) => {
    notify = resolve;
  });
  let count = 0;
  const { db, messages, dispatchDueReminders } = setup(context, async () => {
    if (++count === 1) {
      notify();
      await waiting;
    }
  });
  insert(db);
  const cancelled = insert(db);
  const dispatch = dispatchDueReminders();
  await started;
  db.prepare("UPDATE agendamentos SET status='cancelado' WHERE id=?").run(cancelled);
  release();
  await dispatch;
  assert.equal(messages.length, 1);
});

test('remarcar durante o envio não marca o lembrete da nova programação como enviado', async (context) => {
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  let notify;
  const started = new Promise((resolve) => {
    notify = resolve;
  });
  const { db, dispatchDueReminders } = setup(context, async () => {
    notify();
    await waiting;
  });
  const id = insert(db);
  const dispatch = dispatchDueReminders();
  await started;
  db.prepare('UPDATE agendamentos SET starts_at_utc=?,programado_em=? WHERE id=?').run(
    new Date(NOW + 27 * HOUR_MS).toISOString(),
    new Date(NOW).toISOString(),
    id
  );
  release();
  await dispatch;
  assert.equal(
    db.prepare('SELECT lembrete_3h_enviado_em FROM agendamentos WHERE id=?').get(id).lembrete_3h_enviado_em,
    null
  );
});

test('o relógio é reavaliado após um envio lento para respeitar a janela dos próximos lembretes', async (context) => {
  let count = 0;
  const runtime = setup(context, () => {
    if (++count === 1) runtime.advance(16 * 60_000);
  });
  insert(runtime.db);
  insert(runtime.db);
  await runtime.dispatchDueReminders();
  assert.equal(runtime.messages.length, 1);
});

test('dois serviços compartilham a reserva do envio no SQLite', async context => {
  let release;
  let started;
  const waiting = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { started = resolve; });
  const runtime = setup(context, async () => { started(); await waiting; });
  insert(runtime.db);
  const other = createReminderService({ db: runtime.db, config: runtime.config, mailer: { sendMail: () => { throw new Error('Envio duplicado'); } }, clock: () => NOW });
  const first = runtime.dispatchDueReminders();
  await began;
  await other.dispatchDueReminders();
  release();
  await first;
  assert.equal(runtime.messages.length, 1);
  assert.equal(runtime.db.prepare('SELECT status,attempts FROM reminder_deliveries').get().status, 'SENT');
});

test('a reserva vencida pode ser recuperada e uma concluída não é reenviada', async context => {
  const runtime = setup(context);
  const id = insert(runtime.db);
  const appointment = runtime.db.prepare('SELECT * FROM agendamentos WHERE id=?').get(id);
  runtime.db.prepare("INSERT INTO reminder_deliveries(appointment_id,kind,scheduled_at,starts_at_utc,status,attempts,owner,lease_until) VALUES (?,'3h',?,?,'SENDING',1,'processo-encerrado',?)")
    .run(id, appointment.programado_em, appointment.starts_at_utc, new Date(NOW - 1).toISOString());
  await runtime.dispatchDueReminders();
  await runtime.dispatchDueReminders();
  assert.equal(runtime.messages.length, 1);
  assert.equal(runtime.db.prepare('SELECT attempts FROM reminder_deliveries').get().attempts, 2);
});

test('a pausa operacional impede envios até a retomada explícita', async context => {
  const runtime = setup(context);
  insert(runtime.db);
  runtime.db.prepare("UPDATE operational_flags SET value='1' WHERE key='reminders_paused'").run();
  await runtime.dispatchDueReminders();
  assert.equal(runtime.messages.length, 0);
  runtime.db.prepare("UPDATE operational_flags SET value='0' WHERE key='reminders_paused'").run();
  await runtime.dispatchDueReminders();
  assert.equal(runtime.messages.length, 1);
});

test('o limite de tentativas e a janela de elegibilidade são preservados', async context => {
  const runtime = setup(context, () => { throw new Error('Falha fictícia'); });
  context.mock.method(console, 'error', () => {});
  insert(runtime.db);
  for (const delay of [0, 60000, 120000, 240000, 300000, 60000]) {
    runtime.advance(delay);
    await runtime.dispatchDueReminders();
  }
  assert.equal(runtime.messages.length, 5);
  const row = runtime.db.prepare('SELECT * FROM reminder_deliveries').get();
  assert.equal(row.status, 'EXPIRED');
  assert.equal(row.attempts, 5);
  assert.equal(row.error_code, 'SMTP_ERROR');
});

test('a reserva também impede duplicidade entre conexões distintas ao mesmo arquivo', async context => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const folder = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'sema-workers-'));
  const config = readConfig({ DB_PATH: path.join(folder, 'agenda.sqlite'), ADMIN_PASSWORD: 'Senha ficticia para teste' });
  const { createDatabase } = require('../src/database');
  const firstDb = createDatabase(config);
  const secondDb = new (require('better-sqlite3'))(config.DB_PATH);
  context.after(async () => { firstDb.close(); secondDb.close(); await fs.rm(folder, { recursive: true, force: true }); });
  let release;
  let notify;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { notify = resolve; });
  let sends = 0;
  const first = createReminderService({ db: firstDb, config, clock: () => NOW, mailer: { sendMail: async () => { sends += 1; notify(); await waiting; } } });
  const second = createReminderService({ db: secondDb, config, clock: () => NOW, mailer: { sendMail: async () => { sends += 1; } } });
  insert(firstDb);
  const ongoing = first.dispatchDueReminders();
  await started;
  await second.dispatchDueReminders();
  release();
  await ongoing;
  assert.equal(sends, 1);
});
