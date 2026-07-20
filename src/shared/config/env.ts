import { existsSync } from 'node:fs';
import { envSchema } from 'env-schema';
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { parseExportKeys } from '../security/export-key.js';

const MONGODB_URI_PATTERN = '^mongodb(?:\\+srv)?://';
const SUPPORTED_COMPLAINT_ATTACHMENT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
]);
// Reserva 1 MiB del límite BSON para hoja, metadatos y sobre del documento.
const MAX_COMPLAINT_BINARY_BYTES = 15 * 1024 * 1024;

const schema = Type.Object({
  NODE_ENV: Type.Union(
    [Type.Literal('development'), Type.Literal('production'), Type.Literal('test')],
    { default: 'development' },
  ),
  HOST: Type.String({ default: '127.0.0.1', minLength: 1 }),
  PORT: Type.Integer({ default: 3000, minimum: 1, maximum: 65535 }),
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
  MONGO_URI: Type.String({ default: 'mongodb://127.0.0.1:27017', pattern: MONGODB_URI_PATTERN }),
  /**
   * Credenciales propias de `carrito_forms` (usuario Mongo separado del de
   * contenido, AGENTS.md — datos personales). Vacío = usa MONGO_URI (solo
   * development/test). En producción es obligatorio y distinto de MONGO_URI
   * (ADR-003); permisos mínimos sin DDL (`scripts/forms/setup-contact.ts`).
   */
  MONGO_URI_FORMS: Type.String({ default: '' }),
  MONGO_DB_CONTENT: Type.String({ default: 'carrito_content', minLength: 1 }),
  MONGO_DB_FORMS: Type.String({ default: 'carrito_forms', minLength: 1 }),
  /**
   * Claves del export servidor-a-servidor, separadas por coma (máx. 2;
   * cada una ≥ 32 caracteres). Vacío = endpoint deshabilitado (→ 401).
   */
  EXPORT_API_KEYS: Type.String({ default: '' }),
  /**
   * Orígenes permitidos por CORS (dominios de carrito-front), separados por
   * coma. Vacío = sin CORS: el navegador no puede consumir la API desde otro
   * origen (los endpoints server-a-server no se ven afectados).
   */
  CORS_ORIGINS: Type.String({ default: '' }),
  /**
   * Exposición de la documentación OpenAPI (`/docs` + `/docs/json`).
   *
   * - `auto` (default): habilitada solo con NODE_ENV=development.
   * - `true`: forzada (staging con acceso restringido); el arranque lo advierte
   *   en producción.
   * - `false`: apagada siempre.
   *
   * Default seguro: la UI es de solo lectura y no expone secretos, pero
   * describe la superficie completa de la API. Abrirla fuera de desarrollo es
   * una decisión operativa explícita, no un efecto colateral del despliegue.
   */
  DOCS_ENABLED: Type.Union([Type.Literal('auto'), Type.Literal('true'), Type.Literal('false')], {
    default: 'auto',
  }),
  /**
   * Allowlist de IPs que pueden leer `/docs` **en producción**, separada por
   * coma. Vacío (default) = solo loopback. Fuera de producción no se aplica.
   *
   * Barrera propia de la aplicación: forzar `DOCS_ENABLED=true` en producción no
   * basta para publicar la superficie de la API a cualquiera que alcance el
   * puerto. No sustituye a la restricción en IIS/ARR, la respalda: el repositorio
   * no puede verificar la configuración del proxy, pero sí la suya.
   */
  DOCS_ALLOWED_IPS: Type.String({ default: '' }),
  /** Límite de lectura pública por IP y minuto (propuesta pendiente de aprobación: 120). */
  RATE_LIMIT_READ_PER_MINUTE: Type.Integer({ default: 120, minimum: 1 }),
  /**
   * Rate limit del formulario de contacto (contrato heredado,
   * formularios-backend-csharp.md §6: "5 envíos / 10 min por formulario,
   * parametrizable"). Ambos valores son ese default, configurables por env.
   */
  RATE_LIMIT_CONTACT_MAX: Type.Integer({ default: 5, minimum: 1 }),
  RATE_LIMIT_CONTACT_WINDOW_MINUTES: Type.Integer({ default: 10, minimum: 1 }),
  /**
   * Formulario de contacto (F5, cerrado). Default `true`: forma parte de la
   * línea base. `false` es kill-switch operativo (ADR-006), no un gate de
   * fase pendiente — a diferencia de reclamos (`FEATURE_COMPLAINTS_ENABLED`).
   */
  FEATURE_CONTACT_ENABLED: Type.Boolean({ default: true }),
  /**
   * Libro de Reclamaciones (F6). Default **false**: gate de fase, NO
   * kill-switch. Su activación exige cerrar el gate legal P1–P18 del contrato
   * heredado (formularios-backend-csharp.md §10) y es una decisión explícita
   * del usuario, nunca un despliegue (AGENTS.md). Con `false`, el endpoint
   * responde 503 «no disponible» sin tocar la base (ver ADR-007).
   */
  FEATURE_COMPLAINTS_ENABLED: Type.Boolean({ default: false }),
  /**
   * Acuse EXPLÍCITO de que el gate legal/operativo P1–P18 está cerrado. El
   * flag de fase no basta por sí solo: habilitar el Libro exige además poner
   * esto en `true`, un acto consciente que declara cerrado el contrato legal
   * (firma, adjuntos, correo, plazo, retención, roles). Con `false`, activar
   * el Libro detiene el arranque aunque el resto de la config esté completa.
   * NUNCA se pone en `true` sin autorización explícita del usuario.
   */
  COMPLAINTS_LEGAL_GATE_CLEARED: Type.Boolean({ default: false }),
  /** Rate limit del Libro de Reclamaciones (mismo patrón que contacto). */
  RATE_LIMIT_COMPLAINTS_MAX: Type.Integer({ default: 5, minimum: 1 }),
  RATE_LIMIT_COMPLAINTS_WINDOW_MINUTES: Type.Integer({ default: 10, minimum: 1 }),
  /**
   * Snapshot del proveedor persistido en cada reclamo (P8). Nunca sale del
   * cache público: es configuración propia del backend. Vacío por defecto;
   * obligatorio solo cuando el Libro está habilitado.
   */
  COMPLAINTS_PROVIDER_LEGAL_NAME: Type.String({ default: '' }),
  COMPLAINTS_PROVIDER_RUC: Type.String({ default: '' }),
  COMPLAINTS_PROVIDER_ADDRESS: Type.String({ default: '' }),
  /**
   * Versión del texto de aceptación/confirmación (P1/P16). Se persiste con
   * cada reclamo como evidencia de qué texto aceptó el consumidor. Valor
   * legal a fijar en el MR 1; configurable, nunca asumido en código.
   */
  COMPLAINTS_CONFIRMATION_TEXT_VERSION: Type.String({ default: '' }),
  /**
   * Plazo de respuesta en días (P1). Se usa para calcular `responseDueAtUtc`.
   * El valor legal vigente lo confirma el MR 1; no se asume (la página cita 30
   * días calendario de la Ley 29571, pero hay modificaciones posteriores).
   * Configurable; obligatorio solo cuando el Libro está habilitado.
   */
  COMPLAINTS_RESPONSE_DAYS: Type.Integer({ default: 0, minimum: 0 }),
  /**
   * Tamaño máximo del PNG de firma (P18). Propuesta del plan: 256 KB; valor
   * final del MR 1. Configurable.
   */
  COMPLAINTS_SIGNATURE_MAX_BYTES: Type.Integer({ default: 256 * 1024, minimum: 1 }),
  /**
   * Política de adjuntos del consumidor (P14). Recomendación inicial del plan:
   * PDF/JPEG/PNG, 5 archivos, 10 MB c/u. En Mongo (sin transacciones multi-doc
   * en standalone) el reclamo se persiste como un ÚNICO documento atómico, así
   * que el total embebido debe quedar bajo el límite de 16 MB de BSON: el
   * default total es conservador y validado antes de insertar (ver ADR-007).
   */
  COMPLAINTS_ATTACHMENTS_MAX_FILES: Type.Integer({ default: 5, minimum: 0 }),
  COMPLAINTS_ATTACHMENTS_MAX_FILE_BYTES: Type.Integer({
    default: 4 * 1024 * 1024,
    minimum: 1,
  }),
  COMPLAINTS_ATTACHMENTS_MAX_TOTAL_BYTES: Type.Integer({
    default: 12 * 1024 * 1024,
    minimum: 1,
  }),
  /** Allowlist de MIME de adjuntos (coma-separada). Firma mágica se valida además en código. */
  COMPLAINTS_ATTACHMENTS_ALLOWED_TYPES: Type.String({
    default: 'application/pdf,image/jpeg,image/png',
  }),
  /**
   * SMTP para el correo de constancia (P2). Vacío = transporte no-op (no
   * envía; el reclamo se persiste igual y el dispatch queda `pendiente`).
   * Credenciales SOLO por env; obligatorio configurarlas para envío real.
   */
  COMPLAINTS_SMTP_HOST: Type.String({ default: '' }),
  COMPLAINTS_SMTP_PORT: Type.Integer({ default: 587, minimum: 1, maximum: 65535 }),
  COMPLAINTS_SMTP_SECURE: Type.Boolean({ default: false }),
  COMPLAINTS_SMTP_USER: Type.String({ default: '' }),
  COMPLAINTS_SMTP_PASSWORD: Type.String({ default: '' }),
  COMPLAINTS_SMTP_FROM: Type.String({ default: '' }),
});

type EnvironmentConfig = Static<typeof schema>;

export type AppConfig = EnvironmentConfig & {
  /** Lista CORS ya normalizada y validada; única fuente para registrar el plugin. */
  CORS_ORIGINS_LIST: readonly string[];
  /**
   * `DOCS_ENABLED` ya resuelto contra NODE_ENV; única fuente para registrar
   * `/docs` (evita repetir la regla `auto` en el bootstrap y en las pruebas).
   */
  DOCS_UI_ENABLED: boolean;
  /** Allowlist de `/docs` ya normalizada; vacía = solo loopback. */
  DOCS_ALLOWED_IPS_LIST: readonly string[];
};

/**
 * Carga y valida la configuración al arrancar (fail-fast: un .env inválido
 * detiene el proceso antes de aceptar tráfico).
 *
 * En producción el .env vive fuera del repo y de las releases; NSSM inyecta
 * su ruta mediante CARRITO_ENV_FILE (ver plan F7).
 */
export function loadConfig(overrides?: Record<string, string>): AppConfig {
  let config: EnvironmentConfig;
  if (overrides) {
    config = envSchema<EnvironmentConfig>({ schema, data: overrides, dotenv: false });
  } else {
    const configuredEnvFile = process.env['CARRITO_ENV_FILE'];
    if (configuredEnvFile !== undefined && !existsSync(configuredEnvFile)) {
      throw new Error(`CARRITO_ENV_FILE no existe: ${configuredEnvFile}`);
    }
    const envFile = configuredEnvFile ?? '.env';
    config = envSchema<EnvironmentConfig>({
      schema,
      // Sin archivo .env se usan process.env y los defaults del esquema.
      dotenv: existsSync(envFile) ? { path: envFile } : false,
    });
  }

  const corsOrigins = assertBaseConfig(config);
  assertComplaintLimits(config);
  assertSmtpConfig(config);
  assertProductionFormsCredentials(config);
  assertComplaintsConfig(config);
  return {
    ...config,
    CORS_ORIGINS_LIST: corsOrigins,
    DOCS_UI_ENABLED: resolveDocsEnabled(config),
    DOCS_ALLOWED_IPS_LIST: config.DOCS_ALLOWED_IPS.split(',')
      .map((ip) => ip.trim())
      .filter((ip) => ip.length > 0),
  };
}

/** `auto` = solo development; los valores explícitos mandan sobre NODE_ENV. */
function resolveDocsEnabled(config: EnvironmentConfig): boolean {
  if (config.DOCS_ENABLED === 'true') return true;
  if (config.DOCS_ENABLED === 'false') return false;
  return config.NODE_ENV === 'development';
}

function assertBaseConfig(config: EnvironmentConfig): readonly string[] {
  for (const [name, value] of [
    ['HOST', config.HOST],
    ['MONGO_URI', config.MONGO_URI],
    ['MONGO_DB_CONTENT', config.MONGO_DB_CONTENT],
    ['MONGO_DB_FORMS', config.MONGO_DB_FORMS],
  ] as const) {
    if (value.trim().length === 0) throw new Error(`${name} no puede estar vacío.`);
  }

  if (
    config.MONGO_URI_FORMS.length > 0 &&
    !/^mongodb(?:\+srv)?:\/\//.test(config.MONGO_URI_FORMS)
  ) {
    throw new Error('MONGO_URI_FORMS debe ser una URI mongodb:// o mongodb+srv:// válida.');
  }
  if (config.MONGO_DB_CONTENT === config.MONGO_DB_FORMS) {
    throw new Error('MONGO_DB_CONTENT y MONGO_DB_FORMS no pueden ser la misma base de datos.');
  }

  parseExportKeys(config.EXPORT_API_KEYS);
  return parseCorsOrigins(config.CORS_ORIGINS);
}

function parseCorsOrigins(raw: string): readonly string[] {
  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  for (const origin of origins) {
    if (origin === '*')
      throw new Error('CORS_ORIGINS no admite el wildcard *; usa orígenes explícitos.');
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`CORS_ORIGINS contiene un origen inválido: ${origin}`);
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      origin !== parsed.origin
    ) {
      throw new Error(
        `CORS_ORIGINS solo admite orígenes http(s) exactos, sin credenciales, ruta, query ni fragmento: ${origin}`,
      );
    }
  }
  return origins;
}

function assertComplaintLimits(config: EnvironmentConfig): void {
  if (
    config.COMPLAINTS_ATTACHMENTS_MAX_FILES > 0 &&
    config.COMPLAINTS_ATTACHMENTS_MAX_FILE_BYTES > config.COMPLAINTS_ATTACHMENTS_MAX_TOTAL_BYTES
  ) {
    throw new Error(
      'COMPLAINTS_ATTACHMENTS_MAX_FILE_BYTES no puede superar COMPLAINTS_ATTACHMENTS_MAX_TOTAL_BYTES.',
    );
  }

  const binaryBudget =
    config.COMPLAINTS_SIGNATURE_MAX_BYTES + config.COMPLAINTS_ATTACHMENTS_MAX_TOTAL_BYTES;
  if (binaryBudget > MAX_COMPLAINT_BINARY_BYTES) {
    throw new Error(
      'COMPLAINTS_SIGNATURE_MAX_BYTES + COMPLAINTS_ATTACHMENTS_MAX_TOTAL_BYTES ' +
        'debe ser como máximo 15 MiB para reservar espacio dentro del límite BSON.',
    );
  }

  const allowedTypes = config.COMPLAINTS_ATTACHMENTS_ALLOWED_TYPES.split(',')
    .map((type) => type.trim())
    .filter((type) => type.length > 0);
  const unsupported = allowedTypes.filter(
    (type) => !SUPPORTED_COMPLAINT_ATTACHMENT_TYPES.has(type),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `COMPLAINTS_ATTACHMENTS_ALLOWED_TYPES contiene tipos no soportados: ${unsupported.join(', ')}.`,
    );
  }
  if (config.COMPLAINTS_ATTACHMENTS_MAX_FILES > 0 && allowedTypes.length === 0) {
    throw new Error(
      'COMPLAINTS_ATTACHMENTS_ALLOWED_TYPES no puede estar vacío si se permiten adjuntos.',
    );
  }
}

function assertSmtpConfig(config: EnvironmentConfig): void {
  const hasHost = config.COMPLAINTS_SMTP_HOST.length > 0;
  const hasFrom = config.COMPLAINTS_SMTP_FROM.length > 0;
  if (hasHost !== hasFrom) {
    throw new Error('COMPLAINTS_SMTP_HOST y COMPLAINTS_SMTP_FROM deben configurarse juntos.');
  }

  const hasUser = config.COMPLAINTS_SMTP_USER.length > 0;
  const hasPassword = config.COMPLAINTS_SMTP_PASSWORD.length > 0;
  if (hasUser !== hasPassword) {
    throw new Error('COMPLAINTS_SMTP_USER y COMPLAINTS_SMTP_PASSWORD deben configurarse juntos.');
  }
}

/**
 * Validaciones de arranque del Libro de Reclamaciones (F6). Solo aplican
 * cuando el gate está habilitado: con `FEATURE_COMPLAINTS_ENABLED=false`
 * (default) no se exige ningún valor legal y el endpoint responde 503.
 *
 * Estos asserts son una segunda barrera contra la activación accidental o
 * prematura:
 *
 * 1. Habilitar el Libro exige el acuse EXPLÍCITO `COMPLAINTS_LEGAL_GATE_CLEARED`
 *    (declara cerrado P1–P18): el flag de fase por sí solo no basta.
 * 2. Exige los valores legales/operativos mínimos (proveedor P8, texto de
 *    confirmación P1/P16, plazo P1) — no se asumen en código.
 * 3. En producción, además, la infraestructura de correo de constancia es
 *    obligatoria (P2: el Libro debe enviar la constancia; no se activa sin
 *    SMTP) y `carrito_forms` debe usar credenciales propias (ADR-003).
 *
 * Sin cerrar estos puntos, activar el flag detiene el arranque en vez de
 * aceptar reclamos que luego no podrían atenderse conforme a ley.
 */
function assertComplaintsConfig(config: EnvironmentConfig): void {
  if (!config.FEATURE_COMPLAINTS_ENABLED) return;

  if (!config.COMPLAINTS_LEGAL_GATE_CLEARED) {
    throw new Error(
      'FEATURE_COMPLAINTS_ENABLED=true exige COMPLAINTS_LEGAL_GATE_CLEARED=true: el gate ' +
        'legal P1–P18 (formularios-backend-csharp.md §10; ADR-007) debe cerrarse de forma ' +
        'explícita y autorizada por el usuario. El flag de fase por sí solo no habilita el Libro.',
    );
  }

  const missing: string[] = [];
  if (config.COMPLAINTS_PROVIDER_LEGAL_NAME.length === 0)
    missing.push('COMPLAINTS_PROVIDER_LEGAL_NAME');
  if (config.COMPLAINTS_PROVIDER_RUC.length === 0) missing.push('COMPLAINTS_PROVIDER_RUC');
  if (config.COMPLAINTS_PROVIDER_ADDRESS.length === 0) missing.push('COMPLAINTS_PROVIDER_ADDRESS');
  if (config.COMPLAINTS_CONFIRMATION_TEXT_VERSION.length === 0)
    missing.push('COMPLAINTS_CONFIRMATION_TEXT_VERSION');
  if (config.COMPLAINTS_RESPONSE_DAYS <= 0) missing.push('COMPLAINTS_RESPONSE_DAYS');

  if (missing.length > 0) {
    throw new Error(
      `FEATURE_COMPLAINTS_ENABLED=true requiere cerrar el gate legal (P1/P8/P16) y ` +
        `configurar: ${missing.join(', ')} (formularios-backend-csharp.md §10; ADR-007). ` +
        `Su activación es una decisión explícita, no un despliegue (AGENTS.md).`,
    );
  }

  if (config.NODE_ENV !== 'production') return;

  // Correo de constancia obligatorio en producción (P2): el Libro virtual debe
  // enviar la constancia al consumidor; no se expone sin infraestructura real.
  if (config.COMPLAINTS_SMTP_HOST.length === 0 || config.COMPLAINTS_SMTP_FROM.length === 0) {
    throw new Error(
      'En producción, FEATURE_COMPLAINTS_ENABLED=true exige COMPLAINTS_SMTP_HOST y ' +
        'COMPLAINTS_SMTP_FROM (correo de constancia obligatorio — P2, §5.6).',
    );
  }
  if (config.MONGO_URI_FORMS.length === 0) {
    throw new Error(
      'MONGO_URI_FORMS es obligatorio en producción cuando FEATURE_COMPLAINTS_ENABLED=true ' +
        '(credenciales propias de carrito_forms; AGENTS.md — datos personales).',
    );
  }
  if (config.MONGO_URI_FORMS === config.MONGO_URI) {
    throw new Error(
      'MONGO_URI_FORMS no puede coincidir con MONGO_URI en producción ' +
        '(AGENTS.md: usuario Mongo propio para formularios).',
    );
  }
}

/**
 * En producción, si el contacto está habilitado, `carrito_forms` debe usar
 * credenciales propias y distintas de contenido (AGENTS.md / ADR-003).
 * Con F5 desactivado no se exige MONGO_URI_FORMS (línea base F0–F4).
 */
function assertProductionFormsCredentials(config: EnvironmentConfig): void {
  if (config.NODE_ENV !== 'production') return;
  if (!config.FEATURE_CONTACT_ENABLED) return;

  if (config.MONGO_URI_FORMS.length === 0) {
    throw new Error(
      'MONGO_URI_FORMS es obligatorio en producción cuando FEATURE_CONTACT_ENABLED=true ' +
        '(credenciales propias de carrito_forms; AGENTS.md — separación de datos personales).',
    );
  }
  if (config.MONGO_URI_FORMS === config.MONGO_URI) {
    throw new Error(
      'MONGO_URI_FORMS no puede coincidir con MONGO_URI en producción ' +
        '(AGENTS.md: usuario Mongo propio para formularios).',
    );
  }
}
