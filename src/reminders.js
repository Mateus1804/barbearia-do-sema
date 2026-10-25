'use strict';

const nodemailer = require('nodemailer');
const { createHash, randomUUID } = require('node:crypto');
const { TIME_ZONE, pad, localToday, localToUtc } = require('./calendar');
const REMINDER_DELIVERY_WINDOW_MS = 15 * 60_000;
const REMINDERS = [
  { type: '24h', sentColumn: 'lembrete_24h_enviado_em', thresholdMs: 24 * 60 * 60_000 },
  { type: '3h', sentColumn: 'lembrete_3h_enviado_em', thresholdMs: 3 * 60 * 60_000 }
];

function shouldSendReminder(appointment, type, now = Date.now()) {
  const thresholdMs = REMINDERS.find((reminder) => reminder.type === type)?.thresholdMs;
  if (!thresholdMs) return false;
  const startMs = Date.parse(appointment.starts_at_utc);
  const programmedAt = Date.parse(
    appointment.programado_em || appointment.atualizado_em || appointment.criado_em
  );
  const timeUntilStart = startMs - now;
  const bookingLeadTime = startMs - programmedAt;
  return (
    Number.isFinite(startMs) &&
    Number.isFinite(programmedAt) &&
    bookingLeadTime >= thresholdMs &&
    timeUntilStart <= thresholdMs &&
    timeUntilStart > thresholdMs - REMINDER_DELIVERY_WINDOW_MS
  );
}

function createMailer(config) {
  return config.SMTP_CONFIGURED
    ? nodemailer.createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_SECURE,
        auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 30000
      })
    : null;
}

function createReminderService({ db, config, mailer = createMailer(config), clock = Date.now }) {
  const { EMAIL_FROM, PUBLIC_URL } = config;
  function htmlEscape(value) {
    return String(value ?? '').replace(
      /[&<>"']/g,
      (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
    );
  }
  function formattedAppointmentDate(dateStr, timeStr) {
    const instant = localToUtc(dateStr, timeStr);
    return {
      date: new Intl.DateTimeFormat('pt-BR', {
        timeZone: TIME_ZONE,
        weekday: 'long',
        day: '2-digit',
        month: 'long',
        year: 'numeric'
      }).format(instant),
      time: timeStr
    };
  }
  async function sendReminderEmail(appointment, type) {
    if (!mailer || !appointment.cliente_email) return false;
    const when = formattedAppointmentDate(appointment.data_agendamento, appointment.hora_agendamento);
    const isDayBefore = type === '24h';
    const localTodayString = localToday(new Date(clock()));
    const dayAfterToday = new Date(`${localTodayString}T12:00:00Z`);
    dayAfterToday.setUTCDate(dayAfterToday.getUTCDate() + 1);
    const tomorrowString = `${dayAfterToday.getUTCFullYear()}-${pad(dayAfterToday.getUTCMonth() + 1)}-${pad(dayAfterToday.getUTCDate())}`;
    const dayBeforeTitle =
      appointment.data_agendamento === tomorrowString
        ? 'Seu horário é amanhã!'
        : 'Seu atendimento está chegando!';
    const title = isDayBefore ? dayBeforeTitle : 'Faltam cerca de 3 horas para seu horário!';
    const subject = isDayBefore
      ? 'Lembrete: sua visita à Barbearia do Semá está chegando'
      : 'Lembrete: seu horário na Barbearia do Semá é daqui a 3 horas';
    const name = htmlEscape(appointment.cliente_nome);
    const service = htmlEscape(appointment.servico_nome);
    const date = htmlEscape(when.date);
    const time = htmlEscape(when.time);
    const site = htmlEscape(PUBLIC_URL);
    const plain = `Olá, ${appointment.cliente_nome}!\n\n${title}\nServiço: ${appointment.servico_nome}\nData: ${when.date}\nHorário: ${when.time}\n\nAtenção: o cancelamento pelo site só pode ser feito até 2 horas antes do horário marcado.\n\nBarbearia do Semá\nRua Tiradentes, 377, Itacolomi, Sabará/MG\n${PUBLIC_URL}`;
    const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f1e9;font-family:Arial,sans-serif;color:#282b24"><div style="max-width:560px;margin:24px auto;padding:32px;background:#fffdf8;border:1px solid #e3ddcf;border-radius:16px"><p style="letter-spacing:2px;font-size:11px;color:#a8783f;font-weight:bold">BARBEARIA DO SEMÁ · SABARÁ/MG</p><h1 style="font-size:27px;line-height:1.2">${htmlEscape(title)}</h1><p>Olá, <strong>${name}</strong>! Passando para lembrar do seu atendimento:</p><div style="padding:20px;background:#f4f1e9;border-radius:10px;margin:22px 0"><p style="margin:0 0 8px"><strong>Serviço:</strong> ${service}</p><p style="margin:0 0 8px"><strong>Data:</strong> ${date}</p><p style="margin:0"><strong>Horário:</strong> ${time}</p></div><p style="padding:14px;border-left:4px solid #b9874d;background:#faf4e9"><strong>Importante:</strong> o cancelamento pelo site só pode ser feito até 2 horas antes do horário marcado.</p><p>Até lá! Estamos te esperando.</p><p style="margin-top:28px;font-size:12px;color:#777">Rua Tiradentes, 377 · Itacolomi · Sabará/MG<br><a href="${site}" style="color:#946a36">Acessar a Barbearia do Semá</a></p></div></body></html>`;
    const messageId = '<' + createHash('sha256').update(JSON.stringify([appointment.id, type, appointment.programado_em, appointment.starts_at_utc])).digest('hex') + '@barbearia-do-sema.local>';
    await mailer.sendMail({ from: EMAIL_FROM, to: appointment.cliente_email, subject, text: plain, html, messageId });
    return true;
  }
  let reminderJobRunning = false;
  const findAppointment = db.prepare("SELECT a.*,s.nome AS servico_nome FROM agendamentos a JOIN servicos s ON s.id=a.servico_id WHERE a.id=? AND a.status IN ('agendado','presente')");
  const paused = () => !config.REMINDERS_ENABLED ||
    db.prepare("SELECT value FROM operational_flags WHERE key='reminders_paused'").get()?.value === '1';
  const keyFor = (appointment, type) => [appointment.id, type, appointment.programado_em, appointment.starts_at_utc];
  const deadline = (appointment, type) => Date.parse(appointment.starts_at_utc) -
    REMINDERS.find(item => item.type === type).thresholdMs + REMINDER_DELIVERY_WINDOW_MS;
  const finishStatement = db.prepare("UPDATE reminder_deliveries SET status=?,owner=NULL,lease_until=NULL,retry_at=?,sent_at=?,error_code=? WHERE appointment_id=? AND kind=? AND scheduled_at=? AND starts_at_utc=? AND status='SENDING' AND owner=?");
  const claim = db.transaction((id, reminder) => {
    const appointment = findAppointment.get(id);
    if (paused() || !appointment || !appointment.cliente_email?.trim() ||
        appointment[reminder.sentColumn] || !shouldSendReminder(appointment, reminder.type, clock())) return null;
    const key = keyFor(appointment, reminder.type);
    db.prepare("INSERT OR IGNORE INTO reminder_deliveries(appointment_id,kind,scheduled_at,starts_at_utc,status) VALUES (?,?,?,?,'PENDING')").run(...key);
    const owner = randomUUID();
    const now = new Date(clock()).toISOString();
    const acquired = db.prepare("UPDATE reminder_deliveries SET status='SENDING',owner=?,lease_until=?,retry_at=NULL,attempts=attempts+1 WHERE appointment_id=? AND kind=? AND scheduled_at=? AND starts_at_utc=? AND attempts < 5 AND ((status='PENDING' AND (retry_at IS NULL OR retry_at<=?)) OR (status='SENDING' AND lease_until<=?))")
      .run(owner, new Date(clock() + 120000).toISOString(), ...key, now, now);
    if (!acquired.changes) return null;
    const delivery = db.prepare("SELECT attempts FROM reminder_deliveries WHERE appointment_id=? AND kind=? AND scheduled_at=? AND starts_at_utc=?").get(...key);
    return { appointment, key, owner, attempts: delivery.attempts };
  });

  function expirePending() {
    const pending = db.prepare("SELECT * FROM reminder_deliveries WHERE status='PENDING'").all();
    const expire = db.prepare("UPDATE reminder_deliveries SET status='EXPIRED',retry_at=NULL WHERE appointment_id=? AND kind=? AND scheduled_at=? AND starts_at_utc=? AND status='PENDING'");
    for (const delivery of pending) {
      const current = findAppointment.get(delivery.appointment_id);
      if (!current || current.programado_em !== delivery.scheduled_at ||
          current.starts_at_utc !== delivery.starts_at_utc || deadline(current, delivery.kind) <= clock())
        expire.run(delivery.appointment_id, delivery.kind, delivery.scheduled_at, delivery.starts_at_utc);
    }
  }

  async function sendDueReminder(id, reminder) {
    const acquired = claim.immediate(id, reminder);
    if (!acquired) return;
    const { appointment, key, owner, attempts } = acquired;
    const finish = (status, retryAt = null, sentAt = null, code = null) =>
      finishStatement.run(status, retryAt, sentAt, code, ...key, owner);
    const current = findAppointment.get(id);
    if (paused() || !current || current.programado_em !== appointment.programado_em ||
        current.starts_at_utc !== appointment.starts_at_utc || !shouldSendReminder(current, reminder.type, clock())) {
      finish('EXPIRED');
      return;
    }
    const heartbeat = setInterval(() => {
      try {
        db.prepare("UPDATE reminder_deliveries SET lease_until=? WHERE appointment_id=? AND kind=? AND scheduled_at=? AND starts_at_utc=? AND status='SENDING' AND owner=?")
          .run(new Date(clock() + 120000).toISOString(), ...key, owner);
      } catch { console.error('[lembretes] Não foi possível renovar a reserva do envio.'); }
    }, 30000);
    heartbeat.unref();
    try {
      let sent;
      try { sent = await sendReminderEmail(current, reminder.type); }
      catch (error) {
        const next = clock() + Math.min(60000 * 2 ** (attempts - 1), 300000);
        const retry = attempts < 5 && next < deadline(current, reminder.type);
        const code = /^[A-Z0-9_]{1,40}$/.test(error.code || '') ? error.code : 'SMTP_ERROR';
        finish(retry ? 'PENDING' : 'EXPIRED', retry ? new Date(next).toISOString() : null, null, code);
        console.error('[lembretes] Falha no envio ' + reminder.type + ' do agendamento ' + id + ': ' + code);
        return;
      }
      if (!sent) { finish('EXPIRED'); return; }
      // A conclusão é atômica, sem marcar como enviada uma programação posterior.
      db.transaction(() => {
        const at = new Date(clock()).toISOString();
        if (!finish('SENT', null, at).changes) return;
        db.prepare('UPDATE agendamentos SET ' + reminder.sentColumn + "=? WHERE id=? AND " +
          reminder.sentColumn + " IS NULL AND programado_em IS ? AND starts_at_utc=? AND status IN ('agendado','presente')")
          .run(at, id, appointment.programado_em, appointment.starts_at_utc);
      }).immediate();
    } finally { clearInterval(heartbeat); }
  }

  async function dispatchDueReminders() {
    if (!mailer || reminderJobRunning || paused()) return;
    reminderJobRunning = true;
    try {
      expirePending();
      const appointments = db.prepare("SELECT id FROM agendamentos WHERE status IN ('agendado','presente') AND cliente_email IS NOT NULL AND trim(cliente_email) != '' AND starts_at_utc > ? ORDER BY starts_at_utc,id")
        .all(new Date(clock()).toISOString());
      for (const { id } of appointments) {
        for (const reminder of REMINDERS) await sendDueReminder(id, reminder);
      }
    } finally { reminderJobRunning = false; }
  }

  return { dispatchDueReminders };
}

module.exports = { createReminderService, shouldSendReminder };
