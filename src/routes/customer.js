'use strict';

const { HttpError, catchRoute } = require('../http');
const { TIME_ZONE, durationSlots, startUtc } = require('../calendar');

function registerCustomerRoutes(app, { db, booking, config }) {
  const { createAppointment, listCustomerAppointments, getService, getAppointment, publicAppointment, ensureDate, freeSlots, validateBookable, validCustomerAuth, customerOwnsAppointment, hasOverlap } = booking;
  app.get('/api/health', (req, res) => res.json({ ok: true, timezone: TIME_ZONE, service: 'Barbearia do Semá API' }));
  app.get('/api/services', (req, res) => {
    const services = db.prepare('SELECT id,nome,preco_cents,duracao_minutos,descricao FROM servicos ORDER BY id').all();
    res.json(services.map(s => ({ id: s.id, nome: s.nome, preco: s.preco_cents / 100, duracao_minutos: s.duracao_minutos, slots: durationSlots(s.duracao_minutos), descricao: s.descricao })));
  });

  app.get('/api/available-slots/:data/:service_id', catchRoute((req, res) => {
    const date = req.params.data;
    const service = getService(req.params.service_id);
    ensureDate(date, { allowToday: true });
    if (!service) throw new HttpError(404, 'Serviço não encontrado.');
    res.json({ data: date, service_id: service.id, slots: freeSlots(date, service) });
  }));


  app.post('/api/appointments', catchRoute((req, res) => {
    const appointment = createAppointment(req.body);
    res.status(201).json({ message: 'Agendamento realizado!', lembretes_email_ativos: config.SMTP_CONFIGURED, agendamento: appointment });
  }));

  app.post('/api/authenticate', catchRoute((req, res) => {
    const auth = validCustomerAuth(req.body.telefone, req.body.email);
    if (!auth.ok) throw new HttpError(401, 'Informe um telefone ou e-mail cadastrado e confira os dados.');
    const rows = listCustomerAppointments(auth);
    res.json({ agendamentos: rows.map(publicAppointment) });
  }));

  app.put('/api/appointments/:id', catchRoute((req, res) => {
    const auth = validCustomerAuth(req.body.telefone, req.body.email);
    if (!auth.ok) throw new HttpError(401, 'Informe um telefone ou e-mail cadastrado e confira os dados.');
    const old = getAppointment(req.params.id);
    if (!old || !customerOwnsAppointment(old, auth)) throw new HttpError(404, 'Agendamento não encontrado.');
    if (old.status === 'cancelado') throw new HttpError(400, 'Este agendamento já foi cancelado.');
    if (startUtc(old.data_agendamento, old.hora_agendamento).getTime() - Date.now() < 2 * 60 * 60_000) throw new HttpError(400, 'Não é possível editar faltando menos de 2 horas para o horário marcado.');
    const service = getService(req.body.servico_id);
    const date = String(req.body.data || ''); const time = String(req.body.hora || '');
    validateBookable({ date, time, service, ignoreId: old.id });
    const update = db.transaction(() => {
      if (hasOverlap(date, time, service.duracao_minutos, old.id)) throw new HttpError(409, 'Esse horário acabou de ficar indisponível. Escolha outro horário.');
      const scheduleUpdatedAt = new Date().toISOString();
      db.prepare(`UPDATE agendamentos SET servico_id=?,data_agendamento=?,hora_agendamento=?,starts_at_utc=?,duracao_minutos=?,atualizado_em=?,programado_em=?,lembrete_24h_enviado_em=NULL,lembrete_3h_enviado_em=NULL WHERE id=?`).run(service.id, date, time, startUtc(date, time).toISOString(), service.duracao_minutos, scheduleUpdatedAt, scheduleUpdatedAt, old.id);
    });
    update();
    res.json({ message: 'Agendamento atualizado.', agendamento: publicAppointment(getAppointment(old.id)) });
  }));

  app.delete('/api/appointments/:id', catchRoute((req, res) => {
    const auth = validCustomerAuth(req.body.telefone, req.body.email);
    if (!auth.ok) throw new HttpError(401, 'Informe um telefone ou e-mail cadastrado e confira os dados.');
    const a = getAppointment(req.params.id);
    if (!a || !customerOwnsAppointment(a, auth)) throw new HttpError(404, 'Agendamento não encontrado.');
    if (a.status === 'cancelado') throw new HttpError(400, 'Este agendamento já foi cancelado.');
    if (startUtc(a.data_agendamento, a.hora_agendamento).getTime() - Date.now() < 2 * 60 * 60_000) throw new HttpError(400, 'Não é possível cancelar faltando menos de 2 horas para o horário marcado.');
    db.prepare(`UPDATE agendamentos SET status='cancelado',motivo_cancelamento=?,atualizado_em=? WHERE id=?`).run('Cancelado pelo cliente', new Date().toISOString(), a.id);
    res.json({ message: 'Agendamento cancelado.' });
  }));
}

module.exports = { registerCustomerRoutes };
