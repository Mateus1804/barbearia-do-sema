// Robustez do frontend (Playwright): sessão do admin ao recarregar, elementos ausentes no DOM e falhas de rede.
// Cada teste trava um bug já corrigido. Se o Chromium não estiver instalado, os testes são pulados.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'test-only-password';
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters';
const { app } = require('../server');

let server;
let base;
let browser;
let launchError = null;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch();
  } catch (error) {
    launchError = error;
  }
});
after(async () => {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
});

const skipIfNoBrowser = () => (launchError ? { skip: `Chromium indisponível: ${launchError.message.split('\n')[0]}` } : {});

function bookableDate(daysAhead) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + daysAhead);
  while (date.getUTCDay() === 0) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

async function openSite({ adminToken } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route(url => !url.href.startsWith(base), route => route.abort());
  if (adminToken) await page.addInitScript(token => sessionStorage.setItem('sema_admin_token', token), adminToken);
  return { context, page, pageErrors };
}

async function loadSite(page) {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#serviceSelect option').length > 1);
}

async function fillBookingForm(page) {
  await page.fill('#clientName', 'Cliente Resiliência');
  await page.fill('#clientPhone', '(31) 98888-7777');
  await page.fill('#clientEmail', 'resiliencia@example.com');
  await page.selectOption('#serviceSelect', { index: 1 });
  await page.fill('#appointmentDate', bookableDate(3));
  await page.locator('#appointmentDate').dispatchEvent('change');
  await page.waitForFunction(() => !document.getElementById('appointmentTime').disabled && document.querySelectorAll('#appointmentTime option').length > 1);
  await page.selectOption('#appointmentTime', { index: 1 });
}

const fakeCreated = { message: 'ok', lembretes_email_ativos: false, agendamento: { id: 1, nome: 'Cliente Resiliência', servico: 'Corte de cabelo', preco: 50, data: bookableDate(3), hora: '09:00', status: 'agendado' } };

// --- Sessão do administrador ao recarregar a página -------------------------------------------------

test('com token de admin salvo, ao carregar o site o painel abre logado e já busca a agenda', skipIfNoBrowser(), async () => {
  const { context, page, pageErrors } = await openSite({ adminToken: 'token-de-teste' });
  try {
    const agendaRequests = [];
    await page.route('**/admin/appointments**', route => {
      agendaRequests.push({ url: route.request().url(), auth: route.request().headers().authorization });
      return route.fulfill({ json: { agendamentos: [], feriados: [], bloqueios: [] } });
    });
    await loadSite(page);
    await page.waitForFunction(() => document.getElementById('adminMetrics').children.length > 0, null, { timeout: 5000 });

    assert.equal(agendaRequests.length, 1, 'carrega a agenda uma vez ao iniciar');
    assert.equal(agendaRequests[0].auth, 'Bearer token-de-teste', 'usa o token salvo');
    assert.equal(await page.locator('#adminDashboard').evaluate(el => el.classList.contains('hidden')), false, 'painel visível');
    assert.equal(await page.locator('#adminLoginPanel').evaluate(el => el.classList.contains('hidden')), true, 'tela de login escondida');
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test('sem token salvo, o painel do admin continua na tela de login e nada é pedido ao servidor', skipIfNoBrowser(), async () => {
  const { context, page } = await openSite();
  try {
    let adminCalls = 0;
    await page.route('**/admin/appointments**', route => { adminCalls += 1; return route.fulfill({ json: {} }); });
    await loadSite(page);
    await page.click('#openAdmin');
    assert.equal(await page.locator('#adminLoginPanel').evaluate(el => el.classList.contains('hidden')), false, 'login visível');
    assert.equal(await page.locator('#adminDashboard').evaluate(el => el.classList.contains('hidden')), true, 'painel escondido');
    assert.equal(adminCalls, 0);
  } finally { await context.close(); }
});

// --- Elemento ausente no DOM -------------------------------------------------------------------------

test('o agendamento não quebra se o checkbox do WhatsApp não existir no HTML e envia whatsapp=false', skipIfNoBrowser(), async () => {
  const { context, page, pageErrors } = await openSite();
  try {
    const bodies = [];
    await page.route('**/api/appointments', route => {
      if (route.request().method() !== 'POST') return route.continue();
      bodies.push(route.request().postDataJSON());
      return route.fulfill({ status: 201, json: fakeCreated });
    });
    await loadSite(page);
    await fillBookingForm(page);
    await page.evaluate(() => document.getElementById('clientWhatsapp').remove());
    await page.click('#submitBooking');
    await page.waitForSelector('#bookingSuccess:not(.hidden)');

    assert.equal(bodies.length, 1);
    assert.strictEqual(bodies[0].whatsapp, false);
    assert.deepEqual(pageErrors, [], 'nenhum erro de JavaScript na página');
  } finally { await context.close(); }
});

test('o checkbox do WhatsApp marcado ou desmarcado é enviado como true ou false', skipIfNoBrowser(), async () => {
  const { context, page } = await openSite();
  try {
    const bodies = [];
    await page.route('**/api/appointments', route => {
      if (route.request().method() !== 'POST') return route.continue();
      bodies.push(route.request().postDataJSON());
      return route.fulfill({ status: 201, json: fakeCreated });
    });
    await loadSite(page);
    await fillBookingForm(page);
    await page.check('#clientWhatsapp');
    await page.click('#submitBooking');
    await page.waitForSelector('#bookingSuccess:not(.hidden)');
    assert.strictEqual(bodies[0].whatsapp, true);

    await page.click('#newBooking');
    await fillBookingForm(page);
    await page.click('#submitBooking');
    await page.waitForFunction(() => document.getElementById('submitBooking') && !document.getElementById('bookingSuccess').classList.contains('hidden'));
    assert.strictEqual(bodies[1].whatsapp, false);
  } finally { await context.close(); }
});

// --- Falhas de rede ----------------------------------------------------------------------------------

test('sem conexão, o cliente vê uma mensagem clara e o botão volta a funcionar', skipIfNoBrowser(), async () => {
  const { context, page, pageErrors } = await openSite();
  try {
    await page.route('**/api/appointments', route => (route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue()));
    await loadSite(page);
    await fillBookingForm(page);
    await page.click('#submitBooking');

    await page.waitForFunction(() => document.getElementById('toast').classList.contains('show'));
    assert.equal(await page.locator('#toast').innerText(), 'Verifique sua conexão de internet e tente novamente.');
    assert.equal(await page.locator('#toast').evaluate(el => el.classList.contains('toast-error')), true);
    assert.equal(await page.locator('#submitBooking').isDisabled(), false, 'dá para tentar de novo');
    assert.equal(await page.locator('#bookingSuccess').evaluate(el => el.classList.contains('hidden')), true, 'não mostra sucesso');
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test('sem conexão, a consulta de horários também avisa em vez de mostrar erro técnico', skipIfNoBrowser(), async () => {
  const { context, page } = await openSite();
  try {
    await loadSite(page);
    await page.route('**/api/available-slots/**', route => route.abort('internetdisconnected'));
    await page.selectOption('#serviceSelect', { index: 1 });
    await page.waitForFunction(() => /conexão/i.test(document.getElementById('availabilityHint').textContent));
    assert.equal(await page.locator('#availabilityHint').innerText(), 'Verifique sua conexão de internet e tente novamente.');
    assert.equal(await page.locator('#appointmentTime').isDisabled(), true);
  } finally { await context.close(); }
});

test('erros devolvidos pelo servidor continuam aparecendo com a mensagem original (não viram "sem conexão")', skipIfNoBrowser(), async () => {
  const { context, page } = await openSite();
  try {
    await page.route('**/api/appointments', route => (route.request().method() === 'POST'
      ? route.fulfill({ status: 409, json: { error: 'Esse horário acabou de ficar indisponível. Escolha outro horário.' } })
      : route.continue()));
    await loadSite(page);
    await fillBookingForm(page);
    await page.click('#submitBooking');
    await page.waitForFunction(() => document.getElementById('toast').classList.contains('show'));
    assert.equal(await page.locator('#toast').innerText(), 'Esse horário acabou de ficar indisponível. Escolha outro horário.');

    // Resposta de erro sem corpo JSON usa a mensagem padrão.
    await page.route('**/api/appointments', route => (route.request().method() === 'POST' ? route.fulfill({ status: 500, body: 'oops' }) : route.continue()));
    await page.click('#submitBooking');
    await page.waitForFunction(() => /Não foi possível concluir/.test(document.getElementById('toast').textContent));
  } finally { await context.close(); }
});
