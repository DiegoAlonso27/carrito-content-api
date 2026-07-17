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
  /**
   * Credenciales propias de `carrito_forms` (usuario Mongo separado del de
   * contenido, AGENTS.md — datos personales). Vacío = usa MONGO_URI (solo
   * conveniencia de desarrollo local con un único mongod); en producción
   * debe apuntar a un usuario distinto, con permisos mínimos (sin DDL: la
   * colección/índices los provisiona `scripts/forms/setup-contact.ts`).
   */
  MONGO_URI_FORMS: Type.String({ default: '' }),
  MONGO_DB_CONTENT: Type.String({ default: 'carrito_content' }),
  MONGO_DB_FORMS: Type.String({ default: 'carrito_forms' }),
  /**
   * Claves del export servidor-a-servidor, separadas por coma (máx. 2 para
   * rotación sin corte). Vacío = endpoint deshabilitado (todo request → 401).
   */
  EXPORT_API_KEYS: Type.String({ default: '' }),
  /**
   * Orígenes permitidos por CORS (dominios de carrito-front), separados por
   * coma. Vacío = sin CORS: el navegador no puede consumir la API desde otro
   * origen (los endpoints server-a-server no se ven afectados).
   */
  CORS_ORIGINS: Type.String({ default: '' }),
  /** Límite de lectura pública por IP y minuto (propuesta pendiente de aprobación: 120). */
  RATE_LIMIT_READ_PER_MINUTE: Type.Number({ default: 120, minimum: 1 }),
  /**
   * Rate limit del formulario de contacto (contrato heredado,
   * formularios-backend-csharp.md §6: "5 envíos / 10 min por formulario,
   * parametrizable"). Ambos valores son ese default, configurables por env.
   */
  RATE_LIMIT_CONTACT_MAX: Type.Number({ default: 5, minimum: 1 }),
  RATE_LIMIT_CONTACT_WINDOW_MINUTES: Type.Number({ default: 10, minimum: 1 }),
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
