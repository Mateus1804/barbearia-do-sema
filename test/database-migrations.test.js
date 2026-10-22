'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { readConfig } = require('../src/config');
const { createDatabase } = require('../src/database');

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sema-migration-'));
  const config = readConfig({
    DB_PATH: path.join(directory, 'fixture.db'),
    ADMIN_PASSWORD: 'test-only-password'
  });
  createDatabase(config).close();
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return config;
}

function insertAppointment(db) {
  db.prepare(
    `INSERT INTO agendamentos
    (id,cliente_nome,cliente_telefone,cliente_email,servico_id,data_agendamento,hora_agendamento,
     starts_at_utc,duracao_minutos,status,criado_em,atualizado_em,programado_em,
     lembrete_24h_enviado_em,lembrete_3h_enviado_em,telefone_whatsapp)
    VALUES (42,'Cliente legado','31988887777','LEGADO@example.com',1,'2026-10-22','10:00',
      '2026-10-22T13:00:00.000Z',30,'presente','2026-10-19T10:00:00.000Z','2026-10-21T10:00:00.000Z',
      '2026-10-19T10:00:00.000Z','2026-10-21T13:00:00.000Z','2026-10-22T10:00:00.000Z',1)`
  ).run();
}

test('reabrir um banco atual mantém reservas, pré-cadastro, bloqueios e dias fechados', (context) => {
  const config = fixture(context);
  const original = new Database(config.DB_PATH);
  insertAppointment(original);
  original
    .prepare("INSERT INTO horarios_bloqueados(data,hora,motivo) VALUES ('2026-10-23','14:00','Pausa')")
    .run();
  original.prepare("INSERT INTO feriados(data,motivo) VALUES ('2026-10-24','Fechado')").run();
  const expected = original.prepare('SELECT * FROM agendamentos WHERE id=42').get();
  original.close();
  const reopened = createDatabase(config);
  try {
    assert.deepEqual(reopened.prepare('SELECT * FROM agendamentos WHERE id=42').get(), expected);
    assert.equal(reopened.prepare('SELECT count(*) AS count FROM horarios_bloqueados').get().count, 1);
    assert.equal(reopened.prepare('SELECT count(*) AS count FROM feriados').get().count, 1);
    assert.equal(
      reopened.prepare('SELECT cliente_email FROM clientes').get().cliente_email,
      'legado@example.com'
    );
    assert.equal(reopened.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(reopened.pragma('foreign_key_check'), []);
  } finally {
    reopened.close();
  }
});

test('migração do código antigo preserva programação, lembretes e preferência de WhatsApp já existentes', (context) => {
  const config = fixture(context);
  const legacy = new Database(config.DB_PATH);
  legacy.exec('ALTER TABLE agendamentos ADD COLUMN confirmation_code TEXT');
  insertAppointment(legacy);
  legacy.prepare("UPDATE sqlite_sequence SET seq=100 WHERE name='agendamentos'").run();
  const expected = legacy.prepare('SELECT * FROM agendamentos WHERE id=42').get();
  delete expected.confirmation_code;
  legacy.close();
  const migrated = createDatabase(config);
  try {
    assert.deepEqual(migrated.prepare('SELECT * FROM agendamentos WHERE id=42').get(), expected);
    assert.deepEqual(migrated.pragma('foreign_key_check'), []);
    assert.equal(migrated.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(
      migrated.prepare("SELECT seq FROM sqlite_sequence WHERE name='agendamentos'").get().seq,
      100
    );
  } finally {
    migrated.close();
  }
});

test('migração de um banco sem colunas de lembrete preserva ID, contato, serviço e status', (context) => {
  const config = fixture(context);
  const legacy = new Database(config.DB_PATH);
  insertAppointment(legacy);
  legacy.exec(`ALTER TABLE agendamentos ADD COLUMN confirmation_code TEXT;
    ALTER TABLE agendamentos DROP COLUMN programado_em;
    ALTER TABLE agendamentos DROP COLUMN lembrete_24h_enviado_em;
    ALTER TABLE agendamentos DROP COLUMN lembrete_3h_enviado_em;
    ALTER TABLE agendamentos DROP COLUMN telefone_whatsapp;`);
  const expected = legacy.prepare('SELECT * FROM agendamentos WHERE id=42').get();
  delete expected.confirmation_code;
  legacy.close();
  const migrated = createDatabase(config);
  try {
    const actual = migrated.prepare('SELECT * FROM agendamentos WHERE id=42').get();
    assert.deepEqual(actual, {
      ...expected,
      programado_em: expected.atualizado_em,
      lembrete_24h_enviado_em: null,
      lembrete_3h_enviado_em: null,
      telefone_whatsapp: 0
    });
    assert.equal(
      migrated.prepare('SELECT cliente_telefone FROM clientes').get().cliente_telefone,
      '31988887777'
    );
  } finally {
    migrated.close();
  }
});
