'use strict';

const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

function createDatabase(config) {
  const { DB_PATH, ADMIN_EMAIL, ADMIN_PASSWORD } = config;
  if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // Horários e durações reais vêm do banco. Durações quebradas são arredondadas para slots de 30 minutos.
  db.exec(`
  CREATE TABLE IF NOT EXISTS servicos (
    id INTEGER PRIMARY KEY,
    nome TEXT NOT NULL UNIQUE,
    preco_cents INTEGER NOT NULL,
    duracao_minutos INTEGER NOT NULL,
    descricao TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agendamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_nome TEXT NOT NULL,
    cliente_telefone TEXT NOT NULL,
    cliente_email TEXT,
    servico_id INTEGER NOT NULL REFERENCES servicos(id),
    data_agendamento TEXT NOT NULL,
    hora_agendamento TEXT NOT NULL,
    starts_at_utc TEXT NOT NULL,
    duracao_minutos INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'agendado' CHECK(status IN ('agendado','presente','cancelado')),
    motivo_cancelamento TEXT,
    criado_em TEXT NOT NULL,
    atualizado_em TEXT NOT NULL,
    programado_em TEXT NOT NULL,
    lembrete_24h_enviado_em TEXT,
    lembrete_3h_enviado_em TEXT
  );
  CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_nome TEXT NOT NULL,
    cliente_telefone TEXT NOT NULL,
    cliente_email TEXT NOT NULL COLLATE NOCASE,
    criado_em TEXT NOT NULL,
    atualizado_em TEXT NOT NULL,
    UNIQUE(cliente_telefone, cliente_email)
  );
  CREATE TABLE IF NOT EXISTS horarios_bloqueados (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    hora TEXT NOT NULL,
    motivo TEXT NOT NULL DEFAULT 'Horário bloqueado pelo barbeiro',
    UNIQUE(data, hora)
  );
  CREATE TABLE IF NOT EXISTS feriados (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL UNIQUE,
    motivo TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    email TEXT NOT NULL,
    senha_hash TEXT NOT NULL
  );
  `);

  // Migração automática: remove o antigo código de confirmação sem apagar os agendamentos já salvos.
  function appointmentColumns() {
    return db
      .prepare('PRAGMA table_info(agendamentos)')
      .all()
      .map((column) => column.name);
  }
  const migratedFromCode = appointmentColumns().includes('confirmation_code');
  if (migratedFromCode) {
    const legacyColumns = new Set(appointmentColumns());
    // Somente nomes de colunas definidos pelo código entram nas expressões da migração.
    const legacyValue = (column, fallback) => (legacyColumns.has(column) ? column : fallback);
    const programmedAt = legacyColumns.has('programado_em')
      ? "COALESCE(NULLIF(trim(programado_em),''),atualizado_em,criado_em)"
      : 'COALESCE(atualizado_em,criado_em)';
    const migrateAppointments = db.transaction(() => {
      const previousSequence =
        db.prepare("SELECT seq FROM sqlite_sequence WHERE name='agendamentos'").get()?.seq || 0;
      db.exec(`DROP INDEX IF EXISTS idx_agendamentos_data; DROP INDEX IF EXISTS idx_agendamentos_telefone;
        DROP INDEX IF EXISTS idx_agendamentos_email;
        ALTER TABLE agendamentos RENAME TO agendamentos_com_codigo;
        CREATE TABLE agendamentos (
          id INTEGER PRIMARY KEY AUTOINCREMENT, cliente_nome TEXT NOT NULL, cliente_telefone TEXT NOT NULL, cliente_email TEXT,
          servico_id INTEGER NOT NULL REFERENCES servicos(id), data_agendamento TEXT NOT NULL, hora_agendamento TEXT NOT NULL,
          starts_at_utc TEXT NOT NULL, duracao_minutos INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'agendado' CHECK(status IN ('agendado','presente','cancelado')),
          motivo_cancelamento TEXT, criado_em TEXT NOT NULL, atualizado_em TEXT NOT NULL, programado_em TEXT NOT NULL,
          lembrete_24h_enviado_em TEXT, lembrete_3h_enviado_em TEXT,
          telefone_whatsapp INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO agendamentos (id,cliente_nome,cliente_telefone,cliente_email,servico_id,data_agendamento,hora_agendamento,starts_at_utc,duracao_minutos,status,motivo_cancelamento,criado_em,atualizado_em,programado_em,lembrete_24h_enviado_em,lembrete_3h_enviado_em,telefone_whatsapp)
        SELECT id,cliente_nome,cliente_telefone,cliente_email,servico_id,data_agendamento,hora_agendamento,starts_at_utc,duracao_minutos,status,motivo_cancelamento,criado_em,atualizado_em,${programmedAt},${legacyValue('lembrete_24h_enviado_em', 'NULL')},${legacyValue('lembrete_3h_enviado_em', 'NULL')},${legacyValue('telefone_whatsapp', '0')} FROM agendamentos_com_codigo;
        DROP TABLE agendamentos_com_codigo;`);
      db.prepare("UPDATE sqlite_sequence SET seq=max(seq,?) WHERE name='agendamentos'").run(previousSequence);
    });
    migrateAppointments();
  }
  // Garante as colunas de lembrete em bancos criados em versões intermediárias.
  const existingColumns = appointmentColumns();
  if (!existingColumns.includes('lembrete_24h_enviado_em'))
    db.exec('ALTER TABLE agendamentos ADD COLUMN lembrete_24h_enviado_em TEXT');
  if (!existingColumns.includes('lembrete_3h_enviado_em'))
    db.exec('ALTER TABLE agendamentos ADD COLUMN lembrete_3h_enviado_em TEXT');
  if (!existingColumns.includes('programado_em'))
    db.exec('ALTER TABLE agendamentos ADD COLUMN programado_em TEXT');
  if (!existingColumns.includes('telefone_whatsapp'))
    db.exec('ALTER TABLE agendamentos ADD COLUMN telefone_whatsapp INTEGER NOT NULL DEFAULT 0');
  db.exec(
    "UPDATE agendamentos SET programado_em = COALESCE(programado_em, atualizado_em, criado_em) WHERE programado_em IS NULL OR trim(programado_em) = ''"
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agendamentos_data ON agendamentos(data_agendamento, hora_agendamento);
  CREATE INDEX IF NOT EXISTS idx_agendamentos_telefone ON agendamentos(cliente_telefone);
  CREATE INDEX IF NOT EXISTS idx_agendamentos_email ON agendamentos(cliente_email);`);
  db.exec("CREATE TABLE IF NOT EXISTS operational_flags (key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  db.prepare("INSERT OR IGNORE INTO operational_flags(key,value) VALUES ('reminders_paused','0')").run();
  db.exec("CREATE TABLE IF NOT EXISTS reminder_deliveries (appointment_id INTEGER NOT NULL REFERENCES agendamentos(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('24h','3h')), scheduled_at TEXT NOT NULL, starts_at_utc TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('PENDING','SENDING','SENT','EXPIRED')), attempts INTEGER NOT NULL DEFAULT 0, owner TEXT, lease_until TEXT, retry_at TEXT, sent_at TEXT, error_code TEXT, PRIMARY KEY(appointment_id,kind,scheduled_at,starts_at_utc))");
  db.exec('CREATE INDEX IF NOT EXISTS idx_reminder_deliveries_status ON reminder_deliveries(status,retry_at)');
  // Pré-cadastra os clientes encontrados em agendamentos antigos que já tinham e-mail.
  const backfillCustomers = db.prepare(
    `INSERT INTO clientes (cliente_nome,cliente_telefone,cliente_email,criado_em,atualizado_em) VALUES (?,?,?,?,?) ON CONFLICT(cliente_telefone,cliente_email) DO UPDATE SET cliente_nome=excluded.cliente_nome, atualizado_em=excluded.atualizado_em`
  );
  for (const oldCustomer of db
    .prepare(
      `SELECT cliente_nome,cliente_telefone,cliente_email,MIN(criado_em) AS criado_em,MAX(atualizado_em) AS atualizado_em FROM agendamentos WHERE cliente_email IS NOT NULL AND trim(cliente_email) != '' GROUP BY cliente_telefone,cliente_email`
    )
    .all()) {
    backfillCustomers.run(
      oldCustomer.cliente_nome,
      oldCustomer.cliente_telefone,
      oldCustomer.cliente_email.toLowerCase(),
      oldCustomer.criado_em,
      oldCustomer.atualizado_em
    );
  }
  // Remove a tabela legada de tentativas: a consulta do cliente não usa bloqueio por telefone.
  db.exec('DROP TABLE IF EXISTS login_attempts');

  const seed = db.prepare(
    `INSERT INTO servicos (id,nome,preco_cents,duracao_minutos,descricao) VALUES (@id,@nome,@preco_cents,@duracao_minutos,@descricao) ON CONFLICT(id) DO NOTHING`
  );
  [
    {
      id: 1,
      nome: 'Corte de cabelo',
      preco_cents: 5000,
      duracao_minutos: 30,
      descricao: 'Corte na régua, do clássico ao moderno.'
    },
    {
      id: 2,
      nome: 'Barba',
      preco_cents: 3500,
      duracao_minutos: 20,
      descricao: 'Acabamento preciso e cuidado nos detalhes.'
    },
    {
      id: 3,
      nome: 'Sobrancelha',
      preco_cents: 2000,
      duracao_minutos: 15,
      descricao: 'Design limpo e natural para valorizar o olhar.'
    },
    {
      id: 4,
      nome: 'Pintura capilar',
      preco_cents: 8000,
      duracao_minutos: 60,
      descricao: 'Cor uniforme com atenção ao acabamento.'
    },
    {
      id: 5,
      nome: 'Combo corte + barba',
      preco_cents: 7500,
      duracao_minutos: 45,
      descricao: 'Visual renovado: corte e barba no mesmo atendimento.'
    }
  ].forEach((service) => seed.run(service));
  const adminHash = bcrypt.hashSync(ADMIN_PASSWORD, 12);
  db.prepare(
    `INSERT INTO admin (id,email,senha_hash) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email, senha_hash=excluded.senha_hash`
  ).run(ADMIN_EMAIL, adminHash);

  return db;
}

module.exports = { createDatabase };
