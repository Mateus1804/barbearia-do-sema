const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'test-only-password';
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters';
const { durationSlots, validBrazilianPhone, localToUtc, utcToLocal, validEmail, validCustomerAuth, hasMinimumBookingNotice, shouldSendReminder, hasOverlap, db } = require('../server');

test('duração real é convertida em slots de 30 minutos com arredondamento para cima', () => {
  assert.equal(durationSlots(15), 1);
  assert.equal(durationSlots(20), 1);
  assert.equal(durationSlots(30), 1);
  assert.equal(durationSlots(45), 2);
  assert.equal(durationSlots(60), 2);
});

test('valida telefones brasileiros de 10 ou 11 dígitos e preserva o DDD 55', () => {
  assert.equal(validBrazilianPhone('31988887777'), true);
  assert.equal(validBrazilianPhone('3133334444'), true);
  assert.equal(validBrazilianPhone('55988887777'), true);
  assert.equal(validBrazilianPhone('1198888777'), false);
  assert.equal(validBrazilianPhone('abc'), false);
});

test('converte o horário de Brasília para UTC e vice-versa', () => {
  const iso = localToUtc('2026-10-12', '09:30').toISOString();
  assert.equal(iso, '2026-10-12T12:30:00.000Z');
  assert.deepEqual(utcToLocal(iso), { date: '2026-10-12', time: '09:30' });
});


test('valida e-mails para o cadastro do cliente', () => {
  assert.equal(validEmail('cliente@example.com'), true);
  assert.equal(validEmail('nao-e-email'), false);
  assert.equal(validEmail('cliente@'), false);
});

test('o banco não precisa mais de código de confirmação e guarda o estado dos lembretes', () => {
  const columns = db.prepare('PRAGMA table_info(agendamentos)').all().map(row => row.name);
  assert.equal(columns.includes('confirmation_code'), false);
  assert.equal(columns.includes('lembrete_24h_enviado_em'), true);
  assert.equal(columns.includes('lembrete_3h_enviado_em'), true);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='clientes'").get());
});

test('o agendamento aceita até 10 minutos de antecedência, mas não menos', () => {
  const now = Date.parse('2026-10-12T12:00:00.000Z');
  assert.equal(hasMinimumBookingNotice(new Date(now + 10 * 60_000), now), true);
  assert.equal(hasMinimumBookingNotice(new Date(now + 9 * 60_000 + 59_000), now), false);
  assert.equal(hasMinimumBookingNotice(new Date(now - 1), now), false);
});

test('o lembrete de 24 horas só é elegível se a última programação foi feita com pelo menos 24h', () => {
  const start = Date.parse('2026-10-12T12:00:00.000Z');
  const now = start - 24 * 60 * 60_000;
  const eligible = { starts_at_utc: new Date(start).toISOString(), programado_em: new Date(start - 30 * 60 * 60_000).toISOString() };
  const bookedTooLate = { starts_at_utc: new Date(start).toISOString(), programado_em: new Date(start - 23.5 * 60 * 60_000).toISOString() };
  assert.equal(shouldSendReminder(eligible, '24h', now), true);
  assert.equal(shouldSendReminder(bookedTooLate, '24h', now), false);
});

test('o lembrete de 3 horas não é enviado se a última programação ocorreu há menos de 3h do atendimento', () => {
  const start = Date.parse('2026-10-12T12:00:00.000Z');
  const now = start - 3 * 60 * 60_000;
  const eligible = { starts_at_utc: new Date(start).toISOString(), programado_em: new Date(start - 4 * 60 * 60_000).toISOString() };
  const bookedTooLate = { starts_at_utc: new Date(start).toISOString(), programado_em: new Date(start - 2.9 * 60 * 60_000).toISOString() };
  assert.equal(shouldSendReminder(eligible, '3h', now), true);
  assert.equal(shouldSendReminder(bookedTooLate, '3h', start - 2.9 * 60 * 60_000), false);
});

test('o cliente não fica bloqueado após várias combinações erradas de telefone e e-mail', () => {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO clientes (cliente_nome,cliente_telefone,cliente_email,criado_em,atualizado_em) VALUES (?,?,?,?,?)')
    .run('Cliente de teste', '31988887777', 'correto@example.com', now, now);
  for (let i = 0; i < 5; i++) assert.equal(validCustomerAuth('31988887777', 'incorreto@example.com').ok, false);
  assert.equal(validCustomerAuth('31988887777', 'correto@example.com').ok, true);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='login_attempts'").get(), undefined);
});

test('uma pré-confirmação ocupa o horário, mas cancelar libera a faixa novamente', () => {
  const date = '2026-10-13';
  const now = new Date().toISOString();
  const start = localToUtc(date, '10:00').toISOString();
  const inserted = db.prepare("INSERT INTO agendamentos (cliente_nome,cliente_telefone,cliente_email,servico_id,data_agendamento,hora_agendamento,starts_at_utc,duracao_minutos,status,criado_em,atualizado_em,programado_em) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
    'Cliente de teste', '31988887777', 'correto@example.com', 1, date, '10:00', start, 30, 'presente', now, now, now
  );
  try {
    assert.equal(hasOverlap(date, '10:00', 30), true);
    db.prepare("UPDATE agendamentos SET status='cancelado', motivo_cancelamento='Cancelado pelo cliente' WHERE id=?").run(inserted.lastInsertRowid);
    assert.equal(hasOverlap(date, '10:00', 30), false);
  } finally { db.prepare('DELETE FROM agendamentos WHERE id=?').run(inserted.lastInsertRowid); }
});

test('o esquema guarda a última programação separada do estado da presença', () => {
  const columns = db.prepare('PRAGMA table_info(agendamentos)').all().map(row => row.name);
  assert.ok(columns.includes('programado_em'));
});