// Testes de layout no navegador (Playwright): alinhamento, centralização e ausência de rolagem lateral
// em desktop, tablet e celular. Cada teste trava um defeito visual que já aconteceu de verdade.
// Se o Chromium do Playwright não estiver instalado, os testes são pulados (`npx playwright install chromium`).
const { before, after } = require('node:test');
const { createBrowserTest } = require('../test-support/browser');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'test-only-password';
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters';
const { app } = require('../server');

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 }
];
const TOLERANCE = 1.5; // px

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

const browserTest = createBrowserTest(() => launchError);

// `settle: true` desliga só a revelação ao rolar (opacity/transform de entrada) para medir o layout final.
async function open({ width, height }, { settle = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await page.route(url => !url.href.startsWith(base), route => route.abort()); // sem internet: fontes e fotos externas
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#serviceSelect option').length > 1);
  if (settle) await page.addStyleTag({ content: '.motion-reveal{opacity:1!important;transform:none!important;transition:none!important}' });
  return { context, page };
}
const rectOf = (page, selector, nth = 0) => page.locator(selector).nth(nth).evaluate(el => {
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
});
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= TOLERANCE, `${message} (obtido ${actual.toFixed(1)}, esperado ${expected.toFixed(1)})`);

for (const viewport of VIEWPORTS) {
  browserTest(`${viewport.name}: a página não tem rolagem horizontal`, async () => {
    const { context, page } = await open(viewport);
    try {
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
      assert.ok(scrollWidth <= clientWidth, `scrollWidth ${scrollWidth} > clientWidth ${clientWidth}`);
    } finally { await context.close(); }
  });

  browserTest(`${viewport.name}: cards de serviço alinhados, grade sem buraco e selo "queridinho" no canto`, async () => {
    const { context, page } = await open(viewport);
    try {
      const grid = await rectOf(page, '.services-grid');
      const cards = [];
      for (let i = 0; i < await page.locator('.service-card').count(); i++) cards.push(await rectOf(page, '.service-card', i));
      assert.equal(cards.length, 5);

      // Mesma linha = mesmo topo e mesma altura.
      const rows = new Map();
      for (const card of cards) {
        const key = Math.round(card.top / 4);
        rows.set(key, [...(rows.get(key) || []), card]);
      }
      for (const row of rows.values()) {
        row.forEach(card => { near(card.top, row[0].top, 'topo dos cards da mesma linha'); near(card.height, row[0].height, 'altura dos cards da mesma linha'); });
      }
      // Cada linha vai de ponta a ponta da grade: o 5º card não pode ficar sozinho com um vazio ao lado.
      for (const row of rows.values()) {
        near(Math.min(...row.map(card => card.left)), grid.left, 'a linha começa na borda esquerda da grade');
        near(Math.max(...row.map(card => card.right)), grid.right, 'a linha termina na borda direita da grade');
      }

      // O número do card (01…05) fica na mesma altura relativa em todos, inclusive no destaque.
      const offsetOf = async nth => (await rectOf(page, '.service-number', nth)).top - cards[nth].top;
      const firstOffset = await offsetOf(0);
      for (let i = 1; i < 5; i++) near(await offsetOf(i), firstOffset, `número do card ${i + 1} alinhado ao do card 1`);

      // O selo é o canto superior direito do card, não uma faixa em linha.
      const ribbon = await rectOf(page, '.featured-ribbon');
      near(ribbon.right, cards[4].right, 'selo encostado na borda direita');
      near(ribbon.top, cards[4].top, 'selo encostado no topo');
      assert.ok(ribbon.width < cards[4].width / 2, 'selo é um canto, não uma faixa de largura total');
    } finally { await context.close(); }
  });

  browserTest(`${viewport.name}: cartão e pino do mapa ficam centralizados no mapa`, async () => {
    const { context, page } = await open(viewport);
    try {
      const map = await rectOf(page, '.map-card');
      const label = await rectOf(page, '.map-label');
      const pin = await rectOf(page, '.map-pin');
      near(label.cx, map.cx, 'cartão "Barbearia do Semá" centralizado no mapa');
      near(pin.cx, label.cx, 'pino alinhado ao eixo do cartão');
      assert.ok(label.left >= map.left && label.right <= map.right, 'cartão não ultrapassa as bordas do mapa');
      assert.ok(pin.bottom <= label.top + 6, 'pino fica acima do cartão');
    } finally { await context.close(); }
  });

  browserTest(`${viewport.name}: títulos de seção e cartão de agendamento centralizados`, async () => {
    const { context, page } = await open(viewport);
    try {
      const heading = await rectOf(page, '.services-section .section-heading');
      near(heading.cx, viewport.width / 2, 'título "Escolha seu serviço" centralizado na tela');
      if (viewport.width <= 790) {
        const card = await rectOf(page, '.booking-card');
        near(card.left, viewport.width - card.right, 'cartão de agendamento com margens iguais dos dois lados');
      }
      // Todos os blocos do conteúdo respeitam as mesmas margens laterais do site.
      const wraps = await page.locator('.wrap').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return [r.left, window.innerWidth - r.right]; }));
      for (const [left, right] of wraps) near(left, right, 'margens laterais iguais nos blocos do site');
    } finally { await context.close(); }
  });

  browserTest(`${viewport.name}: animações não tiram elementos posicionados do lugar`, async () => {
    // O cartão do mapa chegou a ser empurrado 139px porque uma animação sobrescrevia o transform que o centralizava.
    const { context, page } = await open(viewport, { settle: false });
    try {
      // Elementos decorativos que giram de propósito (estrela do cartão, ornamento da citação) ficam de fora.
      const selectors = ['.map-label', '.map-pin', '.featured-ribbon', '.about-stamp'];
      for (const selector of selectors) await page.locator(selector).first().evaluate(el => el.scrollIntoView({ block: 'center' }));
      await page.locator('.map-label').evaluate(el => el.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(1800); // deixa as entradas terminarem
      const measure = async () => {
        const result = {};
        for (const selector of selectors) {
          const r = await page.locator(selector).first().evaluate(el => { const b = el.getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY }; });
          result[selector] = r;
        }
        return result;
      };
      const animated = await measure();
      await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}.motion-reveal{opacity:1!important;transform:none!important}' });
      await page.waitForTimeout(300);
      const still = await measure();
      for (const selector of selectors) {
        near(animated[selector].x, still[selector].x, `${selector}: posição horizontal com e sem animação`);
        near(animated[selector].y, still[selector].y, `${selector}: posição vertical com e sem animação`);
      }
    } finally { await context.close(); }
  });
}

browserTest('desktop: o painel de pendências abre neutro e só fica vermelho depois de um campo inválido', async () => {
  const { context, page } = await open(VIEWPORTS[0]);
  try {
    const panel = page.locator('#bookingRequirements');
    assert.equal(await panel.evaluate(el => el.classList.contains('has-errors')), false, 'sem alerta vermelho antes de o cliente mexer');
    const neutral = await panel.evaluate(el => getComputedStyle(el).backgroundColor);

    await page.fill('#clientPhone', '(31) 999');
    await page.locator('#clientPhone').blur();
    assert.equal(await panel.evaluate(el => el.classList.contains('has-errors')), true, 'fica vermelho após telefone inválido');
    await page.waitForTimeout(500); // a cor transiciona por 0,3 s
    assert.notEqual(await panel.evaluate(el => getComputedStyle(el).backgroundColor), neutral, 'a cor muda de verdade');
  } finally { await context.close(); }
});
