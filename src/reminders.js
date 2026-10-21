'use strict';


const nodemailer = require('nodemailer');
const { TIME_ZONE, pad, localToday, startUtc } = require('./calendar');
const REMINDER_DELIVERY_WINDOW_MS = 15 * 60_000;
const REMINDERS = [
  { type: '24h', sentColumn: 'lembrete_24h_enviado_em', thresholdMs: 24 * 60 * 60_000 },
  { type: '3h', sentColumn: 'lembrete_3h_enviado_em', thresholdMs: 3 * 60 * 60_000 }
];

function shouldSendReminder(appointment, type, now = Date.now()) {
  const thresholdMs = REMINDERS.find(reminder => reminder.type === type)?.thresholdMs;
  if (!thresholdMs) return false;
  const startMs = Date.parse(appointment.starts_at_utc);
  const programmedAt = Date.parse(appointment.programado_em || appointment.atualizado_em || appointment.criado_em);
  const timeUntilStart = startMs - now;
  const bookingLeadTime = startMs - programmedAt;
  return Number.isFinite(startMs) && Number.isFinite(programmedAt)
    && bookingLeadTime >= thresholdMs
    && timeUntilStart <= thresholdMs
    && timeUntilStart > thresholdMs - REMINDER_DELIVERY_WINDOW_MS;
}

function createMailer(config) {
  return config.SMTP_CONFIGURED ? nodemailer.createTransport({
    host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_SECURE,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000
  }) : null;
}

function createReminderService({ db, config, mailer = createMailer(config), clock = Date.now }) {
  const { EMAIL_FROM, PUBLIC_URL } = config;
  function htmlEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  }
  function formattedAppointmentDate(dateStr, timeStr) {
    const instant = startUtc(dateStr, timeStr);
    return {
      date: new Intl.DateTimeFormat('pt-BR', { timeZone: TIME_ZONE, weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }).format(instant),
      time: timeStr
    };
  }
  async function sendReminderEmail(appointment, type) {
    if (!mailer || !appointment.cliente_email) return false;
    const when = formattedAppointmentDate(appointment.data_agendamento, appointment.hora_agendamento);
    const isDayBefore = type === '24h';
    const localTodayString = localToday(new Date(clock()));
    const dayAfterToday = new Date(`${localTodayString}T12:00:00Z`); dayAfterToday.setUTCDate(dayAfterToday.getUTCDate() + 1);
    const tomorrowString = `${dayAfterToday.getUTCFullYear()}-${pad(dayAfterToday.getUTCMonth() + 1)}-${pad(dayAfterToday.getUTCDate())}`;
    const dayBeforeTitle = appointment.data_agendamento === tomorrowString ? 'Seu horário é amanhã!' : 'Seu atendimento está chegando!';
    const title = isDayBefore ? dayBeforeTitle : 'Faltam cerca de 3 horas para seu horário!';
    const subject = isDayBefore ? 'Lembrete: sua visita à Barbearia do Semá está chegando' : 'Lembrete: seu horário na Barbearia do Semá é daqui a 3 horas';
    const name = htmlEscape(appointment.cliente_nome);
    const service = htmlEscape(appointment.servico_nome);
    const date = htmlEscape(when.date);
    const time = htmlEscape(when.time);
    const site = htmlEscape(PUBLIC_URL);
    const plain = `Olá, ${appointment.cliente_nome}!\n\n${title}\nServiço: ${appointment.servico_nome}\nData: ${when.date}\nHorário: ${when.time}\n\nAtenção: o cancelamento pelo site só pode ser feito até 2 horas antes do horário marcado.\n\nBarbearia do Semá\nRua Tiradentes, 377, Itacolomi, Sabará/MG\n${PUBLIC_URL}`;
    const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f1e9;font-family:Arial,sans-serif;color:#282b24"><div style="max-width:560px;margin:24px auto;padding:32px;background:#fffdf8;border:1px solid #e3ddcf;border-radius:16px"><p style="letter-spacing:2px;font-size:11px;color:#a8783f;font-weight:bold">BARBEARIA DO SEMÁ · SABARÁ/MG</p><h1 style="font-size:27px;line-height:1.2">${htmlEscape(title)}</h1><p>Olá, <strong>${name}</strong>! Passando para lembrar do seu atendimento:</p><div style="padding:20px;background:#f4f1e9;border-radius:10px;margin:22px 0"><p style="margin:0 0 8px"><strong>Serviço:</strong> ${service}</p><p style="margin:0 0 8px"><strong>Data:</strong> ${date}</p><p style="margin:0"><strong>Horário:</strong> ${time}</p></div><p style="padding:14px;border-left:4px solid #b9874d;background:#faf4e9"><strong>Importante:</strong> o cancelamento pelo site só pode ser feito até 2 horas antes do horário marcado.</p><p>Até lá! Estamos te esperando.</p><p style="margin-top:28px;font-size:12px;color:#777">Rua Tiradentes, 377 · Itacolomi · Sabará/MG<br><a href="${site}" style="color:#946a36">Acessar a Barbearia do Semá</a></p></div></body></html>`;
    await mailer.sendMail({ from: EMAIL_FROM, to: appointment.cliente_email, subject, text: plain, html });
    return true;
  }
  let reminderJobRunning = false;
  const findAppointment = db.prepare(`SELECT a.*,s.nome AS servico_nome FROM agendamentos a
    JOIN servicos s ON s.id=a.servico_id WHERE a.id=? AND a.status IN ('agendado','presente')`);

  async function sendDueReminder(id, { type, sentColumn }) {
    // Um envio SMTP cede a execução: cancelamentos e remarcações podem ocorrer nesse intervalo.
    const appointment = findAppointment.get(id);
    if (!appointment || appointment[sentColumn] || !shouldSendReminder(appointment, type, clock())) return;
    try {
      if (await sendReminderEmail(appointment, type)) {
        // Confirma apenas a programação enviada, preservando os lembretes de uma eventual remarcação.
        db.prepare(`UPDATE agendamentos SET ${sentColumn}=? WHERE id=? AND ${sentColumn} IS NULL
          AND programado_em IS ? AND starts_at_utc=? AND status IN ('agendado','presente')`)
          .run(new Date(clock()).toISOString(), id, appointment.programado_em, appointment.starts_at_utc);
      }
    } catch (error) {
      console.error(`[lembretes] Falha no lembrete de ${type} do agendamento ${id}:`, error.message);
    }
  }

  async function dispatchDueReminders() {
    if (!mailer || reminderJobRunning) return;
    reminderJobRunning = true;
    try {
      const now = clock();
      const appointments = db.prepare(`SELECT id FROM agendamentos WHERE status IN ('agendado','presente')
        AND cliente_email IS NOT NULL AND trim(cliente_email) != '' AND starts_at_utc > ?
        ORDER BY starts_at_utc,id`).all(new Date(now).toISOString());
      for (const { id } of appointments) {
        for (const reminder of REMINDERS) await sendDueReminder(id, reminder);
      }
    } finally { reminderJobRunning = false; }
  }

  return { dispatchDueReminders };
}

module.exports = { createReminderService, shouldSendReminder };
