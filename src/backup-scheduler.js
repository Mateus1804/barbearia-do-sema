'use strict';

const { createBackup, pruneBackups } = require('./backups');

function startBackupScheduler({ db, config, onError = () => console.error('[backup] Falha na criação ou verificação; o backup anterior foi conservado.') }) {
  let running = null;
  let timer;
  let stopped = false;
  async function run() {
    if (stopped || running || !config.BACKUP_ENABLED || config.DB_PATH === ':memory:') return;
    running = (async () => {
      const result = await createBackup(db, { directory: config.BACKUP_DIR });
      await pruneBackups(config.BACKUP_DIR, config.BACKUP_KEEP);
      return result;
    })();
    try { return await running; }
    catch { onError(); }
    finally { running = null; }
  }
  if (config.BACKUP_ENABLED && config.DB_PATH !== ':memory:') {
    timer = setInterval(() => { void run(); }, config.BACKUP_INTERVAL_HOURS * 3600000);
    timer.unref();
    void run();
  }
  return { run, stop: async () => { stopped = true; clearInterval(timer); await running?.catch(() => {}); } };
}

module.exports = { startBackupScheduler };
