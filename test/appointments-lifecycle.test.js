// Regras de negócio de ponta a ponta pela API: ciclo de vida do agendamento, regra das 2 horas,
// bloqueios, dias fechados, login do administrador e validações de entrada.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
process.env.ADMIN_EMAIL = 'admin@example.com';
process.env.ADMIN_PASSWORD = 'test-only-password';
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters';
const { app, db, utcToLocal } = require('../server');

let server;
let base;
let adminToken;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await request('POST', '/admin/login', { email: 'admin@example.com', senha: 'test-only-password' });
  adminToken = login.body.token;
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  // A API limita 120 requisições por minuto por IP. Se a suíte crescer além disso, divida-a em arquivos
  // em vez de deixar testes falharem com 429 de forma intermitente.
  assert.ok(publicApiCalls < 110, `a suíte fez ${publicApiCalls} chamadas a /api/ (limite do servidor: 120 por minuto)`);
});

let publicApiCalls = 0;
async function request(method, path, body, token) {
  if (path.startsWith('/api/')) publicApiCalls += 1;
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
const admin = (method, path, body) => request(method, path, body, adminToken);

function todayInBrazil() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}
// n-ésimo dia de atendimento (segunda a sábado) a partir de amanhã. Cada teste usa o seu para não colidir.
function openDay(n) {
  const date = new Date(`${todayInBrazil()}T12:00:00Z`);
  let found = 0;
  while (found < n) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (date.getUTCDay() !== 0) found += 1;
  }
  return date.toISOString().slice(0, 10);
}
function shiftDays(days) {
  const date = new Date(`${todayInBrazil()}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

let services;
async function service(minutes) {
  if (!services) services = (await request('GET', '/api/services')).body;
  const found = services.find(item => Number(item.duracao_minutos) === minutes);
  assert.ok(found, `serviço de ${minutes} min deve existir`);
  return found;
}

function customer(n) {
  return { nome: `Cliente ${n}`, telefone: `(31) 9${String(7000 + n).padStart(4, '0')}-${String(1000 + n)}`, email: `cliente${n}@example.com` };
}
const auth = person => ({ telefone: person.telefone, email: person.email });

async function book(person, { data, hora, minutes = 30, ...extra }) {
  const item = await service(minutes);
  return request('POST', '/api/appointments', { ...person, servico_id: item.id, data, hora, ...extra });
}
async function slots(data, minutes = 30) {
  const item = await service(minutes);
  return request('GET', `/api/available-slots/${data}/${item.id}`);
}

test('a API responde ao health check no fuso de Brasília', async () => {
  const { status, body } = await request('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(body.timezone, 'America/Sao_Paulo');
});

test('o cliente consulta os próprios agendamentos só com telefone e e-mail corretos', async () => {
  const ana = customer(1);
  const created = await book(ana, { data: openDay(1), hora: '09:00' });
  assert.equal(created.status, 201);

  const ok = await request('POST', '/api/authenticate', auth(ana));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.agendamentos.length, 1);
  assert.equal(ok.body.agendamentos[0].hora, '09:00');

  const emailErrado = await request('POST', '/api/authenticate', { ...auth(ana), email: 'outra@example.com' });
  assert.equal(emailErrado.status, 401);
  const celularSemNove = await request('POST', '/api/authenticate', { ...auth(ana), telefone: '(31) 88887-1001' });
  assert.equal(celularSemNove.status, 401);
  const semDados = await request('POST', '/api/authenticate', {});
  assert.equal(semDados.status, 401);
});

test('o e-mail do cadastro não diferencia maiúsculas de minúsculas', async () => {
  const bia = customer(2);
  await book(bia, { data: openDay(1), hora: '09:30' });
  const { status, body } = await request('POST', '/api/authenticate', { ...auth(bia), email: bia.email.toUpperCase() });
  assert.equal(status, 200);
  assert.equal(body.agendamentos.length, 1);
});

test('o cliente remarca para um horário livre, não para um ocupado, e não mexe no agendamento dos outros', async () => {
  const caio = customer(3);
  const dani = customer(4);
  const data = openDay(2);
  const mine = await book(caio, { data, hora: '10:00' });
  const other = await book(dani, { data, hora: '11:00' });
  assert.equal(mine.status, 201);
  assert.equal(other.status, 201);
  const corte = await service(30);

  const moved = await request('PUT', `/api/appointments/${mine.body.agendamento.id}`, { ...auth(caio), servico_id: corte.id, data, hora: '10:30' });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.agendamento.hora, '10:30');

  const busy = await request('PUT', `/api/appointments/${mine.body.agendamento.id}`, { ...auth(caio), servico_id: corte.id, data, hora: '11:00' });
  assert.equal(busy.status, 409, 'horário da Dani está ocupado');

  const intruder = await request('PUT', `/api/appointments/${mine.body.agendamento.id}`, { ...auth(dani), servico_id: corte.id, data, hora: '14:00' });
  assert.equal(intruder.status, 404, 'outro cliente não enxerga este agendamento');

  const wrongPassword = await request('PUT', `/api/appointments/${mine.body.agendamento.id}`, { telefone: caio.telefone, email: 'errado@example.com', servico_id: corte.id, data, hora: '14:00' });
  assert.equal(wrongPassword.status, 401);
});

test('cancelar libera o horário para outro cliente e cancelar duas vezes é recusado', async () => {
  const eva = customer(5);
  const fabio = customer(6);
  const data = openDay(3);
  const created = await book(eva, { data, hora: '14:00' });
  const id = created.body.agendamento.id;

  const intruder = await request('DELETE', `/api/appointments/${id}`, auth(fabio));
  assert.equal(intruder.status, 401, 'Fábio ainda não é cliente: telefone e e-mail não conferem');

  assert.equal((await book(fabio, { data, hora: '14:00' })).status, 409, 'horário ocupado até o cancelamento');

  const cancelled = await request('DELETE', `/api/appointments/${id}`, auth(eva));
  assert.equal(cancelled.status, 200);
  assert.equal((await request('DELETE', `/api/appointments/${id}`, auth(eva))).status, 400, 'já cancelado');

  const rebooked = await book(fabio, { data, hora: '14:00' });
  assert.equal(rebooked.status, 201, 'horário liberado após o cancelamento');

  const mineAfter = await request('POST', '/api/authenticate', auth(eva));
  assert.equal(mineAfter.body.agendamentos[0].status, 'cancelado');
  assert.equal(mineAfter.body.agendamentos[0].motivo_cancelamento, 'Cancelado pelo cliente');
});

test('regra das 2 horas: o cliente não edita nem cancela faltando menos de 2h, mas pode com folga', async () => {
  const gabi = customer(7);
  const now = new Date().toISOString();
  db.prepare('INSERT OR IGNORE INTO clientes (cliente_nome,cliente_telefone,cliente_email,criado_em,atualizado_em) VALUES (?,?,?,?,?)')
    .run(gabi.nome, '31970071007', gabi.email, now, now);
  const insertIn = minutes => {
    const { date, time } = utcToLocal(new Date(Date.now() + minutes * 60_000).toISOString());
    const startsAt = new Date(Date.now() + minutes * 60_000).toISOString();
    return Number(db.prepare("INSERT INTO agendamentos (cliente_nome,cliente_telefone,cliente_email,servico_id,data_agendamento,hora_agendamento,starts_at_utc,duracao_minutos,status,criado_em,atualizado_em,programado_em) VALUES (?,?,?,?,?,?,?,?,'agendado',?,?,?)")
      .run(gabi.nome, '31970071007', gabi.email, 1, date, time, startsAt, 30, now, now, now).lastInsertRowid);
  };
  const tooClose = insertIn(90);
  const comfortable = insertIn(130);

  const edit = await request('PUT', `/api/appointments/${tooClose}`, { ...auth(gabi), servico_id: 1, data: openDay(1), hora: '16:00' });
  assert.equal(edit.status, 400);
  assert.match(edit.body.error, /2 horas/);
  const cancel = await request('DELETE', `/api/appointments/${tooClose}`, auth(gabi));
  assert.equal(cancel.status, 400);
  assert.match(cancel.body.error, /2 horas/);

  assert.equal((await request('DELETE', `/api/appointments/${comfortable}`, auth(gabi))).status, 200);
});

test('o serviço de 45 min ocupa 2 slots e o de 20 min ocupa 1 (arredonda a duração para cima)', async () => {
  const data = openDay(4);
  const combo = await book(customer(8), { data, hora: '09:00', minutes: 45 });
  assert.equal(combo.status, 201);
  const afterCombo = (await slots(data)).body.slots;
  assert.ok(!afterCombo.includes('09:00') && !afterCombo.includes('09:30'), 'combo ocupa 09:00 e 09:30');
  assert.ok(afterCombo.includes('10:00'));

  const barba = await book(customer(9), { data, hora: '10:00', minutes: 20 });
  assert.equal(barba.status, 201);
  const afterBarba = (await slots(data)).body.slots;
  assert.ok(!afterBarba.includes('10:00'), 'barba ocupa 10:00');
  assert.ok(afterBarba.includes('10:30'), 'barba de 20 min libera 10:30');
});

test('almoço (12h-13h) e fim do expediente: pintura de 60 min não começa às 19h nem às 11h30', async () => {
  const data = openDay(5);
  const naNoite = await book(customer(10), { data, hora: '19:00', minutes: 60 });
  assert.equal(naNoite.status, 400);
  assert.match(naNoite.body.error, /fechamento/i);
  const noAlmoco = await book(customer(10), { data, hora: '11:30', minutes: 60 });
  assert.equal(noAlmoco.status, 409);
  assert.equal((await book(customer(10), { data, hora: '13:00', minutes: 60 })).status, 201, 'logo depois do almoço pode');
});

test('bloquear uma faixa tira os horários da agenda e impede agendar; remover o bloqueio libera', async () => {
  const data = openDay(6);
  const block = await admin('POST', '/admin/block-slots', { data, hora: '15:00', hora_fim: '16:00', motivo: 'Compromisso' });
  assert.equal(block.status, 201);
  assert.match(block.body.message, /2 horários/);

  const during = (await slots(data)).body.slots;
  assert.ok(!during.includes('15:00') && !during.includes('15:30'));
  assert.ok(during.includes('14:30') && during.includes('16:00'));
  assert.equal((await book(customer(11), { data, hora: '15:00' })).status, 409);
  assert.equal((await book(customer(11), { data, hora: '14:30', minutes: 45 })).status, 409, '45 min às 14:30 invadem o bloqueio das 15:00');

  const listed = await admin('GET', `/admin/appointments?de=${data}&ate=${data}`);
  assert.equal(listed.body.bloqueios.length, 2);
  for (const item of listed.body.bloqueios) assert.equal((await admin('DELETE', `/admin/block-slots/${item.id}`)).status, 200);
  assert.equal((await admin('DELETE', '/admin/block-slots/999999')).status, 404);
  assert.ok((await slots(data)).body.slots.includes('15:00'), 'horário voltou');
});

test('não é possível bloquear sobre um atendimento marcado nem com faixa inválida', async () => {
  const data = openDay(7);
  assert.equal((await book(customer(12), { data, hora: '17:00' })).status, 201);
  const overlap = await admin('POST', '/admin/block-slots', { data, hora: '17:00', hora_fim: '18:00' });
  assert.equal(overlap.status, 409);
  assert.match(overlap.body.error, /atendimento/i);
  assert.equal((await admin('POST', '/admin/block-slots', { data, hora: '16:00', hora_fim: '15:30' })).status, 400, 'fim antes do início');
  assert.equal((await admin('POST', '/admin/block-slots', { data, hora: '08:00', hora_fim: '09:00' })).status, 400, 'antes da abertura');
  assert.equal((await admin('POST', '/admin/block-slots', { data, hora: '19:00', hora_fim: '20:00' })).status, 400, 'depois do fechamento');
  assert.equal((await admin('POST', '/admin/block-slots', { data: '2026-02-30', hora: '10:00' })).status, 400, 'data inexistente');
});

test('dia fechado pelo administrador some da agenda e não aceita agendamento até ser reaberto', async () => {
  const data = openDay(8);
  const closed = await admin('POST', '/admin/holidays', { data, motivo: 'Dia de teste' });
  assert.equal(closed.status, 201);

  const publicSlots = await slots(data);
  assert.equal(publicSlots.status, 400);
  assert.match(publicSlots.body.error, /não atende/i);
  assert.equal((await book(customer(13), { data, hora: '10:00' })).status, 400);

  const listed = await admin('GET', `/admin/appointments?de=${data}&ate=${data}`);
  assert.equal(listed.body.feriados.length, 1);
  assert.equal((await admin('DELETE', `/admin/holidays/${listed.body.feriados[0].id}`)).status, 200);
  assert.equal((await admin('DELETE', '/admin/holidays/999999')).status, 404);

  assert.equal((await slots(data)).status, 200, 'reaberto');
  assert.equal((await book(customer(13), { data, hora: '10:00' })).status, 201);
});

test('datas inválidas: passado, domingo, mais de 30 dias e dia que não existe', async () => {
  const corte = await service(30);
  const get = date => request('GET', `/api/available-slots/${date}/${corte.id}`);

  const past = await get(shiftDays(-1));
  assert.equal(past.status, 400);
  assert.match(past.body.error, /futura/i);

  const sunday = new Date(`${todayInBrazil()}T12:00:00Z`);
  while (sunday.getUTCDay() !== 0 || sunday.toISOString().slice(0, 10) === todayInBrazil()) sunday.setUTCDate(sunday.getUTCDate() + 1);
  const closedSunday = await get(sunday.toISOString().slice(0, 10));
  assert.equal(closedSunday.status, 400);
  assert.match(closedSunday.body.error, /domingo/i);

  const tooFar = await get(shiftDays(31));
  assert.equal(tooFar.status, 400);
  assert.match(tooFar.body.error, /30 dias/);

  assert.equal((await get('2026-02-30')).status, 400);
  assert.equal((await get('amanhã')).status, 400);
  assert.equal((await request('GET', `/api/available-slots/${openDay(1)}/9999`)).status, 404, 'serviço inexistente');
});

test('o agendamento recusa dados incompletos: nome, e-mail, serviço e horários fora da grade', async () => {
  const data = openDay(9);
  const person = customer(14);
  const corte = await service(30);
  const attempt = overrides => request('POST', '/api/appointments', { ...person, servico_id: corte.id, data, hora: '10:00', ...overrides });

  assert.equal((await attempt({ nome: 'A' })).status, 400, 'nome com uma letra');
  assert.equal((await attempt({ email: 'sem-arroba' })).status, 400, 'e-mail inválido');
  assert.equal((await attempt({ servico_id: 9999 })).status, 400, 'serviço inexistente');
  assert.equal((await attempt({ hora: '10:15' })).status, 400, 'fora da grade de 30 minutos');
  assert.equal((await attempt({ hora: '08:30' })).status, 400, 'antes da abertura');
  assert.equal((await attempt({ hora: '19:30' })).status, 400, 'no fechamento');
  assert.equal((await attempt({ hora: undefined })).status, 400, 'sem horário');
  assert.equal((await attempt({})).status, 201, 'com tudo certo o agendamento é criado');
});

test('o cliente informa se o número também é WhatsApp e isso volta nas consultas', async () => {
  const data = openDay(10);
  const hugo = customer(15);
  const ines = customer(16);
  const withWhatsapp = await book(hugo, { data, hora: '09:00', whatsapp: true });
  const withoutWhatsapp = await book(ines, { data, hora: '09:30' });
  assert.equal(withWhatsapp.body.agendamento.whatsapp, true);
  assert.equal(withoutWhatsapp.body.agendamento.whatsapp, false);
  assert.equal((await request('POST', '/api/authenticate', auth(hugo))).body.agendamentos[0].whatsapp, true);
  assert.equal((await request('POST', '/api/authenticate', auth(ines))).body.agendamentos[0].whatsapp, false);
});

test('login do administrador: senha errada é recusada e as rotas protegidas exigem token válido', async () => {
  const wrong = await request('POST', '/admin/login', { email: 'admin@example.com', senha: 'senha-errada' });
  assert.equal(wrong.status, 401);
  const wrongEmail = await request('POST', '/admin/login', { email: 'outro@example.com', senha: 'test-only-password' });
  assert.equal(wrongEmail.status, 401);

  assert.equal((await request('GET', '/admin/appointments')).status, 401, 'sem token');
  assert.equal((await request('GET', '/admin/appointments', undefined, 'token-falso')).status, 401, 'token falso');
  assert.equal((await request('POST', '/admin/holidays', { data: openDay(1) })).status, 401, 'escrita sem token');

  const ok = await admin('GET', `/admin/appointments?de=${openDay(1)}&ate=${openDay(2)}`);
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.body.agendamentos) && Array.isArray(ok.body.feriados) && Array.isArray(ok.body.bloqueios));
  assert.equal((await admin('GET', '/admin/appointments?de=2026-12-31&ate=2026-12-01')).status, 400, 'período invertido');
});

test('o administrador agenda para um cliente, pré-confirma e cancela, e o cliente enxerga cada mudança', async () => {
  const data = openDay(11);
  const joao = customer(17);
  const corte = await service(30);

  const denied = await request('POST', '/admin/appointments', { ...joao, servico_id: corte.id, data, hora: '16:00' });
  assert.equal(denied.status, 401);

  const created = await admin('POST', '/admin/appointments', { ...joao, servico_id: corte.id, data, hora: '16:00' });
  assert.equal(created.status, 201, 'o painel recebe a confirmação (antes devolvia erro 500 mesmo gravando o agendamento)');
  assert.equal(created.body.agendamento.data, data);
  assert.equal(created.body.agendamento.hora, '16:00');
  const id = created.body.agendamento.id;
  assert.equal((await request('POST', '/api/authenticate', auth(joao))).body.agendamentos[0].status, 'agendado');

  const confirmed = await admin('POST', `/admin/appointments/${id}/confirm`);
  assert.equal(confirmed.body.agendamento.status, 'presente');
  assert.equal((await book(customer(18), { data, hora: '16:00' })).status, 409, 'pré-confirmado continua ocupando o horário');

  const cancelled = await admin('POST', `/admin/appointments/${id}/cancel`, { motivo: 'Barbeiro doente' });
  assert.equal(cancelled.status, 200);
  assert.equal((await admin('POST', `/admin/appointments/${id}/cancel`, {})).status, 400, 'já cancelado');
  assert.equal((await admin('POST', `/admin/appointments/${id}/confirm`)).status, 400, 'não confirma cancelado');
  assert.equal((await admin('POST', '/admin/appointments/999999/confirm')).status, 404);

  const seen = (await request('POST', '/api/authenticate', auth(joao))).body.agendamentos[0];
  assert.equal(seen.status, 'cancelado');
  assert.equal(seen.motivo_cancelamento, 'Barbeiro doente');
  assert.equal((await book(customer(18), { data, hora: '16:00' })).status, 201, 'horário liberado');
});

test('o administrador consulta horários de hoje pelo painel, mas o cliente não vê dia passado', async () => {
  const corte = await service(30);
  const today = todayInBrazil();
  const pastForAdmin = await admin('GET', `/admin/available-slots/${shiftDays(-1)}/${corte.id}`);
  assert.equal(pastForAdmin.status, 400);
  const forAdmin = await admin('GET', `/admin/available-slots/${today}/${corte.id}`);
  // Hoje é válido para o painel; só falha se for domingo.
  if (forAdmin.status === 400) assert.match(forAdmin.body.error, /domingo/i);
  else assert.ok(Array.isArray(forAdmin.body.slots));
  assert.equal((await request('GET', `/admin/available-slots/${today}/${corte.id}`)).status, 401, 'sem token');
});
