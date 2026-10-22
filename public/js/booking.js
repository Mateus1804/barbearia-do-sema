import {
  $,
  $$,
  BookingRules,
  state,
  getService,
  showToast,
  setBusy,
  normalizeCustomerPhone,
  firstBookableDate,
  api,
  money,
  escapeHtml,
  formatDate,
  maskBrazilianPhone
} from './core.js';
import { loadAvailableSlots } from './availability.js';

const BOOKING_FIELD_IDS = [
  'clientName',
  'clientPhone',
  'clientEmail',
  'serviceSelect',
  'appointmentDate',
  'appointmentTime'
];
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
  const missingById = new Map(missing.map((item) => [item.id, item]));

  BOOKING_FIELD_IDS.forEach((id) => {
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
    panel.classList.toggle(
      'has-errors',
      BOOKING_FIELD_IDS.some((id) => document.getElementById(id).classList.contains('field-invalid'))
    );
    $('#requirementsTitle').textContent = missing.length
      ? 'Falta preencher para agendar'
      : 'Tudo certo! Confira os dados e confirme seu agendamento.';
    // Só redesenha quando algo mudou: trocar os botões no meio de um clique faria o clique se perder.
    const html = missing
      .map(
        (item) =>
          `<li><button type="button" class="requirement-item" data-focus-field="${item.id}" title="${escapeHtml(item.message)}" aria-label="${escapeHtml(`${item.label}: ${item.message}`)}"><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.message)}</span></button></li>`
      )
      .join('');
    if (list.dataset.rendered !== html) {
      list.innerHTML = html;
      list.dataset.rendered = html;
    }
    list.classList.toggle('hidden', missing.length === 0);
  }
  return missing;
}
function updateBookingSummary() {
  const service = getService($('#serviceSelect').value);
  $('#summaryService').textContent = service
    ? `${service.nome} · ${service.duracao_minutos} min`
    : 'Selecione um serviço';
  $('#summaryPrice').textContent = service ? money(service.preco) : '—';
  $('#bookingSummary').classList.toggle('summary-selected', !!service);
  updateBookingStep();
}
async function submitBooking(event) {
  event.preventDefault();
  const button = $('#submitBooking');
  const body = {
    nome: $('#clientName').value.trim(),
    telefone: normalizeCustomerPhone($('#clientPhone').value),
    email: $('#clientEmail').value.trim().toLowerCase(),
    servico_id: Number($('#serviceSelect').value),
    data: $('#appointmentDate').value,
    hora: $('#appointmentTime').value,
    whatsapp: $('#clientWhatsapp')?.checked || false
  };
  BOOKING_FIELD_IDS.forEach((id) => {
    document.getElementById(id).dataset.touched = 'true';
  });
  const missing = updateBookingStep();
  if (missing.length) {
    showToast(`Ainda falta preencher: ${missing.map((item) => item.label).join(', ')}.`, 'error');
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
    $('#successDetails').innerHTML =
      `<strong>${escapeHtml(data.agendamento.servico)}</strong><br>${escapeHtml(formatDate(data.agendamento.data))} às ${escapeHtml(data.agendamento.hora)}<br>${escapeHtml(data.agendamento.nome)} · ${money(data.agendamento.preco)}<br><small>${escapeHtml(body.email)}</small>`;
    $('#bookingSuccess').dataset.phone = body.telefone;
    $('#bookingSuccess').dataset.email = body.email;
    state.customerAuth = { telefone: body.telefone, email: body.email };
    $('#reminderSetupNotice').textContent = data.lembretes_email_ativos
      ? 'Você receberá lembretes por e-mail 24 horas e 3 horas antes do atendimento. O cancelamento pelo site pode ser feito até 2 horas antes do horário marcado.'
      : 'Seu agendamento está salvo, mas os lembretes por e-mail ainda não estão ativos porque a barbearia precisa configurar o serviço de envio. O cancelamento pelo site pode ser feito até 2 horas antes do horário marcado.';
    showToast('Agendamento realizado com sucesso!');
    $('#bookingSuccess').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}
function bindBookingForm() {
  $('#serviceSelect').addEventListener('change', async () => {
    updateBookingSummary();
    await loadAvailableSlots($('#appointmentDate').value, $('#serviceSelect').value);
  });
  $('#appointmentDate').addEventListener('change', () =>
    loadAvailableSlots($('#appointmentDate').value, $('#serviceSelect').value)
  );
  $('#bookingForm').addEventListener('submit', submitBooking);
  BOOKING_FIELD_IDS.forEach((id) => {
    const input = document.getElementById(id);
    input.addEventListener('blur', () => {
      input.dataset.touched = 'true';
      updateBookingStep();
    });
    input.addEventListener('input', updateBookingStep);
    input.addEventListener('change', updateBookingStep);
  });
  $('#clientPhone').addEventListener('input', (e) => {
    maskBrazilianPhone(e.target);
    updateBookingStep();
  });
  // Clicar numa pendência leva direto ao campo que falta.
  const goToRequirement = (e) => {
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
  $('#newBooking').addEventListener('click', () => {
    $('#bookingSuccess').classList.add('hidden');
    $('#bookingForm').classList.remove('hidden');
    $('#bookingForm').reset();
    BOOKING_FIELD_IDS.forEach((id) => {
      delete document.getElementById(id).dataset.touched;
    });
    $('#appointmentDate').value = firstBookableDate();
    $('#appointmentTime').innerHTML = '<option value="">Escolha serviço e data</option>';
    $('#appointmentTime').disabled = true;
    updateBookingSummary();
    $('#bookingForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $$('.service-book').forEach((btn) =>
    btn.addEventListener('click', () => {
      $('#serviceSelect').value = btn.dataset.service;
      updateBookingSummary();
      loadAvailableSlots($('#appointmentDate').value, $('#serviceSelect').value);
      document.querySelector('#agendar').scrollIntoView({ behavior: 'smooth' });
    })
  );
}

export { bindBookingForm, updateBookingStep, updateBookingSummary };
