import { $, $$, closeModal } from './core.js';

function setupScrollAnimations() {
  if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    return;
  const selectors = [
    '.quick-facts .fact',
    '.services-section .section-heading',
    '.service-card',
    '.gallery-heading',
    '.gallery-card',
    '.booking-intro',
    '.booking-card',
    '.about-image',
    '.about-copy',
    '.location-copy',
    '.map-card',
    '.final-cta-inner',
    '.site-footer .footer-main'
  ];
  const elements = selectors.flatMap((selector) => $$(selector));
  if (!elements.length) return;
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('motion-in');
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: '0px 0px -7% 0px', threshold: 0.12 }
  );

  elements.forEach((element) => {
    element.classList.add('motion-reveal');
    if (element.classList.contains('service-card')) {
      const siblings = [...element.parentElement.querySelectorAll('.service-card')];
      element.style.setProperty('--motion-delay', String(Math.max(0, siblings.indexOf(element)) * 75) + 'ms');
    } else if (element.classList.contains('fact')) {
      const siblings = [...element.parentElement.querySelectorAll('.fact')];
      element.style.setProperty('--motion-delay', String(Math.max(0, siblings.indexOf(element)) * 65) + 'ms');
    }
    observer.observe(element);
  });
}

function bindNavigation() {
  const menu = $('#mainNav');
  const toggle = $('#menuToggle');
  const setMenuOpen = (open) => {
    menu.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
  };
  toggle.addEventListener('click', () => setMenuOpen(!menu.classList.contains('open')));
  $$('a,button', menu).forEach((item) => item.addEventListener('click', () => setMenuOpen(false)));
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.site-header')) setMenuOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu.classList.contains('open')) {
      setMenuOpen(false);
      toggle.focus();
    }
  });
}

function bindMobileBookingBar() {
  const bar = $('#mobileBookingBar');
  bar.inert = true;
  if (!('IntersectionObserver' in window)) return;
  let heroVisible = true;
  let bookingVisible = false;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.target.matches('.hero')) heroVisible = entry.isIntersecting;
      if (entry.target.id === 'agendar') bookingVisible = entry.isIntersecting;
    }
    const visible = !heroVisible && !bookingVisible;
    bar.classList.toggle('is-visible', visible);
    bar.inert = !visible || document.body.classList.contains('modal-open');
    bar.setAttribute('aria-hidden', String(!visible));
  });
  observer.observe($('.hero'));
  observer.observe($('#agendar'));
}

function bindModalKeyboard() {
  document.addEventListener('keydown', (event) => {
    const modal = $('.modal-backdrop:not(.hidden)');
    if (!modal) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeModal(modal.id);
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = $$(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex="0"]',
      modal
    ).filter((control) => control.getClientRects().length > 0);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
      event.preventDefault();
      last?.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last || !modal.contains(document.activeElement))
    ) {
      event.preventDefault();
      first?.focus();
    }
  });
}

function bindPageChrome() {
  setupScrollAnimations();
  bindNavigation();
  bindMobileBookingBar();
  bindModalKeyboard();
  $('#year').textContent = new Date().getFullYear();
  $$('[data-close]').forEach((btn) => btn.addEventListener('click', () => closeModal(btn.dataset.close)));
  $$('.modal-backdrop').forEach((modal) =>
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal(modal.id);
    })
  );
}

export { bindPageChrome };
