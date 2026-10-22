import { $, api, state } from './core.js';

async function loadAvailableSlots(
  date,
  serviceId,
  selectElement = $('#appointmentTime'),
  hintElement = $('#availabilityHint'),
  { currentSlot = null, admin = false } = {}
) {
  // Se o cliente trocar serviço/data enquanto uma consulta ainda está em andamento, só a mais recente pode preencher a lista.
  const requestId = (selectElement.slotRequestId = (selectElement.slotRequestId || 0) + 1);
  const token = admin ? state.adminToken : '';
  const isStale = () => selectElement.slotRequestId !== requestId || (admin && token !== state.adminToken);
  selectElement.disabled = true;
  selectElement.innerHTML = '<option value="">Buscando horários...</option>';
  if (!date || !serviceId || (admin && !token)) {
    selectElement.innerHTML = '<option value="">Escolha serviço e data</option>';
    if (hintElement)
      hintElement.textContent = 'Selecione um serviço e uma data para ver os horários disponíveis.';
    return [];
  }
  try {
    const prefix = admin ? '/admin' : '/api';
    const result = await api(
      `${prefix}/available-slots/${encodeURIComponent(date)}/${encodeURIComponent(serviceId)}`,
      admin ? { headers: { Authorization: `Bearer ${token}` } } : {}
    );
    if (isStale()) return [];
    const slots = result.slots || [];
    if (!slots.length) {
      selectElement.innerHTML = '<option value="">Nenhum horário disponível</option>';
      selectElement.disabled = true;
      if (hintElement)
        hintElement.textContent =
          result.message || 'Não há horários livres nesta data. Experimente outro dia.';
      return [];
    }
    selectElement.innerHTML =
      '<option value="">Selecione um horário</option>' +
      slots.map((t) => `<option value="${t}">${t}</option>`).join('');
    if (currentSlot && slots.includes(currentSlot)) selectElement.value = currentSlot;
    selectElement.disabled = false;
    if (hintElement) {
      const detail = admin
        ? 'O almoço (12h–13h) e os bloqueios são respeitados.'
        : 'É possível agendar até 10 minutos antes, desde que o horário esteja disponível.';
      hintElement.textContent = `${slots.length} ${slots.length === 1 ? 'horário disponível' : 'horários disponíveis'}. ${detail}`;
    }
    return slots;
  } catch (error) {
    if (isStale()) return [];
    selectElement.innerHTML = '<option value="">Escolha outra data</option>';
    selectElement.disabled = true;
    if (hintElement) hintElement.textContent = error.message || 'Não foi possível consultar a agenda.';
    return [];
  }
}

export { loadAvailableSlots };
