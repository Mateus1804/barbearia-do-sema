import { $, $$, closeModal } from './core.js';
import { bindMotion } from './motion.js';

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
  bindMotion();
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
