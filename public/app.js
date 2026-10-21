import { $, state, setupDateLimits, loadServices, showToast } from './js/core.js';
import { loadAvailableSlots } from './js/availability.js';
import { bindBookingForm, updateBookingStep, updateBookingSummary } from './js/booking.js';
import { bindCustomerArea } from './js/customer.js';
import { bindAdminArea, setAdminView, loadAdminAppointments } from './js/admin.js';
import { bindPageChrome } from './js/page.js';

async function init() {
  bindPageChrome();
  bindBookingForm();
  bindCustomerArea();
  bindAdminArea();
  setupDateLimits();
  updateBookingStep();
  try { await loadServices(); updateBookingSummary(); await loadAvailableSlots($('#appointmentDate').value, $('#serviceSelect').value); }
  catch (error) { showToast('Não foi possível carregar os serviços. Atualize a página em instantes.', 'error'); }
  if (state.adminToken) {
    // Token is session-scoped in the browser. The server remains the authority and will invalidate expired tokens.
    setAdminView(true);
    loadAdminAppointments();
  }
}

document.addEventListener('DOMContentLoaded', init);
