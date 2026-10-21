import { $, api } from './core.js';

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

export { loadAvailableSlots };
