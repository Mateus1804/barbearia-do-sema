'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('armazenamento negado permite sessão em memória e encerramento local', async () => {
  const { createAdminSession } = await import('../public/js/session.mjs');
  const session = createAdminSession(() => { throw new Error('Storage indisponível'); });
  assert.equal(session.read(), '');
  assert.equal(session.write('token-ficticio'), false);
  assert.equal(session.read(), 'token-ficticio');
  assert.equal(session.clear(), false);
  assert.equal(session.read(), '');
});

test('gravação ou remoção negada não ressuscita a sessão na página atual', async () => {
  const { createAdminSession } = await import('../public/js/session.mjs');
  const session = createAdminSession(() => ({
    getItem: () => 'token-anterior',
    setItem: () => { throw new Error('Sem espaço'); },
    removeItem: () => { throw new Error('Acesso revogado'); }
  }));
  assert.equal(session.read(), 'token-anterior');
  assert.equal(session.write('token-novo'), false);
  assert.equal(session.read(), 'token-novo');
  session.clear();
  assert.equal(session.read(), '');
});

test('armazenamento disponível conserva a sessão entre instâncias', async () => {
  const { createAdminSession } = await import('../public/js/session.mjs');
  const entries = new Map();
  const storage = { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
  const first = createAdminSession(() => storage);
  assert.equal(first.write('token-ficticio'), true);
  const next = createAdminSession(() => storage);
  assert.equal(next.read(), 'token-ficticio');
  assert.equal(next.clear(), true);
  assert.equal(createAdminSession(() => storage).read(), '');
});
