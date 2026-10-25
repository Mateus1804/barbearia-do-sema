'use strict';

// Scrollytelling: revelações, parallax, progresso, menu ativo e respeito a "movimento reduzido".
// O que estes testes protegem, em ordem de gravidade: (1) nada fica escondido para sempre,
// (2) a rolagem nunca é bloqueada ou reescrita, (3) quem pede menos movimento não recebe movimento.
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

async function open({ width = 1280, height = 800, reducedMotion = 'no-preference' } = {}) {
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

// Rolagem instantânea: o site usa scroll-behavior: smooth, que atrasaria as leituras do teste.
const jumpTo = (page, selector) =>
  page.evaluate((target) => {
    const element = document.querySelector(target);
    window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - 80, behavior: 'instant' });
  }, selector);

const isRevealed = (locator) =>
  locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const clip = style.clipPath;
    return (
      element.classList.contains('motion-in') &&
      Number(style.opacity) === 1 &&
      (clip === 'none' || clip === 'inset(0px)' || /^inset\(0(px)?( 0(px)?){0,3}\)$/.test(clip))
    );
  });

browserTest('o que está abaixo da dobra começa escondido e aparece quando chega à tela', async () => {
  const { page, context, errors } = await open();
  try {
    const card = page.locator('.service-card').first();
    assert.equal(await card.evaluate((element) => element.classList.contains('motion-reveal')), true);
    assert.equal(await card.evaluate((element) => element.classList.contains('motion-in')), false);
    assert.equal(await card.evaluate((element) => Number(getComputedStyle(element).opacity)), 0);
    await jumpTo(page, '#servicos');
    await page.waitForFunction(() => document.querySelector('.service-card').classList.contains('motion-in'));
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.service-card')).opacity) === 1);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

browserTest('as fotos com efeito de cortina (clip-path) também são reveladas ao rolar', async () => {
  // Regressão: o IntersectionObserver ignora elementos escondidos pelo próprio clip-path, e as fotos
  // da seção "experiência" e da galeria nunca apareciam. Hoje o gatilho é o elemento pai.
  const { page, context } = await open();
  try {
    await jumpTo(page, '#sobre');
    await page.waitForFunction(() => document.querySelector('.about-photo').classList.contains('motion-in'));
    await jumpTo(page, '#galeria');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.gallery-card')].every((card) => card.classList.contains('motion-in'))
    );
    await page.waitForTimeout(1500);
    assert.equal(await isRevealed(page.locator('.about-photo')), true);
    for (const card of await page.locator('.gallery-card').all()) {
      assert.equal(await isRevealed(card), true);
      assert.ok((await card.boundingBox()).height > 100);
    }
  } finally {
    await context.close();
  }
});

browserTest('títulos são divididos em palavras sem perder o texto lido por leitores de tela', async () => {
  const { page, context } = await open();
  try {
    const title = page.locator('#servicos h2');
    assert.equal(await title.evaluate((element) => element.textContent.replace(/\s+/g, ' ').trim()), 'Seu próximo visual.');
    assert.equal(await title.locator('.mw').count(), 3);
    assert.equal(await title.locator('em').count(), 1);
    // Cada título tem exatamente o mesmo texto do HTML original servido pelo servidor.
    const html = await (await fetch(base)).text();
    const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
    const original = [...main.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((match) =>
      match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    );
    const texts = await page
      .locator('main h2')
      .evaluateAll((titles) => titles.map((element) => element.textContent.replace(/\s+/g, ' ').trim()));
    assert.equal(texts.length, 6);
    assert.deepEqual(texts, original);
    assert.equal(await page.locator('#sobre h2 br').count(), 1);
  } finally {
    await context.close();
  }
});

browserTest('a rolagem continua do navegador: roda livre, sem bloqueio nem captura', async () => {
  const { page, context } = await open();
  try {
    const html = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const body = getComputedStyle(document.body);
      return { snap: root.scrollSnapType, rootOverflow: root.overflowY, bodyOverflow: body.overflowY };
    });
    assert.equal(html.snap, 'none');
    assert.notEqual(html.rootOverflow, 'hidden');
    assert.notEqual(html.bodyOverflow, 'hidden');
    // Roda do mouse real, com um ouvinte que registra se alguém tentou impedir o gesto.
    await page.evaluate(() => {
      window.__wheelBlocked = false;
      window.addEventListener('wheel', (event) => setTimeout(() => (window.__wheelBlocked ||= event.defaultPrevented)), {
        passive: true
      });
    });
    await page.mouse.move(640, 400);
    await page.mouse.wheel(0, 700);
    await page.waitForFunction(() => window.scrollY > 300);
    await page.mouse.wheel(0, -300);
    await page.waitForFunction(() => window.scrollY < 700);
    assert.equal(await page.evaluate(() => window.__wheelBlocked), false);
  } finally {
    await context.close();
  }
});

browserTest('a barra de progresso e o cabeçalho acompanham a rolagem', async () => {
  const { page, context } = await open();
  try {
    const progress = () =>
      page.locator('.scroll-progress').evaluate((element) => Number(element.style.getPropertyValue('--scroll-progress') || 0));
    assert.equal(await page.locator('.site-header').evaluate((e) => e.classList.contains('is-scrolled')), false);
    assert.ok((await progress()) < 0.02);
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
    await page.waitForFunction(() => Number(document.querySelector('.scroll-progress').style.getPropertyValue('--scroll-progress')) > 0.98);
    assert.equal(await page.locator('.site-header').evaluate((e) => e.classList.contains('is-scrolled')), true);
    assert.equal(await page.locator('.scroll-progress').getAttribute('aria-hidden'), 'true');
  } finally {
    await context.close();
  }
});

browserTest('o menu destaca a seção em foco e solta o destaque no topo', async () => {
  const { page, context } = await open();
  try {
    const current = () =>
      page.locator('.main-nav > a[aria-current="location"]').evaluateAll((links) => links.map((a) => a.getAttribute('href')));
    assert.deepEqual(await current(), []);
    for (const id of ['servicos', 'sobre', 'galeria', 'localizacao']) {
      await jumpTo(page, `#${id}`);
      await page.waitForFunction((hash) => document.querySelector(`.main-nav > a[aria-current="location"]`)?.getAttribute('href') === hash, `#${id}`);
      assert.deepEqual(await current(), [`#${id}`]);
    }
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForFunction(() => !document.querySelector('.main-nav > a[aria-current]'));
  } finally {
    await context.close();
  }
});

browserTest('o parallax só mexe nas imagens enquanto elas estão na tela e nunca as deixa descobertas', async () => {
  const { page, context } = await open();
  try {
    await jumpTo(page, '#sobre');
    const read = () => page.locator('.about-photo').evaluate((element) => Number(element.style.getPropertyValue('--p')));
    await page.waitForFunction(() => document.querySelector('.about-photo').style.getPropertyValue('--p') !== '');
    const before = await read();
    await page.evaluate(() => window.scrollBy({ top: 160, behavior: 'instant' }));
    await page.waitForFunction((start) => Number(document.querySelector('.about-photo').style.getPropertyValue('--p')) !== start, before);
    const after = await read();
    assert.ok(after < before, 'ao descer, a foto sobe na janela (p diminui)');
    // A imagem é mais alta que a moldura (116%), então o deslocamento máximo não deixa borda vazia.
    const covered = await page.locator('.about-photo').evaluate((frame) => {
      const photo = frame.querySelector('img').getBoundingClientRect();
      const box = frame.getBoundingClientRect();
      return photo.top <= box.top + 0.5 && photo.bottom >= box.bottom - 0.5;
    });
    assert.equal(covered, true);
    assert.equal(await page.locator('.hero').evaluate((hero) => hero.style.getPropertyValue('--hero-p') !== ''), true);
  } finally {
    await context.close();
  }
});

browserTest('movimento reduzido: tudo visível de imediato e nenhuma animação ligada à rolagem', async () => {
  const { page, context, errors } = await open({ reducedMotion: 'reduce' });
  try {
    assert.equal(await page.locator('.motion-reveal').count(), 0);
    assert.equal(await page.locator('main h2 .mw').count(), 0, 'títulos não são divididos em palavras');
    await jumpTo(page, '#galeria');
    for (const selector of ['.service-card', '.about-photo', '.gallery-card', '.booking-card', '.map-card']) {
      const hidden = await page.locator(selector).evaluateAll((elements) =>
        elements.filter((element) => Number(getComputedStyle(element).opacity) < 1 || getComputedStyle(element).clipPath !== 'none')
      );
      assert.equal(hidden.length, 0, `${selector} deve estar visível`);
    }
    // Nada é deslocado por variável de rolagem.
    const moved = await page.evaluate(() =>
      ['.about-photo', '.about-image', '.booking-section', '.map-card', '.service-ribbon'].filter(
        (selector) => document.querySelector(selector).style.getPropertyValue('--p') !== ''
      )
    );
    assert.deepEqual(moved, []);
    assert.equal(await page.locator('.hero').evaluate((hero) => hero.style.getPropertyValue('--hero-p')), '');
    assert.equal(await page.locator('.scroll-progress').isVisible(), false);
    // O menu ativo não é movimento e continua funcionando.
    await page.waitForFunction(() => document.querySelector('.main-nav > a[aria-current="location"]'));
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

browserTest('se o JavaScript de movimento não rodar, o conteúdo continua legível', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.route((url) => !url.href.startsWith(base), (route) => route.abort());
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    for (const selector of ['.service-card', '.about-photo', '.gallery-card', '.booking-card']) {
      assert.equal(await page.locator(selector).first().evaluate((element) => Number(getComputedStyle(element).opacity)), 1);
      assert.equal(await page.locator(selector).first().evaluate((element) => getComputedStyle(element).clipPath), 'none');
    }
  } finally {
    await context.close();
  }
});

browserTest('cada serviço tem o seu ícone, e o resumo da reserva acompanha a escolha', async () => {
  const { page, context } = await open();
  try {
    const icons = await page
      .locator('.service-card .service-icon')
      .evaluateAll((spans) => spans.map((span) => [...span.querySelectorAll('use')].map((use) => use.getAttribute('href'))));
    assert.deepEqual(icons, [
      ['#icon-scissors'],
      ['#icon-razor'],
      ['#icon-eye'],
      ['#icon-brush'],
      ['#icon-scissors', '#icon-razor']
    ]);
    const options = await page.locator('#serviceSelect option').allTextContents();
    const expected = { Barba: '#icon-razor', Sobrancelha: '#icon-eye', Pintura: '#icon-brush', 'Corte de': '#icon-scissors', Combo: '#icon-scissors' };
    for (const [label, icon] of Object.entries(expected)) {
      const index = options.findIndex((text) => text.startsWith(label));
      assert.ok(index > 0, `serviço ${label} existe`);
      await page.selectOption('#serviceSelect', { index });
      assert.equal(await page.locator('.summary-icon use').getAttribute('href'), icon, label);
    }
    // Ícones que se "desenham" dependem de pathLength em cada traço do símbolo.
    const missing = await page.evaluate(() =>
      [...document.querySelectorAll('symbol[id^="icon-"]')]
        .filter((symbol) => /icon-(scissors|razor|clipper|eye|brush)$/.test(symbol.id))
        .flatMap((symbol) => [...symbol.querySelectorAll('path,circle,rect')].filter((shape) => !shape.hasAttribute('pathLength')).map(() => symbol.id))
    );
    assert.deepEqual(missing, []);
  } finally {
    await context.close();
  }
});

browserTest('os cartões de serviço têm rodapé alinhado mesmo com descrições de tamanhos diferentes', async () => {
  const { page, context } = await open();
  try {
    await jumpTo(page, '#servicos');
    await page.waitForFunction(() => [...document.querySelectorAll('.service-card')].slice(0, 3).every((card) => card.classList.contains('motion-in')));
    await page.waitForTimeout(1500);
    const rows = await page.locator('.service-card').evaluateAll((cards) => {
      const rect = (card, selector) => Math.round(card.querySelector(selector).getBoundingClientRect().top);
      return cards.slice(0, 3).map((card) => [rect(card, '.service-bottom'), rect(card, '.service-book')]);
    });
    assert.deepEqual(rows[1], rows[0]);
    assert.deepEqual(rows[2], rows[0]);
  } finally {
    await context.close();
  }
});

browserTest('depois de revelados, os elementos terminam exatamente no lugar, no tamanho e opacos', async () => {
  // Regressão: os efeitos "pop" (selos) e "eyebrow" (rótulos) ficavam deslocados 14px e 10px para sempre.
  const { page, context } = await open();
  try {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < height; y += 400) {
      await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), y);
      await page.waitForTimeout(60);
    }
    await page.waitForFunction(() => document.querySelectorAll('.motion-reveal:not(.motion-in)').length === 0);
    await page.waitForTimeout(2200); // a última entrada (cartões com atraso) termina de assentar
    const displaced = await page.evaluate(() =>
      [...document.querySelectorAll('.motion-reveal, .motion-reveal .mw > span')]
        .map((element) => {
          const style = getComputedStyle(element);
          const moved = !['none', '0px', '0px 0px'].includes(style.translate);
          const scaled = !['none', '1'].includes(style.scale);
          return moved || scaled || Number(style.opacity) !== 1 ? `${element.className || element.tagName} ${style.translate} ${style.scale} ${style.opacity}` : null;
        })
        .filter(Boolean)
    );
    assert.deepEqual(displaced, []);
  } finally {
    await context.close();
  }
});
