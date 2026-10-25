'use strict';

require('dotenv').config();
const { createApplication } = require('./src/app');
const { startBackupScheduler } = require('./src/backup-scheduler');
const runtime = createApplication();
const { app, dispatchDueReminders, config } = runtime;
const { PORT, ADMIN_PASSWORD, JWT_SECRET, SMTP_CONFIGURED } = config;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Barbearia do Semá disponível em http://localhost:${PORT}`);
    if (JWT_SECRET === 'development-only-change-me-before-deploying-2026')
      console.warn('AVISO: configure JWT_SECRET antes de publicar.');
    if (ADMIN_PASSWORD === 'Sema@2026!') console.warn('AVISO: configure ADMIN_PASSWORD antes de publicar.');
    if (!SMTP_CONFIGURED)
      console.warn(
        'AVISO: configure SMTP_HOST, SMTP_USER, SMTP_PASS e EMAIL_FROM para ativar os lembretes por e-mail.'
      );
    startBackupScheduler({ db: runtime.db, config });
    dispatchDueReminders().catch((error) =>
      console.error('[lembretes] Erro no ciclo inicial:', error.message)
    );
    const reminderTimer = setInterval(
      () =>
        dispatchDueReminders().catch((error) => console.error('[lembretes] Erro no ciclo:', error.message)),
      60_000
    );
    reminderTimer.unref();
  });
}

module.exports = { ...runtime, createApplication };
