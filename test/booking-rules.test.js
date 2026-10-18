const test = require('node:test');
const assert = require('node:assert/strict');
const BookingRules = require('../public/booking-rules.js');

const complete = {
  nome: 'Mateus Magalhães',
  telefone: '(31) 99999-8888',
  email: 'mateus@example.com',
  servico: '1',
  data: '2026-10-20',
  hora: '09:30'
};

test('aceita celular, fixo e número internacional com +', () => {
  assert.equal(BookingRules.isValidPhone('(31) 99999-8888'), true, 'celular');
  assert.equal(BookingRules.isValidPhone('31 99999 8888'), true, 'celular com espaços');
  assert.equal(BookingRules.isValidPhone('(31) 3333-4444'), true, 'fixo');
  assert.equal(BookingRules.isValidPhone('+1 415 555 0123'), true, 'Estados Unidos');
  assert.equal(BookingRules.isValidPhone('+351 912 345 678'), true, 'Portugal');
});

test('celular de 11 dígitos precisa do 9 logo depois do DDD (DDD + 9 + 8 dígitos)', () => {
  assert.equal(BookingRules.isValidPhone('(31) 99999-8888'), true);
  assert.equal(BookingRules.isValidPhone('(31) 88887-7777'), false, 'sem o 9 após o DDD');
  assert.equal(BookingRules.isValidPhone('(31) 79999-8888'), false, 'sem o 9 após o DDD');
  assert.equal(BookingRules.isValidPhone('+55 (31) 88887-7777'), false, 'com +55 vale a mesma regra');
  assert.equal(BookingRules.isValidPhone('+55 (31) 99999-8888'), true);
});

test('recusa telefone curto, com dígitos demais, DDD inexistente e vazio', () => {
  assert.equal(BookingRules.isValidPhone('(31) 999'), false, 'faltam dígitos');
  assert.equal(BookingRules.isValidPhone('(31) 999999-8888'), false, 'sobram dígitos');
  assert.equal(BookingRules.isValidPhone('(30) 99999-8888'), false, 'DDD 30 não existe');
  assert.equal(BookingRules.isValidPhone('+123'), false, 'internacional curto demais');
  assert.equal(BookingRules.isValidPhone('+1234567890123456'), false, 'internacional longo demais');
  assert.equal(BookingRules.isValidPhone(''), false);
  assert.equal(BookingRules.isValidPhone(undefined), false);
});

test('forma canônica: brasileiro só com dígitos e sem 55; internacional com +', () => {
  assert.equal(BookingRules.canonicalPhone('(31) 99999-8888'), '31999998888');
  assert.equal(BookingRules.canonicalPhone('+55 (31) 99999-8888'), '31999998888');
  assert.equal(BookingRules.canonicalPhone('5531999998888'), '31999998888');
  assert.equal(BookingRules.canonicalPhone('+1 415 555 0123'), '+14155550123');
});

test('formatação de exibição respeita fixo, celular e internacional', () => {
  assert.equal(BookingRules.formatPhone('31999998888'), '(31) 99999-8888');
  assert.equal(BookingRules.formatPhone('3133334444'), '(31) 3333-4444');
  assert.equal(BookingRules.formatPhone('+14155550123'), '+14155550123');
});

test('e-mail precisa ter usuário, @ e domínio', () => {
  assert.equal(BookingRules.isValidEmail('cliente@example.com'), true);
  assert.equal(BookingRules.isValidEmail('  cliente@example.com  '), true);
  assert.equal(BookingRules.isValidEmail('cliente@'), false);
  assert.equal(BookingRules.isValidEmail('sem-arroba.com'), false);
});

test('formulário completo não tem pendências', () => {
  assert.deepEqual(BookingRules.missingBookingFields(complete), []);
});

test('lista as pendências na ordem do formulário, com o id do campo para destacar', () => {
  const missing = BookingRules.missingBookingFields({});
  assert.deepEqual(missing.map(item => item.id), [
    'clientName', 'clientPhone', 'clientEmail', 'serviceSelect', 'appointmentDate', 'appointmentTime'
  ]);
  assert.ok(missing.every(item => item.label && item.message), 'cada pendência traz rótulo e mensagem');
});

test('telefone inválido aponta somente o campo do telefone', () => {
  const missing = BookingRules.missingBookingFields({ ...complete, telefone: '(31) 999' });
  assert.deepEqual(missing.map(item => item.id), ['clientPhone']);
});

test('nome de uma letra só ainda conta como pendente', () => {
  const missing = BookingRules.missingBookingFields({ ...complete, nome: ' A ' });
  assert.deepEqual(missing.map(item => item.id), ['clientName']);
});
