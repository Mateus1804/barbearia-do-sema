'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const TABLES = ['servicos', 'clientes', 'agendamentos', 'horarios_bloqueados', 'feriados', 'admin'];

async function privateDirectory(directory) {
  const resolved = path.resolve(directory);
  const publicRoot = path.resolve(__dirname, '..', 'public');
  const inside = value => value === publicRoot || value.startsWith(publicRoot + path.sep);
  if (inside(resolved)) throw new Error('Backups e bases restauradas devem ficar fora do diretório público.');
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
  if (inside(await fs.realpath(resolved))) throw new Error('O destino aponta para o diretório público.');
}

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function inspectDatabase(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    db.pragma('trusted_schema = OFF');
    if (db.pragma('integrity_check', { simple: true }) !== 'ok' || db.pragma('foreign_key_check').length)
      throw new Error('O banco não passou pela verificação de integridade.');
    const schema = db.prepare("SELECT name,type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
    if (TABLES.some(name => !schema.some(item => item.name === name && item.type === 'table')) ||
        schema.some(item => item.type === 'trigger' || item.type === 'view'))
      throw new Error('O esquema do backup não é compatível com este projeto.');
    const tables = [...TABLES, ...schema.filter(item => item.name === 'reminder_deliveries').map(item => item.name)];
    const counts = {};
    const hash = createHash('sha256');
    for (const table of tables) {
      counts[table] = 0;
      hash.update(table + '\n');
      for (const row of db.prepare('SELECT * FROM "' + table + '" ORDER BY rowid').iterate()) {
        counts[table] += 1;
        hash.update(JSON.stringify(row) + '\n');
      }
    }
    return { counts, fingerprint: hash.digest('hex') };
  } finally { db.close(); }
}

async function verifyBackup(file) {
  const metadataFile = file + '.json';
  if ((await fs.stat(metadataFile)).size > 65536) throw new Error('Metadados excessivos.');
  const metadata = JSON.parse(await fs.readFile(metadataFile, 'utf8'));
  if (metadata.format !== 'sema-sqlite-backup' || metadata.version !== 1 ||
      !/^[a-f0-9]{64}$/.test(metadata.sha256 || '') ||
      !/^[a-f0-9]{64}$/.test(metadata.fingerprint || '') ||
      !Number.isFinite(Date.parse(metadata.createdAt)))
    throw new Error('Formato de backup não reconhecido.');
  if (await digest(file) !== metadata.sha256) throw new Error('O arquivo foi alterado ou está incompleto.');
  const checked = inspectDatabase(file);
  if (checked.fingerprint !== metadata.fingerprint ||
      JSON.stringify(checked.counts) !== JSON.stringify(metadata.counts))
    throw new Error('Os dados não correspondem aos metadados.');
  return metadata;
}

async function removeTemporary(file) {
  await Promise.all(['', '-wal', '-shm', '-journal'].map(suffix => fs.rm(file + suffix, { force: true })));
}

async function restoreBackup(file, destination) {
  const target = path.resolve(destination);
  if (path.resolve(file) === target) throw new Error('A origem e o destino devem ser diferentes.');
  const metadata = await verifyBackup(file);
  await privateDirectory(path.dirname(target));
  const staged = target + '.restore-' + randomUUID();
  try {
    await fs.copyFile(file, staged, require('node:fs').constants.COPYFILE_EXCL);
    await fs.chmod(staged, 0o600);
    if (await digest(staged) !== metadata.sha256) throw new Error('A cópia de restauração está incompleta.');
    const db = new Database(staged);
    try {
      db.pragma('journal_mode = DELETE');
      // A retomada dos e-mails exige conferência de marcadores de envio antigos.
      db.exec("CREATE TABLE IF NOT EXISTS operational_flags (key TEXT PRIMARY KEY,value TEXT NOT NULL)");
      db.prepare("INSERT INTO operational_flags(key,value) VALUES ('reminders_paused','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    } finally { db.close(); }
    if (inspectDatabase(staged).fingerprint !== metadata.fingerprint)
      throw new Error('A restauração não conservou os registros.');
    // link falha se o destino existir; uma base ativa nunca é substituída.
    await fs.link(staged, target);
    return { path: target, counts: metadata.counts, remindersPaused: true };
  } finally { await removeTemporary(staged); }
}

async function createBackup(db, { directory, now = new Date() }) {
  await privateDirectory(directory);
  const filename = 'sema-' + now.toISOString().replace(/[:.]/g, '-') + '-' + randomUUID() + '.sqlite';
  const target = path.resolve(directory, filename);
  const staged = target + '.tmp';
  const restored = target + '.verification';
  let published = false;
  try {
    // A API do SQLite inclui dados ainda presentes no WAL.
    await db.backup(staged);
    await fs.chmod(staged, 0o600);
    const snapshot = new Database(staged);
    try { snapshot.pragma('journal_mode = DELETE'); } finally { snapshot.close(); }
    const checked = inspectDatabase(staged);
    const metadata = { format: 'sema-sqlite-backup', version: 1, createdAt: now.toISOString(),
      sha256: await digest(staged), ...checked };
    await fs.writeFile(staged + '.json', JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await restoreBackup(staged, restored);
    await fs.link(staged, target);
    published = true;
    await fs.link(staged + '.json', target + '.json');
    return { path: target, counts: metadata.counts, recoveryVerified: true };
  } catch (error) {
    if (published) {
      await fs.rm(target, { force: true });
      await fs.rm(target + '.json', { force: true });
    }
    throw error;
  } finally {
    await removeTemporary(staged);
    await fs.rm(staged + '.json', { force: true });
    await removeTemporary(restored);
  }
}

async function pruneBackups(directory, keep, now = Date.now()) {
  if (!Number.isInteger(keep) || keep < 2 || keep > 1000) throw new Error('Retenção inválida.');
  const files = await fs.readdir(directory);
  const verified = [];
  for (const name of files.filter(name => /^sema-[\w-]+\.sqlite\.json$/.test(name))) {
    const file = path.join(directory, name.slice(0, -5));
    try { verified.push({ file, metadata: await verifyBackup(file) }); }
    catch { /* Arquivos incompletos não entram na retenção. */ }
  }
  verified.sort((a, b) => Date.parse(b.metadata.createdAt) - Date.parse(a.metadata.createdAt) || a.file.localeCompare(b.file));
  for (const item of verified.slice(keep)) {
    if (Date.parse(item.metadata.createdAt) > now - 3600000) continue;
    await fs.rm(item.file);
    await fs.rm(item.file + '.json');
  }
}

module.exports = { createBackup, verifyBackup, restoreBackup, pruneBackups };
