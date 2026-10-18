// Teste de navegador do formulário de agendamento: indicador de pendências, campos em vermelho e envio.
// Se o Chromium do Playwright não estiver instalado, o teste é pulado (rode `npx playwright install chromium`).
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

function bookableDate(daysAhead) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + daysAhead);
  while (date.getUTCDay() === 0) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

async function openBookingPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  // Isola o teste da internet: fontes e imagens externas são bloqueadas.
  await page.route(url => !url.href.startsWith(base), route => route.abort());
  const apiPosts = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/appointments')) apiPosts.push(request.url()); });
  await page.goto(`${base}/#agendar`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#serviceSelect option').length > 1);
  return { context, page, apiPosts };
}

const skipIfNoBrowser = () => (launchError ? { skip: `Chromium indisponível: ${launchError.message.split('\n')[0]}` } : {});

test('indicador lista o que falta, marca o telefone em vermelho e não envia sem dados completos', skipIfNoBrowser(), async () => {
  const { context, page, apiPosts } = await openBookingPage();
  try {
    const box = page.locator('#bookingRequirements');
    await assert.doesNotReject(box.waitFor());
    assert.ok(await box.evaluate(el => el.classList.contains('is-blocking')), 'começa como pendência');
    // Dia já vem preenchido com amanhã, então ficam cinco pendências (nome, telefone, e-mail, serviço e horário).
    assert.equal(await page.locator('#requirementsList li').count(), 5, 'cinco pendências aparecem');
    assert.equal(await page.locator('#requirementsList').getByText('Dia', { exact: true }).count(), 0, 'dia padrão já é válido');
    assert.equal(await page.locator('.field-invalid').count(), 0, 'nada fica vermelho antes de o cliente mexer');

    // Celular sem o 9 depois do DDD: caixa vermelha e informativo explicando o formato.
    await page.fill('#clientPhone', '(31) 88887-7777');
    await page.locator('#clientPhone').blur();
    assert.ok(await page.locator('#clientPhone').evaluate(el => el.classList.contains('field-invalid')), 'celular sem 9 fica vermelho');
    assert.ok(await page.locator('#phoneHint').evaluate(el => el.classList.contains('feedback-error')), 'informativo fica em destaque');
    assert.match(await page.locator('#phoneHint').innerText(), /fixo ou celular com DDD/i);
    assert.equal(await page.locator('#requirementsList').getByText('Telefone', { exact: true }).count(), 1, 'telefone segue na lista');

    // Fixo é aceito.
    await page.fill('#clientPhone', '(31) 3333-4444');
    await page.locator('#clientPhone').blur();
    assert.ok(await page.locator('#clientPhone').evaluate(el => el.classList.contains('field-valid')), 'fixo válido fica verde');

    await page.fill('#clientPhone', '(31) 99999-8888');
    await page.locator('#clientPhone').blur();
    assert.ok(await page.locator('#clientPhone').evaluate(el => el.classList.contains('field-valid')), 'celular válido fica verde');
    assert.equal(await page.locator('#requirementsList').getByText('Telefone', { exact: true }).count(), 0, 'telefone sai da lista');
    assert.equal(await page.locator('#requirementsList li').count(), 4, 'restam nome, e-mail, serviço e horário');

    await page.click('#submitBooking');
    assert.equal(apiPosts.length, 0, 'nenhuma chamada à API com o formulário incompleto');
    assert.match(await page.locator('.toast').innerText(), /Ainda falta preencher/);
    assert.ok(await page.locator('#clientName').evaluate(el => el.classList.contains('field-invalid')), 'nome vazio marcado após tentar agendar');
  } finally {
    await context.close();
  }
});

test('indicador vira "tudo certo" e o agendamento é criado quando todas as pendências são resolvidas', skipIfNoBrowser(), async () => {
  const { context, page, apiPosts } = await openBookingPage();
  try {
    await page.fill('#clientName', 'Cliente Browser');
    await page.fill('#clientPhone', '(31) 98888-7777');
    await page.fill('#clientEmail', 'browser@example.com');
    await page.selectOption('#serviceSelect', { index: 1 });
    await page.fill('#appointmentDate', bookableDate(3));
    await page.locator('#appointmentDate').dispatchEvent('change');
    await page.waitForFunction(() => document.querySelectorAll('#appointmentTime option').length > 1 && !document.getElementById('appointmentTime').disabled);
    await page.selectOption('#appointmentTime', { index: 1 });

    await page.waitForFunction(() => document.getElementById('bookingRequirements').classList.contains('is-complete'));
    assert.equal(await page.locator('#requirementsList li').count(), 0, 'sem pendências na lista');

    await page.click('#submitBooking');
    await page.waitForSelector('#bookingSuccess:not(.hidden)');
    assert.equal(apiPosts.length, 1, 'uma única chamada de criação');
  } finally {
    await context.close();
  }
});

test('clicar numa pendência leva direto ao campo que falta', skipIfNoBrowser(), async () => {
  const { context, page } = await openBookingPage();
  try {
    await page.locator('#requirementsList').getByText('E-mail', { exact: true }).click();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'clientEmail');
    await page.locator('#requirementsList').getByText('Seu nome', { exact: true }).click();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'clientName');
  } finally {
    await context.close();
  }
});

test('máscara do telefone: formata celular e fixo, preserva número internacional', skipIfNoBrowser(), async () => {
  const { context, page } = await openBookingPage();
  try {
    const typed = async text => {
      await page.fill('#clientPhone', '');
      await page.locator('#clientPhone').pressSequentially(text);
      return page.inputValue('#clientPhone');
    };
    assert.equal(await typed('31999998888'), '(31) 99999-8888');
    assert.equal(await typed('3133334444'), '(31) 3333-4444');
    assert.equal(await typed('3199'), '(31) 99');
    assert.equal(await typed('+14155550123'), '+14155550123');
    assert.equal(await typed('319999988889999'), '(31) 99999-8888', 'ignora dígitos além do 11º');
  } finally {
    await context.close();
  }
});

test('o dia padrão é o próximo dia útil: nunca hoje, nunca domingo; hoje continua selecionável', skipIfNoBrowser(), async () => {
  const { context, page } = await openBookingPage();
  try {
    const value = await page.inputValue('#appointmentDate');
    assert.ok(value > bookableDate(0) || value === bookableDate(1), 'a partir de amanhã');
    assert.notEqual(new Date(`${value}T12:00:00Z`).getUTCDay(), 0, 'não cai no domingo');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    assert.equal(await page.getAttribute('#appointmentDate', 'min'), today, 'o servidor aceita hoje, então o campo também aceita');
  } finally {
    await context.close();
  }
});

test('"Fazer outro agendamento" volta ao formulário limpo, sem campos vermelhos', skipIfNoBrowser(), async () => {
  const { context, page } = await openBookingPage();
  try {
    await page.fill('#clientName', 'Cliente Reset');
    await page.fill('#clientPhone', '(31) 97777-6666');
    await page.fill('#clientEmail', 'reset@example.com');
    await page.selectOption('#serviceSelect', { index: 1 });
    await page.fill('#appointmentDate', bookableDate(4));
    await page.locator('#appointmentDate').dispatchEvent('change');
    await page.waitForFunction(() => !document.getElementById('appointmentTime').disabled && document.querySelectorAll('#appointmentTime option').length > 1);
    await page.selectOption('#appointmentTime', { index: 1 });
    await page.click('#submitBooking');
    await page.waitForSelector('#bookingSuccess:not(.hidden)');

    await page.click('#newBooking');
    await page.waitForSelector('#bookingForm:not(.hidden)');
    assert.equal(await page.inputValue('#clientName'), '');
    assert.equal(await page.locator('.field-invalid').count(), 0, 'nenhum campo vermelho logo ao abrir');
    assert.equal(await page.locator('.field-valid').count(), 0, 'nenhum campo verde logo ao abrir');
    assert.equal(await page.locator('#requirementsList li').count(), 5, 'volta a listar as pendências');
    assert.equal(await page.locator('#appointmentTime').isDisabled(), true);
  } finally {
    await context.close();
  }
});

test('resposta atrasada de uma consulta antiga não sobrescreve os horários da data escolhida depois', skipIfNoBrowser(), async () => {
  const { context, page } = await openBookingPage();
  try {
    const chosen = bookableDate(5);
    // A 1ª consulta (data padrão, disparada ao escolher o serviço) demora; a 2ª (data escolhida) responde na hora.
    await page.route('**/api/available-slots/**', async route => {
      const isChosenDate = route.request().url().includes(`/${chosen}/`);
      if (!isChosenDate) await new Promise(resolve => setTimeout(resolve, 900));
      await route.fulfill({ json: { slots: isChosenDate ? ['15:00', '15:30'] : ['09:00'] } });
    });
    await page.selectOption('#serviceSelect', { index: 1 });
    await page.fill('#appointmentDate', chosen);
    await page.locator('#appointmentDate').dispatchEvent('change');
    await page.waitForTimeout(1500); // dá tempo de a resposta antiga chegar por último
    const options = await page.locator('#appointmentTime option').evaluateAll(list => list.map(option => option.value).filter(Boolean));
    assert.deepEqual(options, ['15:00', '15:30'], 'só os horários da data escolhida ficam na lista');
    assert.equal(await page.locator('#appointmentTime').isDisabled(), false);
  } finally {
    await context.close();
  }
});
