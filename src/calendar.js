'use strict';

const { HttpError } = require('./http');

const TIME_ZONE = 'America/Sao_Paulo';
const SLOT_MINUTES = 30;
const OPENING_MINUTES = 9 * 60;
const CLOSING_MINUTES = 19 * 60 + 30;
const MIN_BOOKING_NOTICE_MS = 10 * 60_000;

const pad = n => String(n).padStart(2, '0');
const minutesOf = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const timeLabel = minutes => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
function ensureCalendarDate(value, message = 'Informe uma data válida.') {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new HttpError(400, message);
  const [year, month, day] = match.slice(1).map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) throw new HttpError(400, message);
}
const localToday = (date = new Date()) => { const p = localParts(date); return `${p.year}-${p.month}-${p.day}`; };
function localParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}
function localToUtc(dateStr, timeStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const desired = Date.UTC(y, mo - 1, d, h, mi, 0);
  let guess = desired;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(guess));
    const represented = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    guess += desired - represented;
  }
  return new Date(guess);
}
function utcToLocal(iso) {
  const p = localParts(new Date(iso));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
function startUtc(dateStr, timeStr) { return localToUtc(dateStr, timeStr); }
function durationSlots(mins) { return Math.ceil(Number(mins) / 30); }
function isValidTimeFormat(t) { return /^([01]\d|2[0-3]):(00|30)$/.test(String(t || '')); }
function hasMinimumBookingNotice(start, now = Date.now()) {
  const startMs = start instanceof Date ? start.getTime() : new Date(start).getTime();
  return Number.isFinite(startMs) && startMs - now >= MIN_BOOKING_NOTICE_MS;
}

module.exports = { TIME_ZONE, SLOT_MINUTES, OPENING_MINUTES, CLOSING_MINUTES, MIN_BOOKING_NOTICE_MS, pad, minutesOf, timeLabel, ensureCalendarDate, localToday, localToUtc, utcToLocal, startUtc, durationSlots, isValidTimeFormat, hasMinimumBookingNotice };
