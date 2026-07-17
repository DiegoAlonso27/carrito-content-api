import { loadConfig } from './shared/config/env.js';
import { buildApp } from './app.js';

const config = loadConfig();
const app = buildApp(config);

// Cierre ordenado: NSSM detiene el servicio con una señal; se deja de aceptar
// conexiones y se cierran las existentes (incluido el cliente de MongoDB).
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, 'apagando');
    void app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (err) {
  app.log.fatal({ err }, 'no se pudo iniciar el servidor');
  process.exit(1);
}
