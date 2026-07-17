import { existsSync } from 'node:fs';
import { envSchema } from 'env-schema';
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

const schema = Type.Object({
  NODE_ENV: Type.Union(
    [Type.Literal('development'), Type.Literal('production'), Type.Literal('test')],
    { default: 'development' },
  ),
  HOST: Type.String({ default: '127.0.0.1' }),
  PORT: Type.Number({ default: 3000, minimum: 1, maximum: 65535 }),
  LOG_LEVEL: Type.Union(
    [
      Type.Literal('fatal'),
      Type.Literal('error'),
      Type.Literal('warn'),
      Type.Literal('info'),
      Type.Literal('debug'),
      Type.Literal('trace'),
    ],
    { default: 'info' },
  ),
  MONGO_URI: Type.String({ default: 'mongodb://127.0.0.1:27017' }),
  MONGO_DB_CONTENT: Type.String({ default: 'carrito_content' }),
  MONGO_DB_FORMS: Type.String({ default: 'carrito_forms' }),
});

export type AppConfig = Static<typeof schema>;

/**
 * Carga y valida la configuración al arrancar (fail-fast: un .env inválido
 * detiene el proceso antes de aceptar tráfico).
 *
 * En producción el .env vive fuera del repo y de las releases; NSSM inyecta
 * su ruta mediante CARRITO_ENV_FILE (ver plan F7).
 */
export function loadConfig(overrides?: Record<string, string>): AppConfig {
  if (overrides) {
    return envSchema<AppConfig>({ schema, data: overrides, dotenv: false });
  }
  const envFile = process.env['CARRITO_ENV_FILE'] ?? '.env';
  return envSchema<AppConfig>({
    schema,
    // Sin archivo .env se usan process.env y los defaults del esquema.
    dotenv: existsSync(envFile) ? { path: envFile } : false,
  });
}
