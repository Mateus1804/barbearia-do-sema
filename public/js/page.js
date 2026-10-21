import { $, $$, closeModal } from './core.js';

function setupScrollAnimations() {
  if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    return;
  const selectors = [
    '.quick-facts .fact',
    '.services-section .section-heading',
    '.service-card',
    '.booking-intro',
    '.booking-card',
    '.about-image',
    '.about-copy',
    '.quote-band p',
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

function bindPageChrome() {
  setupScrollAnimations();
  $('#year').textContent = new Date().getFullYear();
  $('#menuToggle').addEventListener('click', () => {
    const open = $('#mainNav').classList.toggle('open');
    $('#menuToggle').setAttribute('aria-expanded', String(open));
  });
  $$('#mainNav a').forEach((a) =>
    a.addEventListener('click', () => {
      $('#mainNav').classList.remove('open');
      $('#menuToggle').setAttribute('aria-expanded', 'false');
    })
  );
  $$('[data-close]').forEach((btn) => btn.addEventListener('click', () => closeModal(btn.dataset.close)));
  $$('.modal-backdrop').forEach((modal) =>
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal(modal.id);
    })
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $$('.modal-backdrop:not(.hidden)').forEach((m) => closeModal(m.id));
  });
}

export { bindPageChrome };
