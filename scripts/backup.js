'use strict';

require('dotenv').config();
const path = require('node:path');
const Database = require('better-sqlite3');
const { createBackup, verifyBackup, restoreBackup, pruneBackups } = require('../src/backups');

async function main() {
  const [command, input, destination] = process.argv.slice(2);
  const databasePath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'barbearia.db');
  const directory = process.env.BACKUP_DIR || path.join(path.dirname(path.resolve(databasePath)), 'backups');
  if (command === 'create') {
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const result = await createBackup(db, { directory });
      await pruneBackups(directory, Number(process.env.BACKUP_KEEP || 7));
      console.log(JSON.stringify(result));
    } finally { db.close(); }
  } else if (command === 'verify' && input) console.log(JSON.stringify(await verifyBackup(path.resolve(input))));
  else if (command === 'restore' && input && destination)
    console.log(JSON.stringify(await restoreBackup(path.resolve(input), destination)));
  else if (command === 'resume-reminders' && input === '--confirmar') {
    const db = new Database(databasePath, { fileMustExist: true });
    try {
      db.prepare("UPDATE operational_flags SET value='0' WHERE key='reminders_paused'").run();
      console.log('Pausa operacional removida. O próximo ciclo reavaliará a elegibilidade.');
    } finally { db.close(); }
  } else throw new Error('Uso: backup.js create | verify ARQUIVO | restore ARQUIVO NOVO_DESTINO | resume-reminders --confirmar');
}

main().catch(() => {
  console.error('A operação de backup não foi concluída. Confira o formato, os caminhos, as permissões e a existência do destino; nenhuma base existente foi substituída.');
  process.exitCode = 1;
});
