'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readConfig } = require('../src/config');
const { createDatabase } = require('../src/database');
const { createBookingService } = require('../src/booking');

function setup(context) {
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T12:00:00.000Z') });
  const db = createDatabase(readConfig({ DB_PATH: ':memory:', ADMIN_PASSWORD: 'test-only-password' }));
  context.after(() => db.close());
  const booking = createBookingService(db);
  const credentials = { email: 'limite@example.com' };
  const appointment = booking.createAppointment({
    nome: 'Cliente Limite',
    telefone: '31988887777',
    ...credentials,
    data: '2026-10-21',
    hora: '11:00',
    servico_id: 1
  });
  return { db, booking, credentials, appointment };
}

test('remarcar e cancelar são permitidos exatamente duas horas antes', (context) => {
  const { booking, credentials, appointment } = setup(context);
  const updated = booking.rescheduleAppointment(appointment.id, {
    ...credentials,
    data: '2026-10-21',
    hora: '11:00',
    servico_id: 1
  });
  assert.equal(updated.hora, '11:00');
  booking.cancelAppointment(appointment.id, credentials);
  assert.equal(booking.getAppointment(appointment.id).status, 'cancelado');
});

test('um milissegundo após o limite recusa alterações e mantém o registro intacto', (context) => {
  const { db, booking, credentials, appointment } = setup(context);
  const original = db.prepare('SELECT * FROM agendamentos WHERE id=?').get(appointment.id);
  context.mock.timers.tick(1);
  assert.throws(
    () =>
      booking.rescheduleAppointment(appointment.id, {
        ...credentials,
        data: '2026-10-21',
        hora: '13:00',
        servico_id: 1
      }),
    /menos de 2 horas/
  );
  assert.throws(() => booking.cancelAppointment(appointment.id, credentials), /menos de 2 horas/);
  assert.deepEqual(db.prepare('SELECT * FROM agendamentos WHERE id=?').get(appointment.id), original);
});
