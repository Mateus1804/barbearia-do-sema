'use strict';

const { HttpError, catchRoute } = require('../http');
const { TIME_ZONE, durationSlots } = require('../calendar');

function registerCustomerRoutes(app, { db, booking, config }) {
  const {
    createAppointment,
    rescheduleAppointment,
    cancelAppointment,
    listCustomerAppointments,
    getService,
    publicAppointment,
    ensureDate,
    freeSlots,
    validCustomerAuth
  } = booking;
  app.get('/api/health', (req, res) =>
    res.json({ ok: true, timezone: TIME_ZONE, service: 'Barbearia do Semá API' })
  );
  app.get('/api/services', (req, res) => {
    const services = db
      .prepare('SELECT id,nome,preco_cents,duracao_minutos,descricao FROM servicos ORDER BY id')
      .all();
    res.json(
      services.map((s) => ({
        id: s.id,
        nome: s.nome,
        preco: s.preco_cents / 100,
        duracao_minutos: s.duracao_minutos,
        slots: durationSlots(s.duracao_minutos),
        descricao: s.descricao
      }))
    );
  });

  app.get(
    '/api/available-slots/:data/:service_id',
    catchRoute((req, res) => {
      const date = req.params.data;
      const service = getService(req.params.service_id);
      ensureDate(date, { allowToday: true });
      if (!service) throw new HttpError(404, 'Serviço não encontrado.');
      res.json({ data: date, service_id: service.id, slots: freeSlots(date, service) });
    })
  );

  app.post(
    '/api/appointments',
    catchRoute((req, res) => {
      const appointment = createAppointment(req.body);
      res.status(201).json({
        message: 'Agendamento realizado!',
        lembretes_email_ativos: config.SMTP_CONFIGURED,
        agendamento: appointment
      });
    })
  );

  app.post(
    '/api/authenticate',
    catchRoute((req, res) => {
      const auth = validCustomerAuth(req.body.telefone, req.body.email);
      if (!auth.ok) throw new HttpError(401, 'Informe um telefone ou e-mail cadastrado e confira os dados.');
      const rows = listCustomerAppointments(auth);
      res.json({ agendamentos: rows.map(publicAppointment) });
    })
  );

  app.put(
    '/api/appointments/:id',
    catchRoute((req, res) => {
      const appointment = rescheduleAppointment(req.params.id, req.body);
      res.json({ message: 'Agendamento atualizado.', agendamento: appointment });
    })
  );
  app.delete(
    '/api/appointments/:id',
    catchRoute((req, res) => {
      cancelAppointment(req.params.id, req.body);
      res.json({ message: 'Agendamento cancelado.' });
    })
  );
}

module.exports = { registerCustomerRoutes };
