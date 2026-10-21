'use strict';

const { HttpError, catchRoute, deleteById } = require('../http');
const {
  OPENING_MINUTES,
  CLOSING_MINUTES,
  pad,
  minutesOf,
  localToday,
  localToUtc,
  ensureCalendarDate,
  isValidTimeFormat,
  timeLabel
} = require('../calendar');

function registerAdminRoutes(app, { db, booking, auth, config }) {
  const { requireAdmin, login } = auth;
  const {
    cleanText,
    getService,
    getAppointment,
    publicAppointment,
    ensureDate,
    freeSlots,
    createAppointment
  } = booking;
  app.post('/admin/login', catchRoute(login));
  app.get(
    '/admin/available-slots/:data/:service_id',
    requireAdmin,
    catchRoute((req, res) => {
      const date = req.params.data;
      const service = getService(req.params.service_id);
      ensureDate(date, { allowToday: true });
      if (!service) throw new HttpError(404, 'Serviço não encontrado.');
      res.json({ data: date, service_id: service.id, slots: freeSlots(date, service) });
    })
  );

  app.post(
    '/admin/appointments',
    requireAdmin,
    catchRoute((req, res) => {
      const appointment = createAppointment(req.body, { admin: true });
      res.status(201).json({
        message: 'Agendamento criado pelo painel.',
        lembretes_email_ativos: config.SMTP_CONFIGURED,
        agendamento: appointment
      });
    })
  );

  app.get(
    '/admin/appointments',
    requireAdmin,
    catchRoute((req, res) => {
      const from = req.query.de ? String(req.query.de) : localToday();
      const to = req.query.ate ? String(req.query.ate) : from;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to)
        throw new HttpError(400, 'Período inválido.');
      ensureCalendarDate(from, 'Período inválido.');
      ensureCalendarDate(to, 'Período inválido.');
      const rows = db
        .prepare(
          `SELECT a.*,s.nome AS servico_nome,s.preco_cents FROM agendamentos a JOIN servicos s ON s.id=a.servico_id WHERE a.data_agendamento BETWEEN ? AND ? ORDER BY a.data_agendamento,a.hora_agendamento`
        )
        .all(from, to);
      res.json({
        agendamentos: rows.map(publicAppointment),
        feriados: db.prepare('SELECT * FROM feriados WHERE data BETWEEN ? AND ? ORDER BY data').all(from, to),
        bloqueios: db
          .prepare('SELECT * FROM horarios_bloqueados WHERE data BETWEEN ? AND ? ORDER BY data,hora')
          .all(from, to)
      });
    })
  );
  app.post(
    '/admin/appointments/:id/confirm',
    requireAdmin,
    catchRoute((req, res) => {
      const a = getAppointment(req.params.id);
      if (!a) throw new HttpError(404, 'Agendamento não encontrado.');
      if (a.status === 'cancelado')
        throw new HttpError(400, 'Não é possível confirmar um agendamento cancelado.');
      db.prepare(`UPDATE agendamentos SET status='presente' WHERE id=?`).run(a.id);
      res.json({ message: 'Presença pré-confirmada.', agendamento: publicAppointment(getAppointment(a.id)) });
    })
  );
  app.post(
    '/admin/appointments/:id/cancel',
    requireAdmin,
    catchRoute((req, res) => {
      const a = getAppointment(req.params.id);
      if (!a) throw new HttpError(404, 'Agendamento não encontrado.');
      if (a.status === 'cancelado') throw new HttpError(400, 'Este agendamento já está cancelado.');
      const reason = cleanText(req.body.motivo, 180) || 'Cancelado pela barbearia';
      db.prepare(
        `UPDATE agendamentos SET status='cancelado',motivo_cancelamento=?,atualizado_em=? WHERE id=?`
      ).run(reason, new Date().toISOString(), a.id);
      res.json({ message: 'Agendamento cancelado.' });
    })
  );
  app.post(
    '/admin/block-slots',
    requireAdmin,
    catchRoute((req, res) => {
      const date = String(req.body.data || '');
      ensureCalendarDate(date);
      const startTime = String(req.body.hora || '');
      const startMinutes = isValidTimeFormat(startTime) ? minutesOf(startTime) : -1;
      if (!isValidTimeFormat(startTime) || startMinutes < OPENING_MINUTES || startMinutes >= CLOSING_MINUTES)
        throw new HttpError(400, 'Escolha um horário de início entre 09h e 19h, de meia em meia hora.');
      const endTime = String(req.body.hora_fim || '');
      const endMinutes = endTime ? (isValidTimeFormat(endTime) ? minutesOf(endTime) : -1) : startMinutes + 30;
      if (
        endMinutes <= startMinutes ||
        endMinutes > CLOSING_MINUTES ||
        (endTime && !isValidTimeFormat(endTime))
      )
        throw new HttpError(400, 'O horário final deve ser posterior ao inicial e não ultrapassar 19h30.');
      const reason = cleanText(req.body.motivo, 140) || 'Horário bloqueado pelo barbeiro';
      const blockRange = db.transaction(() => {
        const rangeStart = localToUtc(date, startTime).getTime();
        const endLabel = timeLabel(endMinutes);
        const rangeEnd = localToUtc(date, endLabel).getTime();
        const appointments = db
          .prepare(
            "SELECT hora_agendamento,duracao_minutos FROM agendamentos WHERE data_agendamento=? AND status!='cancelado'"
          )
          .all(date);
        for (const appointment of appointments) {
          const appointmentStart = localToUtc(date, appointment.hora_agendamento).getTime();
          const appointmentEnd = appointmentStart + appointment.duracao_minutos * 60_000;
          if (rangeStart < appointmentEnd && rangeEnd > appointmentStart)
            throw new HttpError(
              409,
              'Essa faixa coincide com um atendimento já agendado. Cancele ou reorganize o atendimento antes de bloquear.'
            );
        }
        const insert = db.prepare(
          `INSERT INTO horarios_bloqueados (data,hora,motivo) VALUES (?,?,?) ON CONFLICT(data,hora) DO UPDATE SET motivo=excluded.motivo`
        );
        for (let minutes = startMinutes; minutes < endMinutes; minutes += 30) {
          insert.run(date, `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`, reason);
        }
      });
      blockRange.immediate();
      const count = (endMinutes - startMinutes) / 30;
      res.status(201).json({ message: count === 1 ? 'Horário bloqueado.' : `${count} horários bloqueados.` });
    })
  );
  app.delete(
    '/admin/block-slots/:id',
    requireAdmin,
    deleteById(db, 'horarios_bloqueados', 'Bloqueio não encontrado.', 'Bloqueio removido.')
  );
  app.post(
    '/admin/holidays',
    requireAdmin,
    catchRoute((req, res) => {
      const date = String(req.body.data || '');
      const reason = cleanText(req.body.motivo, 140) || 'Feriado';
      ensureCalendarDate(date);
      db.prepare(
        'INSERT INTO feriados (data,motivo) VALUES (?,?) ON CONFLICT(data) DO UPDATE SET motivo=excluded.motivo'
      ).run(date, reason);
      res.status(201).json({ message: 'Feriado cadastrado.' });
    })
  );
  app.delete(
    '/admin/holidays/:id',
    requireAdmin,
    deleteById(db, 'feriados', 'Feriado não encontrado.', 'Feriado removido.')
  );
}

module.exports = { registerAdminRoutes };
