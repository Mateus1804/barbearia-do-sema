import { adminSession } from './session.mjs';
import { loadAvailableSlots } from './availability.js';
import {
  $,
  state,
  localDateString,
  formatDate,
  money,
  escapeHtml,
  api,
  showToast,
  setBusy,
  openModal,
  normalizeCustomerPhone,
  maskBrazilianPhone
} from './core.js';

function adminHeaders() {
  return { Authorization: `Bearer ${state.adminToken}` };
}
function setAdminView(loggedIn) {
  $('#adminLoginPanel').classList.toggle('hidden', loggedIn);
  $('#adminDashboard').classList.toggle('hidden', !loggedIn);
}
async function loginAdmin(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  setBusy(button, true, 'Entrando...');
  try {
    const data = await api('/admin/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('#adminEmail').value.trim(), senha: $('#adminPassword').value })
    });
    state.adminToken = data.token;
    const persisted = adminSession.write(data.token);
    setAdminView(true);
    await loadAdminAppointments();
    showToast(persisted ? 'Bem-vindo ao painel da barbearia.' : 'Bem-vindo ao painel. A sessão ficará apenas nesta página porque o navegador bloqueou o armazenamento.');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}
function adminStatus(status) {
  if (status === 'presente') return ['Pré-confirmada', 'present'];
  if (status === 'cancelado') return ['Cancelado', 'cancelled'];
  return ['Agendado', ''];
}
async function loadAdminAppointments() {
  if (!state.adminToken) return;
  const root = $('#adminAppointments');
  const requestId = (root.agendaRequestId = (root.agendaRequestId || 0) + 1);
  const token = state.adminToken;
  const isStale = () => root.agendaRequestId !== requestId || state.adminToken !== token;
  const from = $('#adminFrom').value || localDateString();
  const to = $('#adminTo').value || from;
  if (to < from) {
    showToast('A data final deve ser igual ou posterior à inicial.', 'error');
    return;
  }
  root.innerHTML = '<div class="empty-state">Carregando agenda...</div>';
  try {
    const data = await api(
      `/admin/appointments?de=${encodeURIComponent(from)}&ate=${encodeURIComponent(to)}`,
      { headers: adminHeaders() }
    );
    if (isStale()) return;
    const appointments = data.agendamentos || [];
    const scheduled = appointments.filter((a) => a.status === 'agendado').length;
    const attended = appointments.filter((a) => a.status === 'presente').length;
    const canceled = appointments.filter((a) => a.status === 'cancelado').length;
    $('#adminMetrics').innerHTML =
      `<div class="metric-card"><small>AGENDADOS</small><strong>${scheduled}</strong></div><div class="metric-card"><small>PRÉ-CONFIRMADOS</small><strong>${attended}</strong></div><div class="metric-card"><small>CANCELADOS</small><strong>${canceled}</strong></div>`;
    root.innerHTML = appointments.length
      ? appointments
          .map((a) => {
            const [status, cls] = adminStatus(a.status);
            return `<article class="admin-appointment" data-admin-appointment="${a.id}"><div class="admin-time">${escapeHtml(a.hora)}<div class="admin-time-date">${escapeHtml(formatDate(a.data, false))}</div></div><div class="admin-appointment-info"><strong>${escapeHtml(a.nome)} · ${escapeHtml(a.servico)}</strong><p>${escapeHtml(a.telefone)} · ${money(a.preco)}${a.email ? `<br>${escapeHtml(a.email)}` : ''}</p><span class="admin-status ${cls}">${status}</span>${a.motivo_cancelamento ? `<p>Motivo: ${escapeHtml(a.motivo_cancelamento)}</p>` : ''}</div><div class="appointment-actions">${a.status === 'agendado' ? `<button class="mini-button" data-admin-confirm="${a.id}">Pré-confirmar presença</button>` : ''}${a.status !== 'cancelado' ? `<button class="mini-button danger" data-admin-cancel="${a.id}">Cancelar</button>` : ''}</div></article>`;
          })
          .join('')
      : '<div class="empty-state">Nenhum agendamento encontrado neste período.</div>';
    renderAdminLists(data.bloqueios || [], data.feriados || []);
    await loadAdminBookingSlots();
  } catch (error) {
    if (isStale()) return;
    root.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    if (/sessão|expirada/i.test(error.message)) {
      state.adminToken = '';
      adminSession.clear();
      setAdminView(false);
    }
  }
}
function loadAdminBookingSlots() {
  return loadAvailableSlots(
    $('#adminBookingDate').value,
    $('#adminBookingService').value,
    $('#adminBookingTime'),
    $('#adminBookingHint'),
    { admin: true }
  );
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
  if (
    !payload.nome ||
    !payload.telefone ||
    !payload.email ||
    !payload.servico_id ||
    !payload.data ||
    !payload.hora
  ) {
    showToast('Preencha nome, telefone, e-mail, serviço, data e horário para criar o agendamento.', 'error');
    return;
  }
  setBusy(button, true, 'Criando...');
  try {
    const data = await api('/admin/appointments', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify(payload)
    });
    const a = data.agendamento;
    $('#adminCreatedBooking').classList.remove('hidden');
    $('#adminCreatedBooking').innerHTML =
      `<div><small>AGENDAMENTO CRIADO · CADASTRO DO CLIENTE SALVO</small><strong>${escapeHtml(a.nome)} · ${escapeHtml(a.servico)}</strong><p>${escapeHtml(formatDate(a.data))} às ${escapeHtml(a.hora)} · ${money(a.preco)}<br>${escapeHtml(a.email)}</p><p>${data.lembretes_email_ativos ? 'Lembretes por e-mail ativos.' : 'Lembretes aguardando configuração do SMTP.'}</p></div>`;
    $('#adminCreateBookingForm').reset();
    $('#adminBookingService').value = '';
    $('#adminBookingTime').innerHTML = '<option value="">Selecione serviço e data</option>';
    $('#adminBookingTime').disabled = true;
    showToast('Agendamento criado e cadastro salvo.');
    await loadAdminAppointments();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

function renderAdminLists(blocks, holidays) {
  $('#adminBlocks').innerHTML = blocks.length
    ? blocks
        .map(
          (b) =>
            `<div class="admin-list-item"><span>${escapeHtml(formatDate(b.data))} · ${escapeHtml(b.hora)}<br>${escapeHtml(b.motivo)}</span><button data-remove-block="${b.id}" title="Remover bloqueio" aria-label="Remover bloqueio"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-close"></use></svg></button></div>`
        )
        .join('')
    : '<div class="empty-state">Nenhum bloqueio no período.</div>';
  $('#adminHolidays').innerHTML = holidays.length
    ? holidays
        .map(
          (h) =>
            `<div class="admin-list-item"><span>${escapeHtml(formatDate(h.data))}<br>${escapeHtml(h.motivo)}</span><button data-remove-holiday="${h.id}" title="Remover feriado" aria-label="Remover feriado"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-close"></use></svg></button></div>`
        )
        .join('')
    : '<div class="empty-state">Nenhum dia fechado no período.</div>';
}
async function adminAction(url, body, message) {
  try {
    const data = await api(url, {
      method: 'POST',
      headers: adminHeaders(),
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    showToast(data.message || message || 'Ação concluída.');
    await loadAdminAppointments();
  } catch (error) {
    showToast(error.message, 'error');
  }
}
async function submitBlock(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  setBusy(button, true, 'Salvando...');
  try {
    const data = await api('/admin/block-slots', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({
        data: $('#blockDate').value,
        hora: $('#blockTime').value,
        hora_fim: $('#blockEndTime').value,
        motivo: $('#blockReason').value
      })
    });
    showToast(data.message);
    $('#blockReason').value = '';
    await loadAdminAppointments();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}
async function submitHoliday(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  setBusy(button, true, 'Salvando...');
  try {
    const data = await api('/admin/holidays', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ data: $('#holidayDate').value, motivo: $('#holidayReason').value })
    });
    showToast(data.message);
    $('#holidayReason').value = '';
    await loadAdminAppointments();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}
async function removeAdminItem(url, confirmText) {
  if (!confirm(confirmText)) return;
  try {
    const data = await api(url, { method: 'DELETE', headers: adminHeaders() });
    showToast(data.message);
    await loadAdminAppointments();
  } catch (error) {
    showToast(error.message, 'error');
  }
}
function openAdminModal() {
  openModal('adminModal');
  if (state.adminToken) {
    setAdminView(true);
    loadAdminAppointments();
  } else setAdminView(false);
}
function bindAdminArea() {
  $('#openAdmin').addEventListener('click', openAdminModal);
  $('#adminClientPhone').addEventListener('input', (e) => maskBrazilianPhone(e.target));
  $('#adminLoginForm').addEventListener('submit', loginAdmin);
  $('#adminLogout').addEventListener('click', () => {
    state.adminToken = '';
    adminSession.clear();
    setAdminView(false);
    $('#adminPassword').value = '';
    showToast('Você saiu do painel.');
  });
  $('#loadAdminAppointments').addEventListener('click', loadAdminAppointments);
  $('#adminFrom').addEventListener('change', () => {
    if ($('#adminTo').value < $('#adminFrom').value) $('#adminTo').value = $('#adminFrom').value;
  });
  $('#blockSlotForm').addEventListener('submit', submitBlock);
  $('#adminCreateBookingForm').addEventListener('submit', submitAdminBooking);
  $('#adminBookingService').addEventListener('change', loadAdminBookingSlots);
  $('#adminBookingDate').addEventListener('change', loadAdminBookingSlots);
  $('#holidayForm').addEventListener('submit', submitHoliday);
  $('#adminAppointments').addEventListener('click', (e) => {
    const confirmBtn = e.target.closest('[data-admin-confirm]');
    const cancelBtn = e.target.closest('[data-admin-cancel]');
    if (confirmBtn)
      adminAction(
        `/admin/appointments/${confirmBtn.dataset.adminConfirm}/confirm`,
        {},
        'Presença confirmada.'
      );
    if (cancelBtn) {
      const reason = prompt('Motivo do cancelamento (opcional):', 'Cancelado pela barbearia');
      if (reason !== null)
        adminAction(
          `/admin/appointments/${cancelBtn.dataset.adminCancel}/cancel`,
          { motivo: reason },
          'Agendamento cancelado.'
        );
    }
  });
  $('#adminBlocks').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-block]');
    if (btn)
      removeAdminItem(`/admin/block-slots/${btn.dataset.removeBlock}`, 'Remover este bloqueio de horário?');
  });
  $('#adminHolidays').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-holiday]');
    if (btn) removeAdminItem(`/admin/holidays/${btn.dataset.removeHoliday}`, 'Reabrir esta data?');
  });
}

export { bindAdminArea, setAdminView, loadAdminAppointments };
