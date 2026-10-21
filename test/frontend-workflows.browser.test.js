'use strict';

const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserTest } = require('./helpers/browser');
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'test-only-password';
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters';
const { app } = require('../server');

let server;
let base;
let browser;
let launchError;
const browserTest = createBrowserTest(() => launchError);

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  try { browser = await require('playwright').chromium.launch(); }
  catch (error) { launchError = error; }
});
after(async () => {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
});

function openDay(offset) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  while (date.getUTCDay() === 0) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

async function openSite({ admin = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (admin) await context.addInitScript(() => sessionStorage.setItem('sema_admin_token', 'test-token'));
  const page = await context.newPage();
  await page.route(url => !url.href.startsWith(base), route => route.abort());
  if (admin) await page.route('**/admin/appointments**', route => route.fulfill({ json: { agendamentos: [], bloqueios: [], feriados: [] } }));
  await page.goto(base);
  await page.waitForFunction(() => document.querySelectorAll('#serviceSelect option').length > 1);
  return { page, context };
}

browserTest('cliente consulta só pelo telefone, remarca pelo formulário e cancela usando só o e-mail', async () => {
  const customer = { nome: 'Cliente Fluxo', telefone: '31987776666', email: 'fluxo@example.com' };
  const response = await fetch(`${base}/api/appointments`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...customer, servico_id: 1, data: openDay(4), hora: '10:00' })
  });
  assert.equal(response.status, 201);
  const { agendamento } = await response.json();
  const { page, context } = await openSite();
  try {
    await page.click('#openMyAppointments');
    await page.fill('#lookupPhone', customer.telefone);
    await page.locator('#customerLoginForm button[type=submit]').click();
    await page.locator(`[data-edit-appointment="${agendamento.id}"]`).click();
    const form = page.locator(`[data-edit-form="${agendamento.id}"]`);
    await page.waitForFunction(() => !document.querySelector('.edit-time').disabled);
    await form.locator('.edit-time').selectOption('10:30');
    const updated = page.waitForResponse(result => result.request().method() === 'PUT');
    await form.locator('button[type=submit]').click();
    const updateResponse = await updated;
    assert.ok(updateResponse.url().endsWith(`/api/appointments/${agendamento.id}`));
    assert.equal(updateResponse.status(), 200);
    await page.waitForFunction(() => document.querySelector('.customer-appointment p')?.textContent.includes('10:30'));

    await page.fill('#lookupPhone', '');
    await page.fill('#lookupEmail', customer.email);
    const lookup = page.waitForResponse(result => result.url().endsWith('/api/authenticate'));
    await page.locator('#customerLoginForm button[type=submit]').click();
    assert.equal((await lookup).status(), 200);
    page.once('dialog', dialog => dialog.accept());
    const cancelled = page.waitForResponse(result => result.request().method() === 'DELETE');
    await page.locator(`[data-cancel-appointment="${agendamento.id}"]`).click();
    assert.equal((await cancelled).status(), 200);
    await page.waitForFunction(() => document.querySelector('.appointment-tag')?.textContent === 'Cancelado');
  } finally { await context.close(); }
});

browserTest('admin mantém os horários mais recentes quando a resposta anterior chega depois', async () => {
  const { page, context } = await openSite({ admin: true });
  let releaseOld;
  const oldReleased = new Promise(resolve => { releaseOld = resolve; });
  let notifyOld;
  const oldStarted = new Promise(resolve => { notifyOld = resolve; });
  const chosen = openDay(6);
  try {
    await page.click('#openAdmin');
    await page.route('**/admin/available-slots/**', async route => {
      const latest = route.request().url().includes(`/${chosen}/`);
      if (!latest) { notifyOld(); await oldReleased; }
      await route.fulfill({ json: { slots: latest ? ['15:00', '15:30'] : ['09:00'] } });
    });
    await page.selectOption('#adminBookingService', '1');
    await oldStarted;
    await page.fill('#adminBookingDate', chosen);
    await page.locator('#adminBookingDate').dispatchEvent('change');
    await page.waitForFunction(() => document.querySelector('#adminBookingTime option[value="15:00"]'));
    const oldResponse = page.waitForResponse(result => result.url().includes('/admin/available-slots/') && !result.url().includes(`/${chosen}/`));
    releaseOld();
    await (await oldResponse).finished();
    await page.waitForTimeout(150);
    assert.deepEqual(await page.locator('#adminBookingTime option').evaluateAll(options => options.map(option => option.value).filter(Boolean)), ['15:00', '15:30']);
  } finally { releaseOld(); await context.close(); }
});

browserTest('uma resposta antiga da agenda não substitui o período selecionado depois', async () => {
  const { page, context } = await openSite({ admin: true });
  const slowDate = openDay(7);
  const fastDate = openDay(9);
  let releaseOld;
  const oldReleased = new Promise(resolve => { releaseOld = resolve; });
  let notifyOld;
  const oldStarted = new Promise(resolve => { notifyOld = resolve; });
  try {
    await page.click('#openAdmin');
    await page.route('**/admin/appointments**', async route => {
      const slow = new URL(route.request().url()).searchParams.get('de') === slowDate;
      if (slow) { notifyOld(); await oldReleased; }
      const appointment = { id: slow ? 71 : 91, nome: slow ? 'Agenda anterior' : 'Agenda atual', servico: 'Corte', data: slow ? slowDate : fastDate, hora: '10:00', preco: 50, telefone: '', status: 'agendado' };
      await route.fulfill({ json: { agendamentos: [appointment], bloqueios: [], feriados: [] } });
    });
    await page.fill('#adminFrom', slowDate);
    await page.fill('#adminTo', slowDate);
    await page.click('#loadAdminAppointments');
    await oldStarted;
    await page.fill('#adminFrom', fastDate);
    await page.fill('#adminTo', fastDate);
    await page.click('#loadAdminAppointments');
    await page.waitForFunction(() => document.getElementById('adminAppointments').textContent.includes('Agenda atual'));
    const oldResponse = page.waitForResponse(result => result.url().includes(`/admin/appointments?de=${slowDate}`));
    releaseOld();
    await (await oldResponse).finished();
    await page.waitForTimeout(150);
    assert.match(await page.locator('#adminAppointments').innerText(), /Agenda atual/);
    assert.doesNotMatch(await page.locator('#adminAppointments').innerText(), /Agenda anterior/);
  } finally { releaseOld(); await context.close(); }
});
