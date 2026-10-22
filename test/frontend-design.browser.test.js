'use strict';

const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserTest } = require('../test-support/browser');
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'test-only-password';
process.env.JWT_SECRET = 'test-only-secret-with-at-least-32-characters';
const { app } = require('../server');
let server;
let base;
let browser;
let launchError;
const browserTest = createBrowserTest(() => launchError);

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    browser = await require('playwright').chromium.launch();
  } catch (error) {
    launchError = error;
  }
});
after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
});

async function open({ width = 1280, height = 900, reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(
    (url) => !url.href.startsWith(base),
    (route) => route.abort()
  );
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#serviceSelect option').length > 1);
  return { page, context, errors };
}

browserTest('fotografias locais e ícones vetoriais carregam sem serviços externos', async () => {
  const { page, context, errors } = await open();
  try {
    await page.locator('#sobre').scrollIntoViewIfNeeded();
    await page.locator('#galeria').scrollIntoViewIfNeeded();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('img[src]')].every((img) => img.complete && img.naturalWidth > 0)
    );
    const sources = await page
      .locator('img[src]')
      .evaluateAll((images) => images.map((img) => ({ path: img.getAttribute('src'), alt: img.alt })));
    assert.ok(sources.length >= 7);
    assert.ok(sources.every((img) => img.path.startsWith('/images/') && img.alt.length > 10));
    const icons = await page
      .locator('svg.icon use')
      .evaluateAll((uses) => uses.map((use) => document.querySelector(use.getAttribute('href')) !== null));
    assert.ok(icons.length > 30);
    assert.ok(icons.every(Boolean));
    assert.match(await page.locator('.gallery-note').innerText(), /Fotos ilustrativas/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

browserTest('galeria amplia, navega por botões e teclado e devolve o foco ao fechar', async () => {
  const { page, context, errors } = await open();
  try {
    const first = page.locator('.gallery-card').first();
    await first.click();
    await page.waitForFunction(() => document.getElementById('galleryPreview').naturalWidth > 0);
    assert.equal(await page.locator('#galleryPosition').innerText(), '1 / 4');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#galleryPosition').innerText(), '2 / 4');
    await page.locator('#galleryNext').click();
    assert.equal(await page.locator('#galleryPosition').innerText(), '3 / 4');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('#galleryPosition').innerText(), '2 / 4');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#galleryModal').isVisible(), false);
    assert.equal(await first.evaluate((element) => document.activeElement === element), true);
    assert.equal(await page.locator('body').evaluate((body) => body.style.overflow), '');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

browserTest('a navegação por Tab permanece dentro da galeria aberta', async () => {
  const { page, context } = await open();
  try {
    await page.locator('.gallery-card').first().click();
    await page.waitForFunction(() => document.activeElement?.matches('[data-close="galleryModal"]'));
    await page.keyboard.press('Shift+Tab');
    assert.equal(
      await page.locator('#galleryNext').evaluate((element) => document.activeElement === element),
      true
    );
    await page.keyboard.press('Tab');
    assert.equal(
      await page
        .locator('[data-close="galleryModal"]')
        .evaluate((element) => document.activeElement === element),
      true
    );
    await page.keyboard.press('Escape');
  } finally {
    await context.close();
  }
});

browserTest('menu móvel abre, fecha ao escolher uma ação e restaura o foco após a consulta', async () => {
  const { page, context, errors } = await open({ width: 390, height: 844 });
  try {
    assert.equal(await page.locator('#menuToggle').getAttribute('aria-expanded'), 'false');
    await page.locator('#menuToggle').click();
    assert.equal(await page.locator('#menuToggle').getAttribute('aria-expanded'), 'true');
    await page.locator('#openMyAppointments').click();
    assert.equal(await page.locator('#menuToggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#customerModal').isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(
      await page.locator('#menuToggle').evaluate((element) => document.activeElement === element),
      true
    );
    await page.locator('#menuToggle').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#menuToggle').getAttribute('aria-expanded'), 'false');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

browserTest('o atalho móvel aparece após a abertura e se recolhe ao chegar ao formulário', async () => {
  const { page, context } = await open({ width: 390, height: 844, reducedMotion: 'reduce' });
  try {
    assert.equal(await page.locator('#mobileBookingBar').evaluate((element) => element.inert), true);
    await page.locator('#servicos').scrollIntoViewIfNeeded();
    await page.waitForFunction(() =>
      document.getElementById('mobileBookingBar').classList.contains('is-visible')
    );
    assert.equal(await page.locator('#mobileBookingBar').evaluate((element) => element.inert), false);
    await page.locator('#mobileBookingBar a').click();
    await page.waitForFunction(
      () => !document.getElementById('mobileBookingBar').classList.contains('is-visible')
    );
    assert.equal(await page.locator('#mobileBookingBar').evaluate((element) => element.inert), true);
    assert.equal(new URL(page.url()).hash, '#agendar');
  } finally {
    await context.close();
  }
});

browserTest(
  'movimento reduzido e tela de 320px preservam conteúdo e navegação sem rolagem lateral',
  async () => {
    const { page, context } = await open({ width: 320, height: 740, reducedMotion: 'reduce' });
    try {
      await page.locator('#galeria').scrollIntoViewIfNeeded();
      const layout = await page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
        animation: getComputedStyle(document.querySelector('.hero-content')).animationName
      }));
      assert.equal(layout.scroll, layout.width);
      assert.equal(layout.animation, 'none');
      assert.equal(await page.locator('.motion-reveal').count(), 0);
      await page.locator('.gallery-card').first().click();
      assert.equal(await page.locator('#galleryModal').isVisible(), true);
      await page.keyboard.press('Escape');
    } finally {
      await context.close();
    }
  }
);
