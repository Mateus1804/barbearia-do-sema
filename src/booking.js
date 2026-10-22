'use strict';

const BookingRules = require('../public/booking-rules');
const { HttpError } = require('./http');
const {
  SLOT_MINUTES,
  OPENING_MINUTES,
  CLOSING_MINUTES,
  pad,
  minutesOf,
  timeLabel,
  ensureCalendarDate,
  localToday,
  localToUtc,
  isValidTimeFormat,
  hasMinimumBookingNotice
} = require('./calendar');

function createBookingService(db) {
  function normalizePhone(input) {
    return BookingRules.canonicalPhone(input);
  }
  function validPhone(input) {
    return BookingRules.isValidPhone(input);
  }
  function formatPhone(input) {
    return BookingRules.formatPhone(input);
  }
  function cleanText(value, maxLength = 120) {
    return String(value ?? '')
      .trim()
      .replace(/[<>]/g, '')
      .slice(0, maxLength);
  }
  function normalizeEmail(input) {
    return cleanText(input, 160).toLowerCase();
  }
  function validEmail(input) {
    return BookingRules.isValidEmail(input);
  }
  function registerCustomer({ name, phone, email, now = new Date().toISOString() }) {
    db.prepare(
      `INSERT INTO clientes (cliente_nome,cliente_telefone,cliente_email,criado_em,atualizado_em) VALUES (?,?,?,?,?)
      ON CONFLICT(cliente_telefone,cliente_email) DO UPDATE SET cliente_nome=excluded.cliente_nome, atualizado_em=excluded.atualizado_em`
    ).run(name, phone, email, now, now);
  }
  function getService(id) {
    return db
      .prepare('SELECT id,nome,preco_cents,duracao_minutos,descricao FROM servicos WHERE id=?')
      .get(Number(id));
  }
  function getAppointment(id) {
    return db
      .prepare(
        `SELECT a.*, s.nome AS servico_nome, s.preco_cents AS preco_cents FROM agendamentos a JOIN servicos s ON s.id=a.servico_id WHERE a.id=?`
      )
      .get(Number(id));
  }
  function publicAppointment(appointment) {
    return {
      id: appointment.id,
      nome: appointment.cliente_nome,
      telefone: formatPhone(appointment.cliente_telefone),
      telefone_normalizado: appointment.cliente_telefone,
      email: appointment.cliente_email || null,
      servico_id: appointment.servico_id,
      servico: appointment.servico_nome,
      preco: appointment.preco_cents / 100,
      data: appointment.data_agendamento,
      hora: appointment.hora_agendamento,
      duracao_minutos: appointment.duracao_minutos,
      status: appointment.status,
      motivo_cancelamento: appointment.motivo_cancelamento || null,
      whatsapp: !!appointment.telefone_whatsapp,
      criado_em: appointment.criado_em
    };
  }
  function ensureDate(dateStr, { allowToday = false } = {}) {
    ensureCalendarDate(dateStr);
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    const today = localToday();
    if (dateStr < today || (!allowToday && dateStr === today))
      throw new HttpError(400, 'Escolha uma data futura.');
    const max = new Date(`${today}T12:00:00Z`);
    max.setUTCDate(max.getUTCDate() + 30);
    const maxDate = `${max.getUTCFullYear()}-${pad(max.getUTCMonth() + 1)}-${pad(max.getUTCDate())}`;
    if (dateStr > maxDate)
      throw new HttpError(400, 'Os agendamentos podem ser feitos com até 30 dias de antecedência.');
    if (date.getUTCDay() === 0)
      throw new HttpError(400, 'A barbearia fecha aos domingos. Escolha outro dia.');
    if (db.prepare('SELECT 1 FROM feriados WHERE data=?').get(dateStr))
      throw new HttpError(400, 'A barbearia não atende nesta data. Escolha outro dia.');
    return date;
  }
  function hasOverlap(dateStr, timeStr, durationMinutes, ignoreId = null) {
    const start = localToUtc(dateStr, timeStr).getTime();
    const end = start + durationMinutes * 60_000;
    const appointments = db
      .prepare(
        `SELECT id,hora_agendamento,duracao_minutos FROM agendamentos WHERE data_agendamento=? AND status!='cancelado' ${ignoreId ? 'AND id != ?' : ''}`
      )
      .all(...(ignoreId ? [dateStr, ignoreId] : [dateStr]));
    for (const appointment of appointments) {
      const otherStart = localToUtc(dateStr, appointment.hora_agendamento).getTime();
      const otherEnd = otherStart + appointment.duracao_minutos * 60_000;
      if (start < otherEnd && end > otherStart) return true;
    }
    // Bloqueios manuais ocupam cada intervalo de 30 minutos tocado pelo serviço.
    const blocks = db.prepare('SELECT hora FROM horarios_bloqueados WHERE data=?').all(dateStr);
    for (const block of blocks) {
      const blockStart = localToUtc(dateStr, block.hora).getTime();
      if (start < blockStart + SLOT_MINUTES * 60_000 && end > blockStart) return true;
    }
    // O almoço é fixo e independe de bloqueios cadastrados no painel.
    const lunchStart = localToUtc(dateStr, '12:00').getTime();
    const lunchEnd = localToUtc(dateStr, '13:00').getTime();
    if (start < lunchEnd && end > lunchStart) return true;
    return false;
  }
  function freeSlots(date, service) {
    const slots = [];
    for (
      let minutes = OPENING_MINUTES;
      minutes + service.duracao_minutos <= CLOSING_MINUTES;
      minutes += SLOT_MINUTES
    ) {
      const time = timeLabel(minutes);
      if (hasMinimumBookingNotice(localToUtc(date, time)) && !hasOverlap(date, time, service.duracao_minutos))
        slots.push(time);
    }
    return slots;
  }
  function validateBookable({ date, time, service, ignoreId = null }) {
    ensureDate(date, { allowToday: true });
    if (!service) throw new HttpError(400, 'Selecione um serviço válido.');
    if (!isValidTimeFormat(time)) throw new HttpError(400, 'Selecione um horário válido.');
    const minsFromMidnight = minutesOf(time);
    if (minsFromMidnight < OPENING_MINUTES || minsFromMidnight >= CLOSING_MINUTES)
      throw new HttpError(400, 'O horário precisa estar entre 09h e 19h30.');
    if (minsFromMidnight + service.duracao_minutos > CLOSING_MINUTES)
      throw new HttpError(400, 'Esse serviço ultrapassa o horário de fechamento.');
    const start = localToUtc(date, time);
    if (!hasMinimumBookingNotice(start))
      throw new HttpError(400, 'O agendamento precisa ser feito com pelo menos 10 minutos de antecedência.');
    if (hasOverlap(date, time, service.duracao_minutos, ignoreId))
      throw new HttpError(409, 'Esse horário acabou de ficar indisponível. Escolha outro horário.');
  }
  function validCustomerAuth(phoneInput, emailInput) {
    const hasPhone = String(phoneInput ?? '').trim() !== '';
    const hasEmail = String(emailInput ?? '').trim() !== '';
    const phone = hasPhone ? normalizePhone(phoneInput) : '';
    const email = hasEmail ? normalizeEmail(emailInput) : '';
    if ((!hasPhone && !hasEmail) || (hasPhone && !validPhone(phone)) || (hasEmail && !validEmail(email))) {
      return { ok: false, phone, email };
    }
    let customer;
    if (hasPhone && hasEmail) {
      customer = db
        .prepare('SELECT id FROM clientes WHERE cliente_telefone=? AND cliente_email=? COLLATE NOCASE')
        .get(phone, email);
    } else if (hasPhone) {
      customer = db.prepare('SELECT id FROM clientes WHERE cliente_telefone=?').get(phone);
    } else {
      customer = db.prepare('SELECT id FROM clientes WHERE cliente_email=? COLLATE NOCASE').get(email);
    }
    return customer ? { ok: true, phone, email } : { ok: false, phone, email };
  }
  function customerOwnsAppointment(appointment, auth) {
    if (auth.phone && auth.email) {
      return (
        appointment.cliente_telefone === auth.phone &&
        normalizeEmail(appointment.cliente_email) === auth.email
      );
    }
    if (auth.phone) return appointment.cliente_telefone === auth.phone;
    if (auth.email) return normalizeEmail(appointment.cliente_email) === auth.email;
    return false;
  }

  function createAppointment(body, { admin = false } = {}) {
    const name = cleanText(body.nome, 80);
    const phone = normalizePhone(body.telefone);
    const whatsapp = body.whatsapp === true || body.whatsapp === 'true' ? 1 : 0;
    const email = normalizeEmail(body.email);
    const service = getService(body.servico_id);
    const date = String(body.data || '');
    const time = String(body.hora || '');
    if (name.length < 2)
      throw new HttpError(400, admin ? 'Informe o nome do cliente.' : 'Informe seu nome completo.');
    if (!validPhone(phone))
      throw new HttpError(
        400,
        'Informe um fixo ou celular com DDD, ou um número internacional começando com +.'
      );
    if (!validEmail(email))
      throw new HttpError(
        400,
        admin
          ? 'Informe um e-mail válido para que os lembretes possam ser enviados.'
          : 'Informe um e-mail válido para cadastrar seu contato e receber os lembretes.'
      );
    validateBookable({ date, time, service });
    const now = new Date().toISOString();
    let id;
    const create = db.transaction(() => {
      if (hasOverlap(date, time, service.duracao_minutos))
        throw new HttpError(409, 'Esse horário acabou de ficar indisponível. Escolha outro horário.');
      registerCustomer({ name, phone, email, now });
      const result = db
        .prepare(
          `INSERT INTO agendamentos (cliente_nome,cliente_telefone,cliente_email,servico_id,data_agendamento,hora_agendamento,starts_at_utc,duracao_minutos,status,criado_em,atualizado_em,programado_em,telefone_whatsapp) VALUES (?,?,?,?,?,?,?,?, 'agendado',?,?,?,?)`
        )
        .run(
          name,
          phone,
          email,
          service.id,
          date,
          time,
          localToUtc(date, time).toISOString(),
          service.duracao_minutos,
          now,
          now,
          now,
          whatsapp
        );
      id = Number(result.lastInsertRowid);
    });
    create.immediate();
    return {
      id,
      nome: name,
      telefone: formatPhone(phone),
      whatsapp: !!whatsapp,
      email,
      servico: service.nome,
      preco: service.preco_cents / 100,
      data: date,
      hora: time,
      status: 'agendado'
    };
  }

  function requireCustomerAppointment(id, credentials, action) {
    const auth = validCustomerAuth(credentials.telefone, credentials.email);
    if (!auth.ok) throw new HttpError(401, 'Informe um telefone ou e-mail cadastrado e confira os dados.');
    const appointment = getAppointment(id);
    if (!appointment || !customerOwnsAppointment(appointment, auth))
      throw new HttpError(404, 'Agendamento não encontrado.');
    if (appointment.status === 'cancelado') throw new HttpError(400, 'Este agendamento já foi cancelado.');
    if (
      localToUtc(appointment.data_agendamento, appointment.hora_agendamento).getTime() - Date.now() <
      BookingRules.CUSTOMER_CHANGE_NOTICE_MS
    ) {
      throw new HttpError(400, `Não é possível ${action} faltando menos de 2 horas para o horário marcado.`);
    }
    return appointment;
  }

  function rescheduleAppointment(id, body) {
    const update = db.transaction(() => {
      const appointment = requireCustomerAppointment(id, body, 'editar');
      const service = getService(body.servico_id);
      const date = String(body.data || '');
      const time = String(body.hora || '');
      validateBookable({ date, time, service, ignoreId: appointment.id });
      const updatedAt = new Date().toISOString();
      db.prepare(
        `UPDATE agendamentos SET servico_id=?,data_agendamento=?,hora_agendamento=?,
        starts_at_utc=?,duracao_minutos=?,atualizado_em=?,programado_em=?,
        lembrete_24h_enviado_em=NULL,lembrete_3h_enviado_em=NULL WHERE id=?`
      ).run(
        service.id,
        date,
        time,
        localToUtc(date, time).toISOString(),
        service.duracao_minutos,
        updatedAt,
        updatedAt,
        appointment.id
      );
      return publicAppointment(getAppointment(appointment.id));
    });
    return update.immediate();
  }

  function cancelAppointment(id, body) {
    const cancel = db.transaction(() => {
      const appointment = requireCustomerAppointment(id, body, 'cancelar');
      db.prepare(
        `UPDATE agendamentos SET status='cancelado',motivo_cancelamento=?,atualizado_em=? WHERE id=?`
      ).run('Cancelado pelo cliente', new Date().toISOString(), appointment.id);
    });
    cancel.immediate();
  }

  function listCustomerAppointments(auth) {
    const conditions = [];
    const values = [];
    if (auth.phone) {
      conditions.push('a.cliente_telefone=?');
      values.push(auth.phone);
    }
    if (auth.email) {
      conditions.push('lower(a.cliente_email)=?');
      values.push(auth.email);
    }
    if (!conditions.length) return [];
    return db
      .prepare(
        `SELECT a.*,s.nome AS servico_nome,s.preco_cents FROM agendamentos a
      JOIN servicos s ON s.id=a.servico_id WHERE ${conditions.join(' AND ')}
      ORDER BY a.data_agendamento DESC,a.hora_agendamento DESC`
      )
      .all(...values);
  }

  return {
    cleanText,
    normalizeEmail,
    getService,
    getAppointment,
    publicAppointment,
    ensureDate,
    hasOverlap,
    freeSlots,
    validateBookable,
    validCustomerAuth,
    customerOwnsAppointment,
    createAppointment,
    rescheduleAppointment,
    cancelAppointment,
    listCustomerAppointments,
    validPhone,
    validEmail
  };
}

module.exports = { createBookingService };
