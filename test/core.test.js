const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'test-only-password';
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters';
const { durationSlots, validBrazilianPhone, localToUtc, utcToLocal, validEmail, db } = require('../server');

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
