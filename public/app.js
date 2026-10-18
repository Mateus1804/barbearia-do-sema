'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const TIME_ZONE = 'America/Sao_Paulo';
const state = {
  services: [],
  customerAuth: null,
  customerAppointments: [],
  adminToken: sessionStorage.getItem('sema_admin_token') || '',
  toastTimer: null
};

function localDateString(date = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const obj = Object.fromEntries(p.map(x => [x.type, x.value]));
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
  return new Date(y, m - 1, d).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', ...(includeYear ? { year: 'numeric' } : {}) });
}
function money(value) { return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }); }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
async function api(url, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  const response = await fetch(url, { ...options, headers });
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
function openModal(id) {
  const modal = document.getElementById(id);
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  const focusable = modal.querySelector('input,button,select');
  if (focusable) setTimeout(() => focusable.focus(), 40);
}
function closeModal(id) {
  document.getElementById(id)?.classList.add('hidden');
  if (!$('.modal-backdrop:not(.hidden)')) document.body.style.overflow = '';
}
function phoneDigits(value) { let n = String(value || '').replace(/\D/g, ''); if ((n.length === 12 || n.length === 13) && n.startsWith('55')) n = n.slice(2); return n; }
function normalizeCustomerPhone(value) { return BookingRules.canonicalPhone(value); }
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
  const weekday = d => new Date(`${d}T12:00:00Z`).getUTCDay();
  while (weekday(date) === 0) date = addDays(date, 1);
  return date;
}
function getService(id) { return state.services.find(s => Number(s.id) === Number(id)); }

async function loadServices() {
  const services = await api('/api/services');
  state.services = services;
  const select = $('#serviceSelect');
  select.innerHTML = '<option value="">Selecione um serviço</option>' + services.map(s => `<option value="${s.id}">${escapeHtml(s.nome)} — ${money(s.preco)} · ${s.duracao_minutos} min</option>`).join('');
  $('#adminBookingService').innerHTML = '<option value="">Selecione um serviço</option>' + services.map(s => `<option value="${s.id}">${escapeHtml(s.nome)} — ${money(s.preco)} · ${s.duracao_minutos} min</option>`).join('');
  const timeLabel = mins => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  $('#blockTime').innerHTML = Array.from({ length: 21 }, (_, i) => {
    const time = timeLabel(9 * 60 + i * 30);
    return `<option value="${time}">${time}</option>`;
  }).join('');
  $('#blockEndTime').innerHTML = '<option value="">Selecione o fim</option>' + Array.from({ length: 21 }, (_, i) => {
    const time = timeLabel(9 * 60 + 30 + i * 30);
    return `<option value="${time}">${time}</option>`;
  }).join('');
}
function setupDateLimits() {
  const today = localDateString();
  const maxDate = addDays(today, 30);
  ['appointmentDate', 'adminFrom', 'adminTo', 'blockDate', 'holidayDate', 'adminBookingDate'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.min = today;
    el.max = maxDate;
  });
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
const BOOKING_FIELD_IDS = ['clientName', 'clientPhone', 'clientEmail', 'serviceSelect', 'appointmentDate', 'appointmentTime'];
const PHONE_HINT = 'Fixo ou celular com DDD, ou número internacional começando com +.';
function bookingValues() {
  return {
    nome: $('#clientName').value,
    telefone: $('#clientPhone').value,
    email: $('#clientEmail').value,
    servico: $('#serviceSelect').value,
    data: $('#appointmentDate').value,
    hora: $('#appointmentTime').value
  };
}
// Única função que decide o que falta: pinta os campos, o informativo do telefone e o painel de pendências.
function updateBookingStep() {
  if (!$('#bookingForm')) return;
  const missing = BookingRules.missingBookingFields(bookingValues());
  const missingById = new Map(missing.map(item => [item.id, item]));

  BOOKING_FIELD_IDS.forEach(id => {
    const input = document.getElementById(id);
    const group = input.closest('.field-group') || input.closest('.select-wrap') || input;
    const touched = input.dataset.touched === 'true';
    const invalid = touched && missingById.has(id);
    input.classList.toggle('field-invalid', invalid);
    input.classList.toggle('field-valid', touched && !missingById.has(id));
    input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
    group.classList.toggle('has-field-error', invalid);
  });

  const phoneHint = $('#phoneHint');
  if (phoneHint) {
    const phoneError = $('#clientPhone').classList.contains('field-invalid');
    phoneHint.textContent = phoneError ? missingById.get('clientPhone').message : PHONE_HINT;
    phoneHint.classList.toggle('feedback-error', phoneError);
  }

  const panel = $('#bookingRequirements');
  if (panel) {
    const list = $('#requirementsList');
    panel.classList.toggle('is-blocking', missing.length > 0);
    panel.classList.toggle('is-complete', missing.length === 0);
    // Fica vermelho só depois que algum campo foi marcado como inválido (não no primeiro olhar).
    panel.classList.toggle('has-errors', BOOKING_FIELD_IDS.some(id => document.getElementById(id).classList.contains('field-invalid')));
    $('#requirementsTitle').textContent = missing.length ? 'Falta preencher para agendar' : 'Tudo certo! Confira os dados e confirme seu agendamento.';
    // Só redesenha quando algo mudou: trocar os botões no meio de um clique faria o clique se perder.
    const html = missing.map(item => `<li><button type="button" class="requirement-item" data-focus-field="${item.id}"><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.message)}</span></button></li>`).join('');
    if (list.dataset.rendered !== html) { list.innerHTML = html; list.dataset.rendered = html; }
    list.classList.toggle('hidden', missing.length === 0);
  }
  return missing;
}
function updateBookingSummary() {
  const service = getService($('#serviceSelect').value);
  $('#summaryService').textContent = service ? `${service.nome} · ${service.duracao_minutos} min` : 'Selecione um serviço';
  $('#summaryPrice').textContent = service ? money(service.preco) : '—';
  $('#bookingSummary').classList.toggle('summary-selected', !!service);
  updateBookingStep();
}
async function loadAvailableSlots(date, serviceId, selectElement = $('#appointmentTime'), hintElement = $('#availabilityHint'), { currentSlot = null } = {}) {
  // Se o cliente trocar serviço/data enquanto uma consulta ainda está em andamento, só a mais recente pode preencher a lista.
  const requestId = (selectElement.slotRequestId = (selectElement.slotRequestId || 0) + 1);
  const isStale = () => selectElement.slotRequestId !== requestId;
  selectElement.disabled = true;
  selectElement.innerHTML = '<option value="">Buscando horários...</option>';
  if (!date || !serviceId) {
    selectElement.innerHTML = '<option value="">Escolha serviço e data</option>';
    if (hintElement) hintElement.textContent = 'Selecione um serviço e uma data para ver os horários disponíveis.';
    return [];
  }
  try {
    const result = await api(`/api/available-slots/${encodeURIComponent(date)}/${encodeURIComponent(serviceId)}`);
    if (isStale()) return [];
    const slots = result.slots || [];
    if (!slots.length) {
      selectElement.innerHTML = '<option value="">Nenhum horário disponível</option>';
      selectElement.disabled = true;
      if (hintElement) hintElement.textContent = result.message || 'Não há horários livres nesta data. Experimente outro dia.';
      return [];
    }
    selectElement.innerHTML = '<option value="">Selecione um horário</option>' + slots.map(t => `<option value="${t}">${t}</option>`).join('');
    if (currentSlot && slots.includes(currentSlot)) selectElement.value = currentSlot;
    selectElement.disabled = false;
    if (hintElement) hintElement.textContent = `${slots.length} ${slots.length === 1 ? 'horário disponível' : 'horários disponíveis'}. É possível agendar até 10 minutos antes, desde que o horário esteja disponível.`;
    return slots;
  } catch (error) {
    if (isStale()) return [];
    selectElement.innerHTML = '<option value="">Escolha outra data</option>';
    selectElement.disabled = true;
    if (hintElement) hintElement.textContent = error.message || 'Não foi possível consultar a agenda.';
    return [];
  }
}

async function submitBooking(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#submitBooking');
  const body = {
    nome: $('#clientName').value.trim(),
    telefone: normalizeCustomerPhone($('#clientPhone').value),
    email: $('#clientEmail').value.trim().toLowerCase(),
    servico_id: Number($('#serviceSelect').value),
    data: $('#appointmentDate').value,
    hora: $('#appointmentTime').value,
    whatsapp: $('#clientWhatsapp').checked
  };
  BOOKING_FIELD_IDS.forEach(id => { document.getElementById(id).dataset.touched = 'true'; });
  const missing = updateBookingStep();
  if (missing.length) {
    showToast(`Ainda falta preencher: ${missing.map(item => item.label).join(', ')}.`, 'error');
    const firstInvalid = document.getElementById(missing[0].id);
    firstInvalid.focus();
    firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  setBusy(button, true, 'Reservando seu horário...');
  try {
    const data = await api('/api/appointments', { method: 'POST', body: JSON.stringify(body) });
    $('#bookingForm').classList.add('hidden');
    $('#bookingSuccess').classList.remove('hidden');
    $('#successDetails').innerHTML = `<strong>${escapeHtml(data.agendamento.servico)}</strong><br>${escapeHtml(formatDate(data.agendamento.data))} às ${escapeHtml(data.agendamento.hora)}<br>${escapeHtml(data.agendamento.nome)} · ${money(data.agendamento.preco)}<br><small>${escapeHtml(body.email)}</small>`;
    $('#bookingSuccess').dataset.phone = body.telefone;
    $('#bookingSuccess').dataset.email = body.email;
    state.customerAuth = { telefone: body.telefone, email: body.email };
    $('#reminderSetupNotice').textContent = data.lembretes_email_ativos
      ? 'Você receberá lembretes por e-mail 24 horas e 3 horas antes do atendimento. O cancelamento pelo site pode ser feito até 2 horas antes do horário marcado.'
      : 'Seu agendamento está salvo, mas os lembretes por e-mail ainda não estão ativos porque a barbearia precisa configurar o serviço de envio. O cancelamento pelo site pode ser feito até 2 horas antes do horário marcado.';
    showToast('Agendamento realizado com sucesso!');
    $('#bookingSuccess').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) { showToast(error.message, 'error'); }
  finally { setBusy(button, false); }
}

function statusText(status) {
  if (status === 'presente') return ['Presença pré-confirmada', 'tag-green'];
  if (status === 'cancelado') return ['Cancelado', 'tag-red'];
  return ['Agendado', ''];
}
function renderCustomerAppointments(appointments) {
  const root = $('#customerAppointments');
  if (!appointments.length) {
    root.innerHTML = '<div class="empty-state">Não encontramos agendamentos para esse telefone ou e-mail.</div>';
    return;
  }
  root.innerHTML = appointments.map(a => {
    const [status, cls] = statusText(a.status);
    const canChange = a.status !== 'cancelado' && new Date(`${a.data}T${a.hora}:00-03:00`).getTime() - Date.now() >= 2 * 60 * 60_000;
    return `<article class="customer-appointment" data-appointment-id="${a.id}">
      <div><span class="appointment-tag ${cls}">${status}</span><h3>${escapeHtml(a.servico)}</h3><p>${escapeHtml(formatDate(a.data))} · ${escapeHtml(a.hora)} · ${a.duracao_minutos} min<br>${money(a.preco)}</p>${a.motivo_cancelamento ? `<p>Motivo: ${escapeHtml(a.motivo_cancelamento)}</p>` : ''}<div class="edit-appointment-slot hidden" id="edit-slot-${a.id}"></div></div>
      <div class="appointment-actions">${canChange ? `<button class="mini-button" data-edit-appointment="${a.id}">Alterar horário</button><button class="mini-button danger" data-cancel-appointment="${a.id}">Cancelar</button>` : ''}</div>
    </article>`;
  }).join('');
}
async function authenticateCustomer(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const phoneInput = $('#lookupPhone').value.trim();
  const email = $('#lookupEmail').value.trim().toLowerCase();
  const phone = phoneInput ? normalizeCustomerPhone(phoneInput) : '';
  if ((!phone && !email) || (phone && !BookingRules.isValidPhone(phone)) || (email && !BookingRules.isValidEmail(email))) {
    showToast('Informe um telefone válido ou um e-mail válido. Você não precisa preencher os dois.', 'error');
    return;
  }
  setBusy(button, true, 'Consultando...');
  try {
    const auth = { telefone: phone, email };
    const data = await api('/api/authenticate', { method: 'POST', body: JSON.stringify(auth) });
    state.customerAuth = auth;
    state.customerAppointments = data.agendamentos || [];
    renderCustomerAppointments(state.customerAppointments);
    showToast('Agendamentos carregados.');
  } catch (error) { $('#customerAppointments').innerHTML = ''; showToast(error.message, 'error'); }
  finally { setBusy(button, false); }
}
async function startEditAppointment(id) {
  const appointment = state.customerAppointments.find(a => Number(a.id) === Number(id));
  const slot = $(`#edit-slot-${id}`);
  if (!appointment || !slot) return;
  if (!slot.classList.contains('hidden')) { slot.classList.add('hidden'); slot.innerHTML = ''; return; }
  const servicesOptions = state.services.map(s => `<option value="${s.id}" ${Number(s.id) === Number(appointment.servico_id) ? 'selected' : ''}>${escapeHtml(s.nome)} — ${money(s.preco)}</option>`).join('');
  slot.innerHTML = `<form class="edit-booking-form" data-edit-form="${id}" style="margin-top:13px;padding:14px;background:#f5f3ed;border:1px solid #e5e2d8"><label class="field-label">Serviço</label><select class="field edit-service" required>${servicesOptions}</select><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px"><div><label class="field-label">Data</label><input class="field edit-date" type="date" min="${localDateString()}" max="${addDays(localDateString(), 30)}" value="${appointment.data}" required></div><div><label class="field-label">Horário</label><select class="field edit-time" required><option value="">Selecione</option></select></div></div><p class="edit-hint" style="font-size:9px;color:#87887d;margin:8px 0 12px">Escolha uma nova data e um horário livre.</p><div style="display:flex;gap:8px"><button type="submit" class="mini-button">Salvar alteração</button><button type="button" class="mini-button" data-close-edit="${id}">Voltar</button></div></form>`;
  slot.classList.remove('hidden');
  const form = slot.querySelector('form');
  const serviceSelect = $('.edit-service', form); const dateInput = $('.edit-date', form); const timeSelect = $('.edit-time', form); const hint = $('.edit-hint', form);
  const refresh = () => loadAvailableSlots(dateInput.value, serviceSelect.value, timeSelect, hint);
  serviceSelect.addEventListener('change', refresh); dateInput.addEventListener('change', refresh);
  await refresh();
  // Include the original time as an option for a no-op date/service change; server ignores this booking in overlap checks.
  if (dateInput.value === appointment.data && ![...timeSelect.options].some(o => o.value === appointment.hora)) {
    const option = document.createElement('option'); option.value = appointment.hora; option.textContent = `${appointment.hora} (atual)`; timeSelect.append(option);
  }
}
async function saveEditAppointment(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.dataset.editForm;
  const auth = state.customerAuth;
  if (!auth) return;
  const button = form.querySelector('[type="submit"]');
  const payload = { ...auth, servico_id: Number($('.edit-service', form).value), data: $('.edit-date', form).value, hora: $('.edit-time', form).value };
  if (!payload.data || !payload.hora) { showToast('Escolha a nova data e o novo horário.', 'error'); return; }
  setBusy(button, true, 'Salvando...');
  try {
    await api(`/api/appointments/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    const refreshed = await api('/api/authenticate', { method: 'POST', body: JSON.stringify(auth) });
    state.customerAppointments = refreshed.agendamentos || [];
    renderCustomerAppointments(state.customerAppointments);
    showToast('Agendamento alterado com sucesso.');
  } catch (error) { showToast(error.message, 'error'); }
  finally { setBusy(button, false); }
}
async function cancelCustomerAppointment(id) {
  const auth = state.customerAuth;
  if (!auth || !confirm('Quer mesmo cancelar este agendamento?')) return;
  try {
    const data = await api(`/api/appointments/${id}`, { method: 'DELETE', body: JSON.stringify(auth) });
    const refreshed = await api('/api/authenticate', { method: 'POST', body: JSON.stringify(auth) });
    state.customerAppointments = refreshed.agendamentos || [];
    renderCustomerAppointments(state.customerAppointments);
    showToast(data.message || 'Agendamento cancelado.');
  } catch (error) { showToast(error.message, 'error'); }
}

function adminHeaders() { return { Authorization: `Bearer ${state.adminToken}` }; }
function setAdminView(loggedIn) {
  $('#adminLoginPanel').classList.toggle('hidden', loggedIn);
  $('#adminDashboard').classList.toggle('hidden', !loggedIn);
}
async function loginAdmin(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  setBusy(button, true, 'Entrando...');
  try {
    const data = await api('/admin/login', { method: 'POST', body: JSON.stringify({ email: $('#adminEmail').value.trim(), senha: $('#adminPassword').value }) });
    state.adminToken = data.token;
    sessionStorage.setItem('sema_admin_token', data.token);
    setAdminView(true);
    await loadAdminAppointments();
    showToast('Bem-vindo ao painel da barbearia.');
  } catch (error) { showToast(error.message, 'error'); }
  finally { setBusy(button, false); }
}
function adminStatus(status) { if (status === 'presente') return ['Pré-confirmada', 'present']; if (status === 'cancelado') return ['Cancelado', 'cancelled']; return ['Agendado', '']; }
async function loadAdminAppointments() {
  if (!state.adminToken) return;
  const from = $('#adminFrom').value || localDateString();
  const to = $('#adminTo').value || from;
  if (to < from) { showToast('A data final deve ser igual ou posterior à inicial.', 'error'); return; }
  const root = $('#adminAppointments');
  root.innerHTML = '<div class="empty-state">Carregando agenda...</div>';
  try {
    const data = await api(`/admin/appointments?de=${encodeURIComponent(from)}&ate=${encodeURIComponent(to)}`, { headers: adminHeaders() });
    const appointments = data.agendamentos || [];
    const scheduled = appointments.filter(a => a.status === 'agendado').length;
    const attended = appointments.filter(a => a.status === 'presente').length;
    const canceled = appointments.filter(a => a.status === 'cancelado').length;
    $('#adminMetrics').innerHTML = `<div class="metric-card"><small>AGENDADOS</small><strong>${scheduled}</strong></div><div class="metric-card"><small>PRÉ-CONFIRMADOS</small><strong>${attended}</strong></div><div class="metric-card"><small>CANCELADOS</small><strong>${canceled}</strong></div>`;
    root.innerHTML = appointments.length ? appointments.map(a => {
      const [status, cls] = adminStatus(a.status);
      return `<article class="admin-appointment" data-admin-appointment="${a.id}"><div class="admin-time">${escapeHtml(a.hora)}<div style="font:9px var(--sans);color:#85877b;margin-top:4px">${escapeHtml(formatDate(a.data, false))}</div></div><div class="admin-appointment-info"><strong>${escapeHtml(a.nome)} · ${escapeHtml(a.servico)}</strong><p>${escapeHtml(a.telefone)} · ${money(a.preco)}${a.email ? `<br>${escapeHtml(a.email)}` : ''}</p><span class="admin-status ${cls}">${status}</span>${a.motivo_cancelamento ? `<p>Motivo: ${escapeHtml(a.motivo_cancelamento)}</p>` : ''}</div><div class="appointment-actions">${a.status === 'agendado' ? `<button class="mini-button" data-admin-confirm="${a.id}">Pré-confirmar presença</button>` : ''}${a.status !== 'cancelado' ? `<button class="mini-button danger" data-admin-cancel="${a.id}">Cancelar</button>` : ''}</div></article>`;
    }).join('') : '<div class="empty-state">Nenhum agendamento encontrado neste período.</div>';
    renderAdminLists(data.bloqueios || [], data.feriados || []);
    await loadAdminBookingSlots();
  } catch (error) {
    root.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    if (/sessão|expirada/i.test(error.message)) { state.adminToken = ''; sessionStorage.removeItem('sema_admin_token'); setAdminView(false); }
  }
}
async function loadAdminBookingSlots() {
  const date = $('#adminBookingDate').value;
  const serviceId = $('#adminBookingService').value;
  const select = $('#adminBookingTime');
  const hint = $('#adminBookingHint');
  select.disabled = true;
  select.innerHTML = '<option value="">Buscando horários...</option>';
  if (!date || !serviceId || !state.adminToken) {
    select.innerHTML = '<option value="">Selecione serviço e data</option>';
    hint.textContent = 'Selecione o serviço e a data para consultar os horários livres.';
    return;
  }
  try {
    const data = await api(`/admin/available-slots/${encodeURIComponent(date)}/${encodeURIComponent(serviceId)}`, { headers: adminHeaders() });
    if (!data.slots.length) {
      select.innerHTML = '<option value="">Nenhum horário livre</option>';
      hint.textContent = 'Não há horários livres nessa data ou os horários restantes estão a menos de 2 horas.';
      return;
    }
    select.innerHTML = '<option value="">Selecione um horário</option>' + data.slots.map(t => `<option value="${t}">${t}</option>`).join('');
    select.disabled = false;
    hint.textContent = `${data.slots.length} ${data.slots.length === 1 ? 'horário livre' : 'horários livres'}. O almoço (12h–13h) e os bloqueios são respeitados.`;
  } catch (error) {
    select.innerHTML = '<option value="">Data indisponível</option>';
    hint.textContent = error.message;
  }
}
async function submitAdminBooking(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  const payload = {
    nome: $('#adminClientName').value.trim(),
    telefone: normalizeCustomerPhone($('#adminClientPhone').value),
    email: $('#adminClientEmail').value.trim().toLowerCase(),
    servico_id: Number($('#adminBookingService').value),
    data: $('#adminBookingDate').value,
    hora: $('#adminBookingTime').value
  };
  if (!payload.nome || !payload.telefone || !payload.email || !payload.servico_id || !payload.data || !payload.hora) {
    showToast('Preencha nome, telefone, e-mail, serviço, data e horário para criar o agendamento.', 'error'); return;
  }
  setBusy(button, true, 'Criando...');
  try {
    const data = await api('/admin/appointments', { method: 'POST', headers: adminHeaders(), body: JSON.stringify(payload) });
    const a = data.agendamento;
    $('#adminCreatedBooking').classList.remove('hidden');
    $('#adminCreatedBooking').innerHTML = `<div><small>AGENDAMENTO CRIADO · CADASTRO DO CLIENTE SALVO</small><strong>${escapeHtml(a.nome)} · ${escapeHtml(a.servico)}</strong><p>${escapeHtml(formatDate(a.data))} às ${escapeHtml(a.hora)} · ${money(a.preco)}<br>${escapeHtml(a.email)}</p><p>${data.lembretes_email_ativos ? 'Lembretes por e-mail ativos.' : 'Lembretes aguardando configuração do SMTP.'}</p></div>`;
    $('#adminCreateBookingForm').reset();
    $('#adminBookingService').value = ''; $('#adminBookingTime').innerHTML = '<option value="">Selecione serviço e data</option>'; $('#adminBookingTime').disabled = true;
    showToast('Agendamento criado e cadastro salvo.');
    await loadAdminAppointments();
  } catch (error) { showToast(error.message, 'error'); }
  finally { setBusy(button, false); }
}

function renderAdminLists(blocks, holidays) {
  $('#adminBlocks').innerHTML = blocks.length ? blocks.map(b => `<div class="admin-list-item"><span>${escapeHtml(formatDate(b.data))} · ${escapeHtml(b.hora)}<br>${escapeHtml(b.motivo)}</span><button data-remove-block="${b.id}" title="Remover bloqueio">×</button></div>`).join('') : '<div class="empty-state">Nenhum bloqueio no período.</div>';
  $('#adminHolidays').innerHTML = holidays.length ? holidays.map(h => `<div class="admin-list-item"><span>${escapeHtml(formatDate(h.data))}<br>${escapeHtml(h.motivo)}</span><button data-remove-holiday="${h.id}" title="Remover feriado">×</button></div>`).join('') : '<div class="empty-state">Nenhum dia fechado no período.</div>';
}
async function adminAction(url, body, message) {
  try {
    const data = await api(url, { method: 'POST', headers: adminHeaders(), ...(body ? { body: JSON.stringify(body) } : {}) });
    showToast(data.message || message || 'Ação concluída.');
    await loadAdminAppointments();
  } catch (error) { showToast(error.message, 'error'); }
}
async function submitBlock(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]'); setBusy(button, true, 'Salvando...');
  try {
    const data = await api('/admin/block-slots', { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ data: $('#blockDate').value, hora: $('#blockTime').value, hora_fim: $('#blockEndTime').value, motivo: $('#blockReason').value }) });
    showToast(data.message); $('#blockReason').value = ''; await loadAdminAppointments();
  } catch (error) { showToast(error.message, 'error'); }
  finally { setBusy(button, false); }
}
async function submitHoliday(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]'); setBusy(button, true, 'Salvando...');
  try {
    const data = await api('/admin/holidays', { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ data: $('#holidayDate').value, motivo: $('#holidayReason').value }) });
    showToast(data.message); $('#holidayReason').value = ''; await loadAdminAppointments();
  } catch (error) { showToast(error.message, 'error'); }
  finally { setBusy(button, false); }
}
async function removeAdminItem(url, confirmText) {
  if (!confirm(confirmText)) return;
  try { const data = await api(url, { method: 'DELETE', headers: adminHeaders() }); showToast(data.message); await loadAdminAppointments(); }
  catch (error) { showToast(error.message, 'error'); }
}
function openCustomerModal() {
  openModal('customerModal');
  if (state.customerAuth) {
    $('#lookupPhone').value = state.customerAuth.telefone;
    $('#lookupEmail').value = state.customerAuth.email;
  }
  if (state.customerAppointments.length) renderCustomerAppointments(state.customerAppointments);
}
function openAdminModal() {
  openModal('adminModal');
  if (state.adminToken) {
    setAdminView(true);
    loadAdminAppointments();
  } else setAdminView(false);
}


function setupScrollAnimations() {
  if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
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
  const elements = selectors.flatMap(selector => $$(selector));
  if (!elements.length) return;
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('motion-in');
      observer.unobserve(entry.target);
    });
  }, { rootMargin: '0px 0px -7% 0px', threshold: 0.12 });

  elements.forEach(element => {
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

function bindEvents() {
  setupScrollAnimations();
  $('#year').textContent = new Date().getFullYear();
  $('#menuToggle').addEventListener('click', () => {
    const open = $('#mainNav').classList.toggle('open');
    $('#menuToggle').setAttribute('aria-expanded', String(open));
  });
  $$('#mainNav a').forEach(a => a.addEventListener('click', () => { $('#mainNav').classList.remove('open'); $('#menuToggle').setAttribute('aria-expanded', 'false'); }));
  $('#openMyAppointments').addEventListener('click', openCustomerModal);
  $('#successMyAppointments').addEventListener('click', () => {
    closeModal('customerModal');
    $('#lookupPhone').value = $('#bookingSuccess').dataset.phone || '';
    $('#lookupEmail').value = $('#bookingSuccess').dataset.email || '';
    openCustomerModal();
    $('#customerLoginForm').requestSubmit();
  });
  $('#openAdmin').addEventListener('click', openAdminModal);
  $$('[data-close]').forEach(btn => btn.addEventListener('click', () => closeModal(btn.dataset.close)));
  $$('.modal-backdrop').forEach(modal => modal.addEventListener('click', e => { if (e.target === modal) closeModal(modal.id); }));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $$('.modal-backdrop:not(.hidden)').forEach(m => closeModal(m.id)); });
  $('#serviceSelect').addEventListener('change', async () => { updateBookingSummary(); await loadAvailableSlots($('#appointmentDate').value, $('#serviceSelect').value); });
  $('#appointmentDate').addEventListener('change', () => loadAvailableSlots($('#appointmentDate').value, $('#serviceSelect').value));
  $('#bookingForm').addEventListener('submit', submitBooking);
  BOOKING_FIELD_IDS.forEach(id => {
    const input = document.getElementById(id);
    input.addEventListener('blur', () => { input.dataset.touched = 'true'; updateBookingStep(); });
    input.addEventListener('input', updateBookingStep);
    input.addEventListener('change', updateBookingStep);
  });
  $('#clientPhone').addEventListener('input', e => { maskBrazilianPhone(e.target); updateBookingStep(); });
  $('#lookupPhone').addEventListener('input', e => maskBrazilianPhone(e.target));
  $('#adminClientPhone').addEventListener('input', e => maskBrazilianPhone(e.target));
  // Clicar numa pendência leva direto ao campo que falta.
  const goToRequirement = e => {
    const item = e.target.closest('[data-focus-field]');
    if (!item) return;
    // No mousedown evitamos o blur do campo atual (que redesenharia a lista antes de o clique terminar).
    if (e.type === 'mousedown') e.preventDefault();
    const field = document.getElementById(item.dataset.focusField);
    field.focus({ preventScroll: true });
    field.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  $('#requirementsList').addEventListener('mousedown', goToRequirement);
  $('#requirementsList').addEventListener('click', goToRequirement);
  $('#customerLoginForm').addEventListener('submit', authenticateCustomer);
  $('#customerAppointments').addEventListener('click', async e => {
    const edit = e.target.closest('[data-edit-appointment]');
    const cancel = e.target.closest('[data-cancel-appointment]');
    const close = e.target.closest('[data-close-edit]');
    if (edit) await startEditAppointment(edit.dataset.editAppointment);
    if (cancel) await cancelCustomerAppointment(cancel.dataset.cancelAppointment);
    if (close) { const slot = $(`#edit-slot-${close.dataset.closeEdit}`); slot.classList.add('hidden'); slot.innerHTML = ''; }
  });
  $('#customerAppointments').addEventListener('submit', saveEditAppointment);
  $('#newBooking').addEventListener('click', () => {
    $('#bookingSuccess').classList.add('hidden'); $('#bookingForm').classList.remove('hidden');
    $('#bookingForm').reset();
    BOOKING_FIELD_IDS.forEach(id => { delete document.getElementById(id).dataset.touched; });
    $('#appointmentDate').value = firstBookableDate();
    $('#appointmentTime').innerHTML = '<option value="">Escolha serviço e data</option>';
    $('#appointmentTime').disabled = true;
    updateBookingSummary();
    $('#bookingForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $('#adminLoginForm').addEventListener('submit', loginAdmin);
  $('#adminLogout').addEventListener('click', () => { state.adminToken = ''; sessionStorage.removeItem('sema_admin_token'); setAdminView(false); $('#adminPassword').value = ''; showToast('Você saiu do painel.'); });
  $('#loadAdminAppointments').addEventListener('click', loadAdminAppointments);
  $('#adminFrom').addEventListener('change', () => { if ($('#adminTo').value < $('#adminFrom').value) $('#adminTo').value = $('#adminFrom').value; });
  $('#blockSlotForm').addEventListener('submit', submitBlock);
  $('#adminCreateBookingForm').addEventListener('submit', submitAdminBooking);
  $('#adminBookingService').addEventListener('change', loadAdminBookingSlots);
  $('#adminBookingDate').addEventListener('change', loadAdminBookingSlots);
  $('#holidayForm').addEventListener('submit', submitHoliday);
  $('#adminAppointments').addEventListener('click', e => {
    const confirmBtn = e.target.closest('[data-admin-confirm]'); const cancelBtn = e.target.closest('[data-admin-cancel]');
    if (confirmBtn) adminAction(`/admin/appointments/${confirmBtn.dataset.adminConfirm}/confirm`, {}, 'Presença confirmada.');
    if (cancelBtn) {
      const reason = prompt('Motivo do cancelamento (opcional):', 'Cancelado pela barbearia');
      if (reason !== null) adminAction(`/admin/appointments/${cancelBtn.dataset.adminCancel}/cancel`, { motivo: reason }, 'Agendamento cancelado.');
    }
  });
  $('#adminBlocks').addEventListener('click', e => { const btn = e.target.closest('[data-remove-block]'); if (btn) removeAdminItem(`/admin/block-slots/${btn.dataset.removeBlock}`, 'Remover este bloqueio de horário?'); });
  $('#adminHolidays').addEventListener('click', e => { const btn = e.target.closest('[data-remove-holiday]'); if (btn) removeAdminItem(`/admin/holidays/${btn.dataset.removeHoliday}`, 'Reabrir esta data?'); });
  $$('.service-book').forEach(btn => btn.addEventListener('click', () => {
    $('#serviceSelect').value = btn.dataset.service;
    updateBookingSummary();
    loadAvailableSlots($('#appointmentDate').value, $('#serviceSelect').value);
    document.querySelector('#agendar').scrollIntoView({ behavior: 'smooth' });
  }));
}

async function init() {
  bindEvents();
  setupDateLimits();
  updateBookingStep();
  try { await loadServices(); updateBookingSummary(); await loadAvailableSlots($('#appointmentDate').value, $('#serviceSelect').value); }
  catch (error) { showToast('Não foi possível carregar os serviços. Atualize a página em instantes.', 'error'); }
  if (state.adminToken) {
    // Token is session-scoped in the browser. The server remains the authority and will invalidate expired tokens.
    setAdminView(false);
  }
}

document.addEventListener('DOMContentLoaded', init);
