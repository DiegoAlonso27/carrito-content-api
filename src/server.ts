import { loadConfig } from './shared/config/env.js';
import { buildApp } from './app.js';
import { safeErrorLog } from './shared/logging/logger.js';
import { registerShutdownHandlers } from './shared/operation/shutdown.js';

const config = loadConfig();
const app = buildApp(config);

// NSSM detiene con una señal; el handler idempotente deja de aceptar tráfico
// y espera el cierre de ambos clientes MongoDB.
registerShutdownHandlers(app);

// Errores fuera del ciclo request/response se registran de forma estructurada.
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
