import {
  $,
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
  maskBrazilianPhone
} from './core.js';
import { loadAvailableSlots } from './availability.js';

function statusText(status) {
  if (status === 'presente') return ['Presença pré-confirmada', 'tag-green'];
  if (status === 'cancelado') return ['Cancelado', 'tag-red'];
  return ['Agendado', ''];
}
function renderCustomerAppointments(appointments) {
  const root = $('#customerAppointments');
  if (!appointments.length) {
    root.innerHTML =
      '<div class="empty-state">Não encontramos agendamentos para esse telefone ou e-mail.</div>';
    return;
  }
  root.innerHTML = appointments
    .map((a) => {
      const [status, cls] = statusText(a.status);
      const canChange =
        a.status !== 'cancelado' &&
        new Date(`${a.data}T${a.hora}:00-03:00`).getTime() - Date.now() >=
          BookingRules.CUSTOMER_CHANGE_NOTICE_MS;
      return `<article class="customer-appointment" data-appointment-id="${a.id}">
      <div><span class="appointment-tag ${cls}">${status}</span><h3>${escapeHtml(a.servico)}</h3><p>${escapeHtml(formatDate(a.data))} · ${escapeHtml(a.hora)} · ${a.duracao_minutos} min<br>${money(a.preco)}</p>${a.motivo_cancelamento ? `<p>Motivo: ${escapeHtml(a.motivo_cancelamento)}</p>` : ''}<div class="edit-appointment-slot hidden" id="edit-slot-${a.id}"></div></div>
      <div class="appointment-actions">${canChange ? `<button class="mini-button" data-edit-appointment="${a.id}">Alterar horário</button><button class="mini-button danger" data-cancel-appointment="${a.id}">Cancelar</button>` : ''}</div>
    </article>`;
    })
    .join('');
}
async function authenticateCustomer(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const phoneInput = $('#lookupPhone').value.trim();
  const email = $('#lookupEmail').value.trim().toLowerCase();
  const phone = phoneInput ? normalizeCustomerPhone(phoneInput) : '';
  if (
    (!phone && !email) ||
    (phone && !BookingRules.isValidPhone(phone)) ||
    (email && !BookingRules.isValidEmail(email))
  ) {
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
  } catch (error) {
    $('#customerAppointments').innerHTML = '';
    showToast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}
async function startEditAppointment(id) {
  const appointment = state.customerAppointments.find((a) => Number(a.id) === Number(id));
  const slot = $(`#edit-slot-${id}`);
  if (!appointment || !slot) return;
  if (!slot.classList.contains('hidden')) {
    slot.classList.add('hidden');
    slot.innerHTML = '';
    return;
  }
  const servicesOptions = state.services
    .map(
      (s) =>
        `<option value="${s.id}" ${Number(s.id) === Number(appointment.servico_id) ? 'selected' : ''}>${escapeHtml(s.nome)} — ${money(s.preco)}</option>`
    )
    .join('');
  slot.innerHTML = `<form class="edit-booking-form" data-edit-form="${id}"><label class="field-label">Serviço</label><select class="field edit-service" required>${servicesOptions}</select><div class="edit-grid"><div><label class="field-label">Data</label><input class="field edit-date" type="date" min="${localDateString()}" max="${addDays(localDateString(), 30)}" value="${appointment.data}" required></div><div><label class="field-label">Horário</label><select class="field edit-time" required><option value="">Selecione</option></select></div></div><p class="edit-hint">Escolha uma nova data e um horário livre.</p><div class="edit-actions"><button type="submit" class="mini-button">Salvar alteração</button><button type="button" class="mini-button" data-close-edit="${id}">Voltar</button></div></form>`;
  slot.classList.remove('hidden');
  const form = slot.querySelector('form');
  const serviceSelect = $('.edit-service', form);
  const dateInput = $('.edit-date', form);
  const timeSelect = $('.edit-time', form);
  const hint = $('.edit-hint', form);
  const refresh = () => loadAvailableSlots(dateInput.value, serviceSelect.value, timeSelect, hint);
  serviceSelect.addEventListener('change', refresh);
  dateInput.addEventListener('change', refresh);
  await refresh();
  // Include the original time as an option for a no-op date/service change; server ignores this booking in overlap checks.
  if (
    dateInput.value === appointment.data &&
    ![...timeSelect.options].some((o) => o.value === appointment.hora)
  ) {
    const option = document.createElement('option');
    option.value = appointment.hora;
    option.textContent = `${appointment.hora} (atual)`;
    timeSelect.append(option);
  }
}
async function saveEditAppointment(event) {
  event.preventDefault();
  const form = event.target.closest('form[data-edit-form]');
  if (!form) return;
  const id = form.dataset.editForm;
  const auth = state.customerAuth;
  if (!auth) return;
  const button = form.querySelector('[type="submit"]');
  const payload = {
    ...auth,
    servico_id: Number($('.edit-service', form).value),
    data: $('.edit-date', form).value,
    hora: $('.edit-time', form).value
  };
  if (!payload.data || !payload.hora) {
    showToast('Escolha a nova data e o novo horário.', 'error');
    return;
  }
  setBusy(button, true, 'Salvando...');
  try {
    await api(`/api/appointments/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    const refreshed = await api('/api/authenticate', { method: 'POST', body: JSON.stringify(auth) });
    state.customerAppointments = refreshed.agendamentos || [];
    renderCustomerAppointments(state.customerAppointments);
    showToast('Agendamento alterado com sucesso.');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
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
  } catch (error) {
    showToast(error.message, 'error');
  }
}
function openCustomerModal() {
  openModal('customerModal');
  if (state.customerAuth) {
    $('#lookupPhone').value = state.customerAuth.telefone;
    $('#lookupEmail').value = state.customerAuth.email;
  }
  if (state.customerAppointments.length) renderCustomerAppointments(state.customerAppointments);
}
function bindCustomerArea() {
  $('#openMyAppointments').addEventListener('click', openCustomerModal);
  $('#successMyAppointments').addEventListener('click', () => {
    closeModal('customerModal');
    $('#lookupPhone').value = $('#bookingSuccess').dataset.phone || '';
    $('#lookupEmail').value = $('#bookingSuccess').dataset.email || '';
    openCustomerModal();
    $('#customerLoginForm').requestSubmit();
  });
  $('#lookupPhone').addEventListener('input', (e) => maskBrazilianPhone(e.target));
  $('#customerLoginForm').addEventListener('submit', authenticateCustomer);
  $('#customerAppointments').addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-edit-appointment]');
    const cancel = e.target.closest('[data-cancel-appointment]');
    const close = e.target.closest('[data-close-edit]');
    if (edit) await startEditAppointment(edit.dataset.editAppointment);
    if (cancel) await cancelCustomerAppointment(cancel.dataset.cancelAppointment);
    if (close) {
      const slot = $(`#edit-slot-${close.dataset.closeEdit}`);
      slot.classList.add('hidden');
      slot.innerHTML = '';
    }
  });
  $('#customerAppointments').addEventListener('submit', saveEditAppointment);
}

export { bindCustomerArea };
