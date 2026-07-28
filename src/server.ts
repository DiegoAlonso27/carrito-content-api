import { loadConfig } from './shared/config/env.js';
import { buildApp } from './app.js';
import { safeErrorLog } from './shared/logging/logger.js';
import { registerShutdownHandlers } from './shared/operation/shutdown.js';

const config = loadConfig();
const app = buildApp(config);

// NSSM detiene con una señal; el handler idempotente deja de aceptar tráfico
// y espera el cierre de ambos clientes MongoDB.
registerShutdownHandlers(app);

// Errores fuera del ciclo request/response: sin esto solo quedan en stderr
// del proceso y no en el archivo diario bajo LOG_DIR.
process.on('uncaughtException', (err) => {
  app.log.fatal(
    { error: safeErrorLog(err, { includeStackFrames: true }) },
    'uncaughtException',
  );
  process.exitCode = 1;
});
process.on('unhandledRejection', (reason) => {
  app.log.error(
    { error: safeErrorLog(reason, { includeStackFrames: true }) },
    'unhandledRejection',
  );
});

if (config.LOG_DIR.trim().length > 0) {
  app.log.info({ logDir: config.LOG_DIR.trim() }, 'logging a archivo habilitado');
}

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (err) {
  app.log.fatal(
    { error: safeErrorLog(err, { includeStackFrames: true }) },
    'no se pudo iniciar el servidor',
  );
  try {
    await app.close();
  } catch (closeErr) {
    app.log.error(
      { error: safeErrorLog(closeErr, { includeStackFrames: true }) },
      'falló el cierre tras error de arranque',
    );
  }
  process.exitCode = 1;
}
