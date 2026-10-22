'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { readConfig } = require('./config');
const { createDatabase } = require('./database');
const calendar = require('./calendar');
const { createBookingService } = require('./booking');
const { createAdminAuth } = require('./auth');
const { createReminderService, shouldSendReminder } = require('./reminders');
const { registerCustomerRoutes } = require('./routes/customer');
const { registerAdminRoutes } = require('./routes/admin');
const { handleError } = require('./http');

function createApplication(options = {}) {
  const config = options.config || readConfig();
  const db = options.db || createDatabase(config);
  const app = express();
  const booking = createBookingService(db);
  const auth = createAdminAuth(db, config);
  const reminders = createReminderService({ db, config, mailer: options.mailer, clock: options.clock });
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          scriptSrcAttr: ["'none'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:', 'https://images.unsplash.com'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          // O proxy de produção termina o HTTPS; o ambiente local também precisa funcionar por HTTP.
          upgradeInsecureRequests: null
        }
      }
    })
  );
  app.use(express.json({ limit: '40kb' }));
  app.use(express.urlencoded({ extended: false, limit: '40kb' }));
  app.use(['/api', '/admin'], (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(
    '/api/',
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Muitas requisições. Aguarde alguns instantes e tente novamente.' }
    })
  );
  app.use(
    '/admin/login',
    rateLimit({
      windowMs: 15 * 60_000,
      limit: 10,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' }
    })
  );

  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir, { extensions: ['html'] }));

  registerCustomerRoutes(app, { db, booking, config });
  registerAdminRoutes(app, { db, booking, auth, config });
  app.use(['/api', '/admin'], (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/admin/')) return next();
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use(handleError);

  return {
    app,
    db,
    config,
    localToUtc: calendar.localToUtc,
    utcToLocal: calendar.utcToLocal,
    durationSlots: calendar.durationSlots,
    hasMinimumBookingNotice: calendar.hasMinimumBookingNotice,
    validPhone: booking.validPhone,
    validEmail: booking.validEmail,
    hasOverlap: booking.hasOverlap,
    ensureDate: booking.ensureDate,
    validCustomerAuth: booking.validCustomerAuth,
    shouldSendReminder,
    dispatchDueReminders: reminders.dispatchDueReminders
  };
}

module.exports = { createApplication };
