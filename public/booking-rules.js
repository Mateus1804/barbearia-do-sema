/*
 * Regras de agendamento compartilhadas entre o navegador e o servidor.
 * Fonte única para telefone e e-mail: não duplique estas regras em outro lugar.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BookingRules = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Telefone brasileiro: DDD (11 a 99) + 8 dígitos (fixo, 10 no total)
  // ou DDD + 9 + 8 dígitos (celular, 11 no total: o terceiro dígito é sempre 9).
  const BR_PHONE = /^[1-9][1-9](?:9\d{8}|\d{8})$/;
  // Número internacional: sempre começa com "+" seguido de 8 a 15 dígitos (padrão E.164).
  const INTL_PHONE = /^\+\d{8,15}$/;
  const CUSTOMER_CHANGE_NOTICE_MS = 2 * 60 * 60_000;
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // Forma canônica guardada no banco:
  //  - brasileiro: só dígitos, sem o código 55 (ex.: 31999998888 ou 3133334444)
  //  - internacional: "+" e dígitos (ex.: +14155550123)
  function canonicalPhone(value) {
    const raw = String(value || '').trim();
    const digits = raw.replace(/\D/g, '');
    const hasBrazilCode = (digits.length === 12 || digits.length === 13) && digits.startsWith('55');
    if (raw.startsWith('+')) return hasBrazilCode ? digits.slice(2) : `+${digits}`;
    return hasBrazilCode ? digits.slice(2) : digits;
  }

  function isValidPhone(value) {
    const canonical = canonicalPhone(value);
    return BR_PHONE.test(canonical) || INTL_PHONE.test(canonical);
  }

  // Exibição amigável da forma canônica.
  function formatPhone(value) {
    const canonical = canonicalPhone(value);
    if (canonical.startsWith('+')) return canonical;
    if (canonical.length === 11)
      return `(${canonical.slice(0, 2)}) ${canonical.slice(2, 7)}-${canonical.slice(7)}`;
    if (canonical.length === 10)
      return `(${canonical.slice(0, 2)}) ${canonical.slice(2, 6)}-${canonical.slice(6)}`;
    return canonical;
  }

  function isValidEmail(value) {
    return EMAIL.test(String(value || '').trim());
  }

  // Lista, na ordem do formulário, o que ainda impede o agendamento.
  // `values` aceita: nome, telefone, email, servico, data, hora (todos em texto).
  function missingBookingFields(values = {}) {
    const missing = [];
    const add = (id, label, message) => missing.push({ id, label, message });

    if (String(values.nome || '').trim().length < 2)
      add('clientName', 'Seu nome', 'Informe seu nome completo.');
    if (!isValidPhone(values.telefone))
      add(
        'clientPhone',
        'Telefone',
        'Informe um fixo ou celular com DDD, ou um número internacional começando com +.'
      );
    if (!isValidEmail(values.email))
      add('clientEmail', 'E-mail', 'Informe um e-mail válido para receber os lembretes.');
    if (!values.servico) add('serviceSelect', 'Serviço', 'Escolha o serviço desejado.');
    if (!values.data) add('appointmentDate', 'Dia', 'Escolha o dia do atendimento.');
    if (!values.hora) add('appointmentTime', 'Horário', 'Escolha um horário livre.');

    return missing;
  }

  return {
    CUSTOMER_CHANGE_NOTICE_MS,
    canonicalPhone,
    isValidPhone,
    formatPhone,
    isValidEmail,
    missingBookingFields
  };
});
