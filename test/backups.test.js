'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');
const { createDatabase } = require('../src/database');
const { readConfig } = require('../src/config');
const { createBackup, verifyBackup, restoreBackup, pruneBackups } = require('../src/backups');
const { startBackupScheduler } = require('../src/backup-scheduler');

async function fixture(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sema-backup-'));
  const dbPath = path.join(directory, 'original.sqlite');
  const config = readConfig({ DB_PATH: dbPath, BACKUP_DIR: path.join(directory, 'backups'), ADMIN_PASSWORD: 'Senha ficticia para teste' });
  const db = createDatabase(config);
  db.prepare('INSERT INTO clientes(cliente_nome,cliente_telefone,cliente_email,criado_em,atualizado_em) VALUES (?,?,?,?,?)')
    .run('Pessoa fictícia', '31988887777', 'ficticio@example.com', '2026-10-20', '2026-10-20');
  db.prepare("INSERT INTO feriados(data,motivo) VALUES ('2026-12-25','Fechado fictício')").run();
  context.after(async () => { db.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { db, dbPath, config, directory: config.BACKUP_DIR, root: directory };
}

test('backup com WAL verifica restauração e conserva todas as linhas e IDs', async context => {
  const { db, directory, root } = await fixture(context);
  db.prepare("INSERT INTO horarios_bloqueados(data,hora,motivo) VALUES ('2026-10-30','09:00','Bloqueio fictício')").run();
  const backup = await createBackup(db, { directory });
  assert.equal(backup.recoveryVerified, true);
  assert.equal((await verifyBackup(backup.path)).counts.clientes, 1);
  db.prepare('DELETE FROM clientes').run();
  const restored = await restoreBackup(backup.path, path.join(root, 'restaurado.sqlite'));
  const reopened = new Database(restored.path, { readonly: true });
  try {
    assert.equal(reopened.prepare('SELECT cliente_nome FROM clientes WHERE id=1').get().cliente_nome, 'Pessoa fictícia');
    assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM horarios_bloqueados').get().n, 1);
    assert.equal(reopened.prepare("SELECT value FROM operational_flags WHERE key='reminders_paused'").get().value, '1');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM clientes').get().n, 0);
  } finally { reopened.close(); }
  assert.equal((await fs.readdir(directory)).filter(name => name.includes('.tmp') || name.includes('.verification')).length, 0);
});

test('restauração recusa destino existente sem modificar seu conteúdo', async context => {
  const { db, directory, dbPath } = await fixture(context);
  const backup = await createBackup(db, { directory });
  const before = await fs.readFile(dbPath);
  await assert.rejects(restoreBackup(backup.path, dbPath), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(dbPath), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM clientes').get().n, 1);
});

test('arquivo adulterado, metadados incompatíveis e banco corrompido são recusados', async context => {
  const { db, directory, root } = await fixture(context);
  const backup = await createBackup(db, { directory });
  const manifest = backup.path + '.json';
  const original = await fs.readFile(manifest, 'utf8');
  const metadata = JSON.parse(original);
  await fs.writeFile(manifest, JSON.stringify({ ...metadata, version: 999 }));
  await assert.rejects(verifyBackup(backup.path), /Formato/);
  await fs.writeFile(manifest, original);
  await fs.appendFile(backup.path, 'alterado');
  await assert.rejects(restoreBackup(backup.path, path.join(root, 'nao-criado.sqlite')), /alterado/);
  await assert.rejects(fs.stat(path.join(root, 'nao-criado.sqlite')), { code: 'ENOENT' });
  const invalid = Buffer.from('Isto não é um banco SQLite');
  await fs.writeFile(backup.path, invalid);
  metadata.sha256 = require('node:crypto').createHash('sha256').update(invalid).digest('hex');
  await fs.writeFile(manifest, JSON.stringify(metadata));
  await assert.rejects(verifyBackup(backup.path));
});

test('falha de criação não remove o último backup concluído', async context => {
  const { db, directory } = await fixture(context);
  const previous = await createBackup(db, { directory });
  await assert.rejects(createBackup({ backup: async () => { throw new Error('Falha fictícia'); } }, { directory }));
  assert.equal((await verifyBackup(previous.path)).counts.clientes, 1);
  assert.equal((await fs.readdir(directory)).length, 2);
});

test('retenção só remove pares verificados antigos e recusa limites inválidos', async context => {
  const { db, directory } = await fixture(context);
  const first = await createBackup(db, { directory, now: new Date('2026-10-20T12:00:00Z') });
  const second = await createBackup(db, { directory, now: new Date('2026-10-21T12:00:00Z') });
  const third = await createBackup(db, { directory, now: new Date('2026-10-22T12:00:00Z') });
  await fs.writeFile(path.join(directory, 'arquivo-do-operador.txt'), 'não remover');
  await assert.rejects(pruneBackups(directory, NaN), /Retenção/);
  await pruneBackups(directory, 2, Date.parse('2026-10-23T12:00:00Z'));
  await assert.rejects(fs.stat(first.path), { code: 'ENOENT' });
  await verifyBackup(second.path);
  await verifyBackup(third.path);
  assert.equal(await fs.readFile(path.join(directory, 'arquivo-do-operador.txt'), 'utf8'), 'não remover');
});

test('o agendador desativado não cria arquivos', async context => {
  const fixtureData = await fixture(context);
  const config = { ...fixtureData.config, BACKUP_ENABLED: false };
  const scheduler = startBackupScheduler({ db: fixtureData.db, config });
  await scheduler.run();
  await scheduler.stop();
  await assert.rejects(fs.stat(config.BACKUP_DIR), { code: 'ENOENT' });
});

test('destino público é recusado antes da escrita de dados financeiros', async context => {
  const { db } = await fixture(context);
  await assert.rejects(createBackup(db, { directory: path.join(__dirname, '..', 'public', 'backups') }), /público/);
});

test('o agendador não sobrepõe ciclos e aguarda o backup em andamento ao parar', async context => {
  const { db, config } = await fixture(context);
  let calls = 0;
  let release;
  let began;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  const scheduler = startBackupScheduler({ db: { backup: async file => {
    calls += 1;
    began();
    await waiting;
    return db.backup(file);
  } }, config });
  await started;
  await Promise.all([scheduler.run(), scheduler.run()]);
  assert.equal(calls, 1);
  release();
  await scheduler.stop();
  const manifests = (await fs.readdir(config.BACKUP_DIR)).filter(name => name.endsWith('.json'));
  assert.equal(manifests.length, 1);
  await verifyBackup(path.join(config.BACKUP_DIR, manifests[0].slice(0, -5)));
});
