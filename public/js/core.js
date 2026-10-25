import '../booking-rules.js';
import { adminSession } from './session.mjs';

const BookingRules = globalThis.BookingRules;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const TIME_ZONE = 'America/Sao_Paulo';
const state = {
  services: [],
  customerAuth: null,
  customerAppointments: [],
  adminToken: adminSession.read(),
  toastTimer: null
};

function localDateString(date = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const obj = Object.fromEntries(p.map((x) => [x.type, x.value]));
  return `${obj.year}-${obj.month}-${obj.day}`;
}
function addDays(dateStr, count) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + count));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}
function formatDate(dateStr, includeYear = true) {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'long',
    ...(includeYear ? { year: 'numeric' } : {})
  });
}
function money(value) {
  return Number(value || 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0
  });
}
function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  );
}
async function api(url, options = {}) {
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {})
  };
  let response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch (error) {
    // fetch só rejeita com TypeError quando a requisição nem chegou ao servidor (sem internet, DNS, servidor fora do ar).
    if (error.name === 'TypeError') throw new Error('Verifique sua conexão de internet e tente novamente.');
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Não foi possível concluir. Tente novamente.');
  return data;
}
function showToast(message, type = 'success') {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('toast-error', type === 'error');
  el.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.remove('show'), 3400);
}
function setBusy(button, busy, busyText = 'Aguarde...') {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.innerHTML;
    button.innerHTML = `<span class="spinner-word">${busyText}</span>`;
    button.disabled = true;
  } else {
    button.innerHTML = button.dataset.originalText || button.innerHTML;
    button.disabled = false;
  }
}
const modalOpeners = new WeakMap();

function updateModalState() {
  const hasOpenModal = !!$('.modal-backdrop:not(.hidden)');
  document.body.style.overflow = hasOpenModal ? 'hidden' : '';
  document.body.classList.toggle('modal-open', hasOpenModal);
  const bookingBar = $('#mobileBookingBar');
  if (bookingBar) bookingBar.inert = hasOpenModal || !bookingBar.classList.contains('is-visible');
}

function openModal(id) {
  const modal = document.getElementById(id);
  if (modal.classList.contains('hidden')) modalOpeners.set(modal, document.activeElement);
  modal.classList.remove('hidden');
  updateModalState();
  const focusable = modal.querySelector('input,button,select');
  if (focusable)
    setTimeout(() => {
      if (!modal.classList.contains('hidden')) focusable.focus();
    }, 40);
}
function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  updateModalState();
  const opener = modalOpeners.get(modal);
  if (opener?.isConnected && opener.getClientRects().length > 0) {
    opener.focus({ preventScroll: true });
  } else {
    const menuToggle = $('#menuToggle');
    if (menuToggle?.getClientRects().length) menuToggle.focus({ preventScroll: true });
  }
}
function phoneDigits(value) {
  let n = String(value || '').replace(/\D/g, '');
  if ((n.length === 12 || n.length === 13) && n.startsWith('55')) n = n.slice(2);
  return n;
}
function normalizeCustomerPhone(value) {
  return BookingRules.canonicalPhone(value);
}
// Máscara (31) 99999-8888 enquanto digita; números internacionais (com +) ficam como o cliente digitou.
function maskBrazilianPhone(input) {
  if (input.value.trim().startsWith('+')) return;
  const d = phoneDigits(input.value).slice(0, 11);
  if (d.length <= 2) input.value = d.length ? `(${d}` : '';
  else if (d.length <= 6) input.value = `(${d.slice(0, 2)}) ${d.slice(2)}`;
  else if (d.length <= 10) input.value = `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  else input.value = `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}
// Dia sugerido ao abrir o formulário: o próximo dia em que a barbearia abre (nunca domingo).
function firstBookableDate(from = localDateString()) {
  let date = addDays(from, 1);
  const weekday = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
  while (weekday(date) === 0) date = addDays(date, 1);
  return date;
}
function getService(id) {
  return state.services.find((s) => Number(s.id) === Number(id));
}

async function loadServices() {
  const services = await api('/api/services');
  state.services = services;
  const serviceOptions =
    '<option value="">Selecione um serviço</option>' +
    services
      .map(
        (s) =>
          `<option value="${s.id}">${escapeHtml(s.nome)} — ${money(s.preco)} · ${s.duracao_minutos} min</option>`
      )
      .join('');
  $('#serviceSelect').innerHTML = serviceOptions;
  $('#adminBookingService').innerHTML = serviceOptions;
  const timeLabel = (mins) =>
    `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  const timeOptions = (firstMinute) =>
    Array.from({ length: 21 }, (_, i) => {
      const time = timeLabel(firstMinute + i * 30);
      return `<option value="${time}">${time}</option>`;
    }).join('');
  $('#blockTime').innerHTML = timeOptions(9 * 60);
  $('#blockEndTime').innerHTML = '<option value="">Selecione o fim</option>' + timeOptions(9 * 60 + 30);
}
function setupDateLimits() {
  const today = localDateString();
  const maxDate = addDays(today, 30);
  ['appointmentDate', 'adminFrom', 'adminTo', 'blockDate', 'holidayDate', 'adminBookingDate'].forEach(
    (id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.min = today;
      el.max = maxDate;
    }
  );
  // Hoje continua selecionável (o servidor aceita até 10 min de antecedência), mas o formulário abre no próximo dia útil.
  $('#appointmentDate').value = firstBookableDate(today);
  $('#adminFrom').value = localDateString();
  $('#adminTo').value = addDays(localDateString(), 6);
  $('#blockDate').value = localDateString();
  $('#holidayDate').value = addDays(localDateString(), 1);
  $('#adminBookingDate').value = localDateString();
  $('#blockDate').max = '';
  $('#holidayDate').max = '';
}

export {
  $,
  $$,
  BookingRules,
  state,
  localDateString,
  addDays,
  formatDate,
  money,
  escapeHtml,
  api,
  showToast,
  setBusy,
  openModal,
  closeModal,
  normalizeCustomerPhone,
  maskBrazilianPhone,
  firstBookableDate,
  getService,
  loadServices,
  setupDateLimits
};
