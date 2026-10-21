'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { readConfig } = require('../src/config');
const { createApplication } = require('../src/app');

const JWT_SECRET = 'test-only-secret-with-more-than-32-characters';
const config = readConfig({ DB_PATH: ':memory:', ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-only-password', JWT_SECRET });
const { app, db } = createApplication({ config, mailer: null });
let server;
let base;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });

test('produção exige credenciais próprias antes de criar o banco', () => {
  assert.throws(() => readConfig({ NODE_ENV: 'production' }), /Em produção/);
  assert.throws(() => readConfig({ NODE_ENV: 'production', ADMIN_PASSWORD: '123', JWT_SECRET }), /Em produção/);
  const production = readConfig({ NODE_ENV: 'production', ADMIN_PASSWORD: 'Cenario-de-teste-!47', JWT_SECRET });
  assert.equal(production.ADMIN_PASSWORD, 'Cenario-de-teste-!47');
});

test('a política de conteúdo permite os recursos do site e bloqueia scripts externos', async () => {
  const response = await fetch(base);
  const csp = response.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /script-src-attr 'none';/);
  assert.match(csp, /https:\/\/fonts.googleapis.com/);
  assert.match(csp, /https:\/\/fonts.gstatic.com/);
  assert.match(csp, /https:\/\/images.unsplash.com/);
  assert.doesNotMatch(csp, /script-src [^;]*unsafe/);
});

test('rotas desconhecidas da API e do painel respondem em JSON sem conteúdo da página', async () => {
  for (const path of ['/api/inexistente', '/admin/inexistente']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await response.json(), { error: 'Rota não encontrada.' });
  }
});

test('JSON inválido e conteúdo excessivo têm mensagens controladas sem ecoar dados enviados', async () => {
  const malformed = await fetch(`${base}/api/authenticate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email":"contato-privado@example.com"' });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'Envie um JSON válido.' });
  const oversized = await fetch(`${base}/api/appointments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nome: 'x'.repeat(41 * 1024) }) });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: 'O conteúdo enviado excede o limite de 40 KB.' });
});

test('tokens expirados, com outra função ou outro algoritmo não autorizam o painel', async () => {
  const tokens = [
    jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: -1 }),
    jwt.sign({ role: 'cliente' }, JWT_SECRET),
    jwt.sign({ role: 'admin' }, JWT_SECRET, { algorithm: 'HS512' }),
    jwt.sign({ role: 'admin' }, 'another-secret')
  ];
  for (const token of tokens) {
    const response = await fetch(`${base}/admin/appointments`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('o token emitido pelo login funciona e dados administrativos não ficam em cache', async () => {
  const login = await fetch(`${base}/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: config.ADMIN_EMAIL, senha: config.ADMIN_PASSWORD }) });
  assert.equal(login.status, 200);
  assert.equal(login.headers.get('cache-control'), 'no-store');
  const { token } = await login.json();
  assert.equal(jwt.decode(token, { complete: true }).header.alg, 'HS256');
  const agenda = await fetch(`${base}/admin/appointments`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(agenda.status, 200);
  assert.equal(agenda.headers.get('cache-control'), 'no-store');
});

test('duas reservas concorrentes para o mesmo horário criam somente um atendimento e um cadastro', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 2);
  while (date.getUTCDay() === 0) date.setUTCDate(date.getUTCDate() + 1);
  const payload = { nome: 'Cliente concorrente', telefone: '31988887777', servico_id: 1, data: date.toISOString().slice(0, 10), hora: '09:00' };
  const responses = await Promise.all(['um@example.com', 'dois@example.com'].map(email => fetch(`${base}/api/appointments`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, email })
  })));
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  assert.equal(db.prepare('SELECT count(*) AS count FROM agendamentos').get().count, 1);
  assert.equal(db.prepare('SELECT count(*) AS count FROM clientes').get().count, 1);
});
