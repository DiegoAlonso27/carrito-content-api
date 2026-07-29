import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Static, TObject } from '@sinclair/typebox';
import { registerInternalEditorGuard } from './internal-editor.guard.js';
import {
  cachePageSchema,
  cacheSettingSchema,
  cacheTextSchema,
} from '../content/content.schemas.js';
import {
  ContentTopologyWriteError,
  ContentWriteError,
  listSectionDocs,
  setRecords,
} from '../content/content-write.js';
import type { SectionName } from '../content/content-write.js';
import { ContentRepo } from '../content/content.repo.js';
import { AppError, ErrorCodes } from '../../shared/errors/app-error.js';
import { errorEnvelopeSchema } from '../../shared/errors/error-schema.js';

/**
 * Editor interno opt-in (`INTERNAL_EDITOR_ENABLED`, allowlist de IP).
 *
 * Superficie deliberadamente pequeña: solo `texts`, `pages` y `settings` —
 * las secciones cuyo contenido cambia a diario. `locales`, `collections`,
 * `assets` e `items` siguen siendo territorio de los CLI de `scripts/content/`
 * porque tocan la topología del contenido (referencias, esquemas por colección)
 * y un error ahí rompe el bundle entero.
 *
 * Persistencia: nada de Mongo directo. Se reutilizan `setRecords` y
 * `listSectionDocs` de `content-write.ts`, así que el editor hereda las mismas
 * validaciones, sanitización de HTML e invariantes de publicación que los CLI.
 */

/** Marcador sustituido por el nonce real en cada respuesta de `/internal/edit`. */
const NONCE_PLACEHOLDER = '__CSP_NONCE__';

/**
 * El editor se sirve como una sola página con `<style>`/`<script>` embebidos.
 * @fastify/helmet ya fija una CSP global con `script-src 'self'`, que los
 * bloquearía. Se usa un nonce por respuesta en vez de `'unsafe-inline'`: así la
 * página funciona sin relajar la política para nadie más (y `'unsafe-inline'`
 * habría autorizado también cualquier inyección que llegara a colarse en el
 * HTML). `default-src 'none'` deja fuera todo lo no declarado.
 */
function contentSecurityPolicy(nonce: string): string {
  return (
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
    `connect-src 'self'; img-src 'self' data:; form-action 'none'; base-uri 'none'; ` +
    `frame-ancestors 'none'`
  );
}

/** Documento crudo de Mongo, visto como bolsa de valores desconocidos. */
type StoredDoc = Record<string, unknown>;

/**
 * DTO de salida: los campos declarados de la sección + el estado editorial.
 * `sortOrder` se expone en el tipo porque el orden de la lista se calcula con él.
 */
type EditorRecord = { sortOrder: number } & Record<string, unknown>;

type TextRecord = Static<typeof cacheTextSchema> & { status: string };
type PageRecord = Static<typeof cachePageSchema> & { status: string };
type SettingRecord = Static<typeof cacheSettingSchema> & { status: string };

/**
 * Un documento con forma inesperada es corrupción de datos, no un error del
 * cliente: se responde 500 genérico (el handler central ya lo registra) en vez
 * de dejar pasar un valor que no cumple el response schema.
 */
function malformedDoc(): AppError {
  return new AppError(
    ErrorCodes.internal,
    'El contenido almacenado no tiene la forma esperada.',
    500,
  );
}

function readString(doc: StoredDoc, field: string): string {
  const value = doc[field];
  if (typeof value !== 'string') throw malformedDoc();
  return value;
}

function readNullableString(doc: StoredDoc, field: string): string | null {
  return doc[field] === null ? null : readString(doc, field);
}

function readBoolean(doc: StoredDoc, field: string): boolean {
  const value = doc[field];
  if (typeof value !== 'boolean') throw malformedDoc();
  return value;
}

function readNumber(doc: StoredDoc, field: string): number {
  const value = doc[field];
  if (typeof value !== 'number') throw malformedDoc();
  return value;
}

// Selección EXPLÍCITA campo a campo (nada de spread ni de rest del documento):
// `_id`, `revision`, `createdAt` y `updatedAt` no tienen forma de escaparse, ni
// siquiera si el documento almacenado gana campos nuevos.

function toTextRecord(doc: StoredDoc): TextRecord {
  return {
    localeCode: readString(doc, 'localeCode'),
    key: readString(doc, 'key'),
    value: readString(doc, 'value'),
    isActive: readBoolean(doc, 'isActive'),
    sortOrder: readNumber(doc, 'sortOrder'),
    status: readString(doc, 'status'),
  };
}

function toPageRecord(doc: StoredDoc): PageRecord {
  return {
    localeCode: readString(doc, 'localeCode'),
    slug: readString(doc, 'slug'),
    route: readString(doc, 'route'),
    title: readString(doc, 'title'),
    metaTitle: readNullableString(doc, 'metaTitle'),
    metaDescription: readNullableString(doc, 'metaDescription'),
    ogImageSlug: readNullableString(doc, 'ogImageSlug'),
    isActive: readBoolean(doc, 'isActive'),
    sortOrder: readNumber(doc, 'sortOrder'),
    status: readString(doc, 'status'),
  };
}

function toSettingRecord(doc: StoredDoc): SettingRecord {
  return {
    key: readString(doc, 'key'),
    value: readString(doc, 'value'),
    valueType: readString(doc, 'valueType'),
    description: readString(doc, 'description'),
    isActive: readBoolean(doc, 'isActive'),
    sortOrder: readNumber(doc, 'sortOrder'),
    status: readString(doc, 'status'),
  };
}

interface EditorSection {
  readonly name: SectionName;
  /**
   * Path literal por sección en vez de `/internal/api/:section`. La superficie
   * de URLs es idéntica, pero así cada ruta declara su response schema CONCRETO;
   * con un `:section` genérico el schema tendría que ser una unión y dejaría de
   * ser una barrera anti-fuga estricta (una unión acepta la forma de cualquier
   * sección, no solo la de la pedida).
   */
  readonly path: string;
  readonly schema: TObject;
  readonly keyFields: readonly string[];
  readonly toRecord: (doc: StoredDoc) => EditorRecord;
}

const EDITOR_SECTIONS: readonly EditorSection[] = [
  {
    name: 'texts',
    path: '/internal/api/texts',
    schema: cacheTextSchema,
    keyFields: ['localeCode', 'key'],
    toRecord: toTextRecord,
  },
  {
    name: 'pages',
    path: '/internal/api/pages',
    schema: cachePageSchema,
    keyFields: ['localeCode', 'slug'],
    toRecord: toPageRecord,
  },
  {
    name: 'settings',
    path: '/internal/api/settings',
    schema: cacheSettingSchema,
    keyFields: ['key'],
    toRecord: toSettingRecord,
  },
];

/** Clave natural de la sección, con el mismo formato `a/b` que usan los CLI. */
function naturalKey(record: EditorRecord, keyFields: readonly string[]): string {
  return keyFields.map((field) => String(record[field])).join('/');
}

/**
 * Orden total y estable: `sortOrder` y, a igualdad, la clave natural. Mongo no
 * garantiza el orden de `find()` sin `sort`, y una lista que baila entre
 * recargas hace que el editor parezca haber movido cosas que nadie tocó.
 */
function compareRecords(keyFields: readonly string[]) {
  return (a: EditorRecord, b: EditorRecord): number => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    const keyA = naturalKey(a, keyFields);
    const keyB = naturalKey(b, keyFields);
    if (keyA < keyB) return -1;
    return keyA > keyB ? 1 : 0;
  };
}

const writeResultSchema = Type.Object(
  {
    key: Type.String(),
    action: Type.String(),
    status: Type.String(),
  },
  { additionalProperties: false },
);

function listResponseSchema(sectionSchema: TObject): TObject {
  return Type.Object(
    {
      section: Type.String(),
      contentVersion: Type.Number(),
      records: Type.Array(
        Type.Composite([sectionSchema, Type.Object({ status: Type.String() })], {
          additionalProperties: false,
        }),
      ),
    },
    { additionalProperties: false },
  );
}

/**
 * Cuerpo del PUT. Los registros se declaran como `Unknown` A PROPÓSITO, y no
 * con el esquema de la sección: Fastify valida el cuerpo con Ajv en modo
 * `coerceTypes`, que ante un `anyOf: [string, null]` da por bueno el `null`
 * COERCIONÁNDOLO a `''`. Los campos opcionales de `pages` (`metaTitle`,
 * `metaDescription`, `ogImageSlug`) se guardarían como cadena vacía, y un
 * consumidor con `metaTitle ?? porDefecto` dejaría de ver el fallback.
 *
 * La validación estricta por registro no se pierde: `setRecords` compila el
 * MISMO esquema con `TypeCompiler` de TypeBox (sin coerción) y devuelve el
 * detalle campo a campo, que esta ruta traduce a `400` con `details`.
 */
const writeBodySchema = Type.Object(
  {
    /**
     * Control de concurrencia optimista: el `contentVersion` que el editor vio
     * al cargar la sección. Sin él, dos pestañas abiertas se pisan en silencio
     * (la segunda reenvía su copia vieja del resto de la sección y revierte lo
     * que guardó la primera, sin error visible).
     */
    expectedContentVersion: Type.Integer({ minimum: 0 }),
    // Tope de lote: el editor guarda lo que el operador tocó, no un volcado
    // arbitrario, y `setRecords` recorre los registros uno a uno.
    records: Type.Array(Type.Unknown(), { minItems: 1, maxItems: 500 }),
  },
  { additionalProperties: false },
);

/** Igual para las tres secciones: el resultado de escritura no depende de la forma. */
const writeResponseSchema = Type.Object(
  {
    section: Type.String(),
    // `null` cuando no hubo escritura efectiva (todo `unchanged`).
    contentVersion: Type.Union([Type.Number(), Type.Null()]),
    // Ni `token` ni `sanitizedFields`: son detalle editorial interno.
    results: Type.Array(writeResultSchema),
  },
  { additionalProperties: false },
);

/**
 * Rutas del editor. `app.ts` solo llama a este plugin con el flag encendido, de
 * ahí que todo el trabajo de arranque (incluida la lectura del HTML) viva
 * DENTRO: a nivel de módulo se ejecutaría también con el editor apagado, y un
 * `dist/` sin el estático copiado tumbaría la API entera —health incluido— por
 * una funcionalidad desactivada.
 */
export function internalEditorRoutes(app: FastifyInstance): void {
  // Primero el guard: se instala en ESTE scope (plugin sin fastify-plugin), así
  // que su allowlist cubre todas las rutas de abajo y ninguna otra.
  registerInternalEditorGuard(app);

  // Una sola lectura, al registrar: el HTML es inmutable en ejecución y leerlo
  // por request pondría el disco en el camino caliente. `import.meta.url`
  // resuelve igual en `src/` (tsx) que en `dist/`, siempre que el build copie
  // el archivo (scripts/build/copy-static.ts).
  const editorHtml = readFileSync(new URL('./editor.html', import.meta.url), 'utf8');

  const repo = new ContentRepo(app.mongo.contentDb);

  // `cors: false` en todas las rutas: @fastify/cors está envuelto en
  // fastify-plugin, así que su hook alcanza también a `/internal/*` y reflejaría
  // `Access-Control-Allow-Origin` para cualquier dominio de CORS_ORIGINS. Un XSS
  // en el sitio público podría entonces leer la sección completa —borradores
  // incluidos— desde el navegador del operador, cuya IP sí está permitida.
  const editorRouteConfig = { cors: false };

  // `hide: true` en todas las rutas: el editor interno no se documenta. El spec
  // OpenAPI enumera exactamente las rutas públicas (test/integration/docs.test.ts)
  // y publicar esta superficie de escritura sin auth de cliente sería, además,
  // un mapa para terceros.
  app.get(
    '/internal/edit',
    { config: editorRouteConfig, schema: { hide: true } },
    (_req, reply) => {
      const nonce = randomBytes(16).toString('base64');
      // Se sobrescribe la CSP de helmet: `reply.header` gana sobre el
      // `setHeader` del middleware porque Fastify vuelca sus cabeceras en el
      // `writeHead` final.
      void reply
        .header('content-security-policy', contentSecurityPolicy(nonce))
        .header('cache-control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(editorHtml.replaceAll(NONCE_PLACEHOLDER, nonce));
    },
  );

  for (const section of EDITOR_SECTIONS) {
    app.get(
      section.path,
      {
        config: editorRouteConfig,
        schema: {
          hide: true,
          response: {
            200: listResponseSchema(section.schema),
            default: errorEnvelopeSchema,
          },
        },
      },
      async (_req, reply) => {
        // La versión se lee ANTES que los documentos, no después. Con el orden
        // inverso, una escritura que caiga entre ambas lecturas devolvería
        // registros viejos sellados con una versión nueva: el PUT posterior
        // pasaría el control optimista y pisaría en silencio esa escritura.
        // Así la misma ventana falla cerrado (versión vieja → 409 al guardar).
        const contentVersion = await repo.getContentVersion();
        const docs = await listSectionDocs(app.mongo.contentDb, section.name);
        const records = docs.map((doc) => section.toRecord(doc));
        records.sort(compareRecords(section.keyFields));

        void reply.header('cache-control', 'no-store');
        return { section: section.name, contentVersion, records };
      },
    );

    app.put(
      section.path,
      {
        // Coste real por petición (hasta 500 pares findOne/replaceOne dentro de
        // una transacción, sobre la misma base que sirve la lectura pública):
        // un tope modesto evita que un bucle del cliente la degrade.
        config: { ...editorRouteConfig, rateLimit: { max: 30, timeWindow: '1 minute' } },
        schema: {
          hide: true,
          body: writeBodySchema,
          response: {
            200: writeResponseSchema,
            default: errorEnvelopeSchema,
          },
        },
      },
      async (req, reply) => {
        const body = req.body as { expectedContentVersion: number; records: unknown[] };
        void reply.header('cache-control', 'no-store');

        // Ventana TOCTOU deliberadamente aceptada: entre esta lectura y la
        // transacción de `setRecords` cabe otra escritura. Cierra el caso real
        // (una pestaña abierta desde hace rato), no una carrera de milisegundos,
        // y el editor es una herramienta interna de un operador a la vez.
        const currentVersion = await repo.getContentVersion();
        if (body.expectedContentVersion !== currentVersion) {
          throw new AppError(
            'CONTENT_VERSION_CONFLICT',
            'El contenido cambió desde que se abrió el editor. Recarga la sección antes de guardar.',
            409,
          );
        }

        try {
          const { results, contentVersion } = await setRecords(
            app.mongo.contentDb,
            section.name,
            body.records,
            // Sin DDL: el proceso HTTP no debe necesitar privilegios de esquema
            // sobre `carrito_content` (ver `setRecords`).
            { publish: true, ensureSetup: false },
          );
          return {
            section: section.name,
            contentVersion,
            results: results.map((result) => ({
              key: result.key,
              action: result.action,
              status: result.status,
            })),
          };
        } catch (err) {
          // La topología (Mongo sin replica set) es un fallo de despliegue, no
          // del cuerpo enviado: su mensaje describe infraestructura y no puede
          // viajar en la envolvente (AGENTS.md). Se traduce a 503 genérico; el
          // detalle queda solo en el log del handler central.
          if (err instanceof ContentTopologyWriteError) {
            throw new AppError(
              ErrorCodes.notReady,
              'El editor no puede guardar en este momento.',
              503,
            );
          }
          // ContentWriteError = entrada rechazada por las reglas editoriales
          // (referencias inexistentes, claves duplicadas, invariantes de
          // publicación): es 400 con el detalle por registro. Cualquier otro
          // error sube al handler central y sale como 500 genérico.
          if (err instanceof ContentWriteError) {
            throw new AppError(
              ErrorCodes.validation,
              err.message,
              400,
              err.details.length > 0 ? { records: err.details } : undefined,
            );
          }
          throw err;
        }
      },
    );
  }
}
