/*
  Scrollytelling da página.

  Regras do projeto:
  - A rolagem pertence ao navegador. Este arquivo nunca chama preventDefault em eventos de rolagem,
    não usa scroll-snap forçado nem "scroll hijacking": só LÊ a posição e escreve variáveis CSS
    (`--p`, `--hero-p`, `--scroll-progress`) e classes (`motion-in`, `is-scrolled`).
  - Quem anima é o CSS (motion.css), apenas com opacity, translate, scale e clip-path.
  - Com `prefers-reduced-motion: reduce` ou sem IntersectionObserver nada fica escondido: só o menu
    ativo e o sombreamento do cabeçalho continuam funcionando, porque não são movimento.
*/
import { $, $$ } from './core.js';

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/* ---------- Escolha do que é revelado e como ---------- */

// Blocos de texto: cada filho direto entra em sequência (selo, título palavra a palavra, texto, extras).
const TEXT_STAGES = [
  '.section-heading',
  '.gallery-heading > div',
  '.booking-intro',
  '.about-copy',
  '.location-copy',
  '.final-cta-inner > div'
];
// Elementos soltos e o tipo de entrada de cada um.
const SINGLE_REVEALS = [
  ['.quick-facts .fact', 'rise', 65],
  ['.service-card', 'rise', 75],
  ['.service-card .featured-ribbon', 'pop', 0],
  ['.services-footnote', 'rise', 0],
  ['.about-photo', 'wipe', 0],
  ['.about-stamp', 'pop', 350],
  ['.gallery-heading > p', 'rise', 270],
  ['.gallery-card', 'wipe', 90],
  ['.gallery-note', 'rise', 0],
  ['.booking-card', 'rise', 120],
  ['.map-card', 'rise', 0],
  ['.final-cta .button', 'rise', 160],
  ['.site-footer .footer-main', 'rise', 0]
];

function splitWords(heading) {
  let index = 0;
  const wrap = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const fragment = document.createDocumentFragment();
      node.textContent.split(/(\s+)/).forEach((piece) => {
        if (!piece) return;
        if (/^\s+$/.test(piece)) return fragment.append(piece);
        const mask = document.createElement('span');
        const word = document.createElement('span');
        mask.className = 'mw';
        word.textContent = piece;
        word.style.setProperty('--i', String(index++));
        mask.append(word);
        fragment.append(mask);
      });
      node.replaceWith(fragment);
    } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName !== 'BR') {
      [...node.childNodes].forEach(wrap);
    }
  };
  [...heading.childNodes].forEach(wrap);
}

function mark(element, type, delay = 0) {
  if (element.classList.contains('motion-reveal')) return;
  element.classList.add('motion-reveal');
  if (type && type !== 'rise') element.dataset.motion = type;
  if (delay) element.style.setProperty('--motion-delay', `${Math.round(delay)}ms`);
}

function collectReveals() {
  TEXT_STAGES.forEach((selector) => {
    $$(selector).forEach((stage) => {
      let step = 0;
      [...stage.children].forEach((child) => {
        if (child.matches('h2')) {
          splitWords(child);
          mark(child, 'words', step * 90);
        } else if (child.matches('.eyebrow')) {
          mark(child, 'eyebrow', step * 90);
        } else if (child.matches('div:not(.gallery-heading), p, a, ul')) {
          mark(child, 'rise', Math.min(step, 5) * 90);
        } else return;
        step += 1;
      });
    });
  });
  SINGLE_REVEALS.forEach(([selector, type, stagger]) => {
    $$(selector).forEach((element) => {
      const group = [...element.parentElement.children].filter((child) => child.matches(selector));
      mark(element, type, Math.max(0, group.indexOf(element)) * stagger);
    });
  });
  return $$('.motion-reveal');
}

function bindReveals() {
  // Ao marcar um elemento como "escondido" ele não pode fazer a transição de visível para invisível:
  // durante a preparação as transições ficam desligadas (ver `.motion-booting` em motion.css).
  const root = document.documentElement;
  root.classList.add('motion-booting');
  const targets = collectReveals();
  // Um elemento escondido pelo próprio clip-path (a "cortina" das fotos) nunca é considerado visível
  // pelo IntersectionObserver. Por isso essas fotos são observadas pelo elemento pai.
  const triggers = new Map();
  targets.forEach((target) => {
    const trigger = target.dataset.motion === 'wipe' ? target.parentElement : target;
    triggers.set(trigger, [...(triggers.get(trigger) || []), target]);
  });
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        triggers.get(entry.target).forEach((target) => target.classList.add('motion-in'));
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.12 }
  );
  triggers.forEach((group, trigger) => {
    // Quem já ficou para trás (recarregar a página no meio) aparece direto, sem animar fora da tela.
    if (trigger.getBoundingClientRect().bottom < 0) group.forEach((target) => target.classList.add('motion-in'));
    else observer.observe(trigger);
  });
  root.getBoundingClientRect(); // aplica o estado escondido já sem transição
  root.classList.remove('motion-booting');
}

/* ---------- Posição de rolagem -> variáveis CSS ---------- */

function bindScrollLinked() {
  const hero = $('.hero');
  const progress = $('.scroll-progress');
  const tracked = [
    ...$$('.parallax-frame'),
    ...$$('.about-image, .booking-section, .map-card, .service-ribbon')
  ].map((element) => ({ element, visible: false, last: NaN }));
  const motionAllowed = !reducedMotion();

  const watcher = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const item = tracked.find((candidate) => candidate.element === entry.target);
        if (item) item.visible = entry.isIntersecting;
      });
      schedule();
    },
    { rootMargin: '20% 0px 20% 0px' }
  );
  if (motionAllowed) tracked.forEach((item) => watcher.observe(item.element));

  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(update);
  }
  function update() {
    queued = false;
    const viewport = window.innerHeight;
    const scrolled = window.scrollY;
    const maxScroll = document.documentElement.scrollHeight - viewport;
    document.querySelector('.site-header')?.classList.toggle('is-scrolled', scrolled > 8);
    if (progress && maxScroll > 0) progress.style.setProperty('--scroll-progress', (scrolled / maxScroll).toFixed(4));
    if (!motionAllowed) return;
    if (hero) {
      const heroProgress = clamp(scrolled / Math.max(hero.offsetHeight, 1), 0, 1);
      hero.style.setProperty('--hero-p', heroProgress.toFixed(3));
    }
    tracked.forEach((item) => {
      if (!item.visible) return;
      const box = item.element.getBoundingClientRect();
      // -1 quando o elemento entra por baixo, 0 no centro da tela, 1 quando sai por cima.
      const p = clamp(((box.top + box.height / 2) / viewport - 0.5) / (0.5 + box.height / 2 / viewport), -1, 1);
      const rounded = Number(p.toFixed(3));
      if (rounded === item.last) return;
      item.last = rounded;
      item.element.style.setProperty('--p', String(rounded));
    });
  }

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  update();
}

/* ---------- Menu: seção em foco ---------- */

function bindSectionSpy() {
  const links = $$('.main-nav > a[href^="#"]:not(.button)');
  const sections = links
    .map((link) => ({ link, section: document.getElementById(link.getAttribute('href').slice(1)) }))
    .filter((entry) => entry.section);
  if (!sections.length) return;
  const visible = new Set();
  const spy = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => (entry.isIntersecting ? visible.add(entry.target) : visible.delete(entry.target)));
      const active = sections.find((entry) => visible.has(entry.section));
      sections.forEach((entry) => {
        if (entry === active) entry.link.setAttribute('aria-current', 'location');
        else entry.link.removeAttribute('aria-current');
      });
    },
    // Faixa estreita no meio da tela: a seção "em foco" é a que cruza o centro.
    { rootMargin: '-45% 0px -50% 0px' }
  );
  sections.forEach((entry) => spy.observe(entry.section));
}

function bindMotion() {
  bindSectionSpy();
  if ('IntersectionObserver' in window && !reducedMotion()) bindReveals();
  if ('IntersectionObserver' in window) bindScrollLinked();
  else $('.site-header')?.classList.add('is-scrolled');
}

export { bindMotion };
