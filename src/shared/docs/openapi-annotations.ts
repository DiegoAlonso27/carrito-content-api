import type { TSchema } from '@sinclair/typebox';

/**
 * Anotaciones OpenAPI compartidas por las rutas.
 *
 * Este módulo NO importa @fastify/swagger a propósito: lo consumen los módulos
 * de rutas, que se cargan siempre. La definición del spec y de la UI vive en
 * `src/docs/openapi.ts`, que sí importa los plugins y solo se carga cuando las
 * docs están habilitadas.
 *
 * Los headers de respuesta se declaran en `schema.response[<code>].headers`:
 * @fastify/swagger los publica como `responses[<code>].headers`, y como no son
 * palabras clave de JSON Schema sobre el cuerpo, fast-json-stringify los ignora.
 * Anotan el contrato; no cambian la serialización ni el comportamiento.
 */

/**
 * Security scheme del export (definido en `src/docs/openapi.ts`). El nombre se
 * comparte para que la ruta y el componente no se desincronicen: si no
 * coincidieran, @fastify/swagger duplicaría `X-Export-Key` como parámetro suelto
 * además del esquema de seguridad.
 */
export const EXPORT_KEY_SECURITY_SCHEME = 'exportKey';

interface HeaderDoc {
  type: 'string' | 'integer';
  description: string;
}

/**
 * Presente en TODAS las respuestas (hook `onRequest` global en `app.ts`).
 * Es el mismo valor que viaja en `error.requestId` y en los logs: es el dato
 * que debe citar quien reporta una incidencia.
 */
export const requestIdHeader: Record<string, HeaderDoc> = {
  'x-request-id': {
    type: 'string',
    description:
      'Identificador de correlación de la solicitud. Coincide con `error.requestId` ' +
      'y con el campo del log; citarlo al reportar una incidencia.',
  },
};

/** Caché HTTP de las lecturas públicas de contenido y del export. */
export const cacheHeaders: Record<string, HeaderDoc> = {
  ...requestIdHeader,
  etag: {
    type: 'string',
    description:
      'ETag fuerte derivado de `contentVersion`. Reenviarlo en `If-None-Match` ' +
      'para obtener `304` sin cuerpo.',
  },
  'cache-control': {
    type: 'string',
    description: 'Política de caché de la ruta.',
  },
};

/**
 * Anota una respuesta (descripción + headers) sobre un schema TypeBox sin mutar
 * el original: los schemas se comparten entre rutas y entre validación de
 * escritura y serialización de lectura (p. ej. `contentCacheSchema`), así que la
 * anotación debe quedar en la copia de esta ruta.
 *
 * `x-response-description` y no `description`: @fastify/swagger lo usa como
 * descripción de la RESPUESTA y luego lo elimina del schema publicado, en vez de
 * dejarlo pegado como descripción del cuerpo. Sin él, cada respuesta sale como
 * «Default Response» y la UI no distingue un alta nueva de un reintento
 * idempotente, ni un `503` de readiness de uno de gate cerrado.
 *
 * Devuelve el mismo tipo estático `T`, de modo que el type provider sigue
 * infiriendo el cuerpo de la respuesta a partir del schema original.
 */
export function describeResponse<T extends TSchema>(
  schema: T,
  description: string,
  headers: Record<string, HeaderDoc> = requestIdHeader,
): T {
  return { ...schema, 'x-response-description': description, headers };
}
