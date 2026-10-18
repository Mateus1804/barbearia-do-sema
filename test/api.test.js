const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'test-only-password';
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters';
const { app } = require('../server');

let server;
let base;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(resolve => server.close(resolve)));

async function request(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

// Data útil no fuso de Brasília, pulando domingos (a barbearia fecha aos domingos).
function bookableDate(daysAhead) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + daysAhead);
  while (date.getUTCDay() === 0) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

async function serviceByDuration(minutes) {
  const { body } = await request('GET', '/api/services');
  const service = body.find(item => Number(item.duracao_minutos) === minutes);
  assert.ok(service, `serviço de ${minutes} min deve existir`);
  return service;
}

function bookingPayload(overrides = {}) {
  return { nome: 'Cliente Teste', telefone: '(31) 99999-8888', email: 'cliente@example.com', hora: '10:00', data: bookableDate(2), ...overrides };
}

test('lista os serviços com id e duração', async () => {
  const { status, body } = await request('GET', '/api/services');
  assert.equal(status, 200);
  assert.equal(body.length, 5);
  assert.ok(body.every(item => Number.isInteger(Number(item.id)) && Number(item.duracao_minutos) > 0));
});

test('horários disponíveis não incluem o almoço nem o fim do expediente', async () => {
  const corte = await serviceByDuration(30);
  const { status, body } = await request('GET', `/api/available-slots/${bookableDate(4)}/${corte.id}`);
  assert.equal(status, 200);
  assert.ok(body.slots.includes('09:00'));
  assert.ok(body.slots.includes('19:00'));
  assert.ok(!body.slots.includes('12:00'), 'almoço às 12h bloqueado');
  assert.ok(!body.slots.includes('12:30'), 'almoço às 12h30 bloqueado');
  assert.ok(!body.slots.includes('19:30'), 'após o fechamento');
});

test('telefone: recusa celular sem o 9 e DDD inexistente; aceita fixo e celular com DDD + 9 + 8 dígitos', async () => {
  const corte = await serviceByDuration(30);
  const data = bookableDate(5);
  const semNove = await request('POST', '/api/appointments', bookingPayload({ telefone: '(31) 88887-7777', servico_id: corte.id, data, hora: '09:00' }));
  assert.equal(semNove.status, 400, 'celular de 11 dígitos precisa do 9 depois do DDD');
  assert.match(semNove.body.error, /celular/i);

  const dddInexistente = await request('POST', '/api/appointments', bookingPayload({ telefone: '(30) 99999-8888', servico_id: corte.id, data, hora: '09:00' }));
  assert.equal(dddInexistente.status, 400);

  const fixo = await request('POST', '/api/appointments', bookingPayload({ telefone: '(31) 3333-4444', servico_id: corte.id, data, hora: '09:00', email: 'fixo@example.com' }));
  assert.equal(fixo.status, 201, 'telefone fixo é aceito');
  assert.equal(fixo.body.agendamento.telefone, '(31) 3333-4444');

  const celular = await request('POST', '/api/appointments', bookingPayload({ telefone: '31 98888-7777', servico_id: corte.id, data, hora: '09:30', email: 'celular@example.com' }));
  assert.equal(celular.status, 201, 'celular com DDD + 9 + 8 dígitos é aceito');
  assert.equal(celular.body.agendamento.telefone, '(31) 98888-7777');
});

test('recusa agendamento em domingo', async () => {
  const corte = await serviceByDuration(30);
  // bookableDate pula domingos, então procuramos explicitamente o próximo domingo.
  const candidate = new Date(`${bookableDate(1)}T12:00:00Z`);
  while (candidate.getUTCDay() !== 0) candidate.setUTCDate(candidate.getUTCDate() + 1);
  const sunday = candidate.toISOString().slice(0, 10);
  const { status, body } = await request('POST', '/api/appointments', bookingPayload({ servico_id: corte.id, data: sunday }));
  assert.equal(status, 400);
  assert.match(body.error, /domingo/i);
});

test('cria um agendamento válido e impede o mesmo horário para outro cliente', async () => {
  const corte = await serviceByDuration(30);
  const date = bookableDate(6);
  const first = await request('POST', '/api/appointments', bookingPayload({ servico_id: corte.id, data: date, hora: '10:00' }));
  assert.equal(first.status, 201);
  assert.equal(first.body.agendamento.hora, '10:00');

  const second = await request('POST', '/api/appointments', bookingPayload({ servico_id: corte.id, data: date, hora: '10:00', email: 'outro@example.com', telefone: '(31) 98888-7777' }));
  assert.equal(second.status, 409);
});

test('serviço de 45 min ocupa 2 slots e não pode começar às 11h30 por causa do almoço', async () => {
  const combo = await serviceByDuration(45);
  const { status, body } = await request('POST', '/api/appointments', bookingPayload({ servico_id: combo.id, data: bookableDate(7), hora: '11:30' }));
  assert.equal(status, 409);
  assert.match(body.error, /horário/i);
});

test('rotas de administrador exigem sessão', async () => {
  const { status } = await request('GET', '/admin/appointments?de=2026-10-01&ate=2026-10-02');
  assert.equal(status, 401);
});
