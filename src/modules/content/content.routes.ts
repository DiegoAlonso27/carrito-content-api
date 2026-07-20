import type { FastifyInstance, FastifyReply } from 'fastify';
import { Type } from '@sinclair/typebox';
import {
  cacheAssetSchema,
  cacheCollectionSchema,
  cacheItemSchema,
  cacheLocaleSchema,
  cachePageSchema,
  cacheSettingSchema,
  cacheTextSchema,
} from './content.schemas.js';
import { ContentReader } from './content-read.js';
import { AppError, ErrorCodes } from '../../shared/errors/app-error.js';
import { errorEnvelopeSchema } from '../../shared/errors/error-schema.js';
import { cacheHeaders, describeResponse } from '../../shared/docs/openapi-annotations.js';

/**
 * Endpoints públicos de contenido (runtime, consumidos por el navegador).
 *
 * - DTOs v1 con response schema (barrera anti-fuga: solo salen los campos
 *   declarados; jamás _id ni el sobre editorial).
 * - Caché HTTP: ETag fuerte por contentVersion + Cache-Control con
 *   stale-while-revalidate — si la API cae, los intermediarios pueden servir
 *   contenido levemente desactualizado en vez de errores.
 * - Rate limit por IP (config por ruta; el 429 sale por el
 *   errorResponseBuilder global con la envolvente estándar).
 */

const bundleItemSchema = Type.Omit(cacheItemSchema, ['rowVersionToken']);

const bundleSchema = Type.Object(
  {
    locale: Type.String(),
    contentVersion: Type.Number(),
    settings: Type.Array(cacheSettingSchema),
    assets: Type.Array(cacheAssetSchema),
    collections: Type.Array(cacheCollectionSchema),
    pages: Type.Array(cachePageSchema),
    texts: Type.Array(cacheTextSchema),
    items: Type.Array(bundleItemSchema),
  },
  { additionalProperties: false },
);

const localesSchema = Type.Object(
  { locales: Type.Array(cacheLocaleSchema) },
  { additionalProperties: false },
);

const itemsSchema = Type.Object(
  { items: Type.Array(bundleItemSchema) },
  { additionalProperties: false },
);

const localeParam = Type.Object({
  locale: Type.String({
    minLength: 2,
    maxLength: 10,
    description: 'Código de locale publicado (p. ej. `es`).',
  }),
});
const collectionParams = Type.Object({
  locale: Type.String({
    minLength: 2,
    maxLength: 10,
    description: 'Código de locale publicado (p. ej. `es`).',
  }),
  slug: Type.String({
    minLength: 1,
    maxLength: 100,
    description: 'Slug de la colección (p. ej. `faqs`).',
  }),
});

/** Lectura condicional: `If-None-Match` con el ETag vigente devuelve `304`. */
const conditionalReadHeaders = Type.Object({
  'if-none-match': Type.Optional(
    Type.String({ description: 'ETag recibido en una respuesta previa.' }),
  ),
});

const notModifiedResponse = describeResponse(
  Type.Null(),
  'El ETag enviado sigue vigente; sin cuerpo.',
  cacheHeaders,
);
const errorResponse = describeResponse(
  errorEnvelopeSchema,
  'Error con la envolvente estándar (`404 NOT_FOUND` si el recurso no existe).',
);

const CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=3600';

function withHttpCache(
  reply: FastifyReply,
  contentVersion: number,
  ifNoneMatch: string | undefined,
): boolean {
  const etag = `"content-v${String(contentVersion)}"`;
  void reply.header('etag', etag);
  void reply.header('cache-control', CACHE_CONTROL);
  return ifNoneMatch === etag;
}

export function contentRoutes(app: FastifyInstance): void {
  const reader = new ContentReader(app.mongo.contentDb);
  const rateLimit = {
    max: app.config.RATE_LIMIT_READ_PER_MINUTE,
    timeWindow: '1 minute',
  };

  app.get(
    '/v1/locales',
    {
      config: { rateLimit },
      schema: {
        tags: ['content'],
        operationId: 'listLocales',
        summary: 'Locales publicados',
        description:
          'Lista únicamente los locales en estado `published`, con `code`, `name`, ' +
          '`isDefault`, `isActive` y `sortOrder`.',
        headers: conditionalReadHeaders,
        response: {
          200: describeResponse(localesSchema, 'Locales publicados.', cacheHeaders),
          304: notModifiedResponse,
          default: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const { contentVersion, locales } = await reader.getLocales();
      if (withHttpCache(reply, contentVersion, req.headers['if-none-match'])) {
        return reply.code(304).send();
      }
      return { locales };
    },
  );

  app.get(
    '/v1/content/:locale',
    {
      config: { rateLimit },
      schema: {
        tags: ['content'],
        operationId: 'getContentBundle',
        summary: 'Bundle runtime por locale',
        description:
          'Devuelve el contenido publicado del locale: `settings`, `assets`, ' +
          '`collections`, `pages`, `texts` e `items`. Los items **no** incluyen ' +
          '`rowVersionToken` (es token editorial interno).\n\n' +
          'Para un locale distinto del default, la API completa las claves ausentes ' +
          'con el documento del locale default y conserva en cada documento el ' +
          '`localeCode` de su origen.\n\n' +
          'Un locale inexistente o no atendible devuelve `404 NOT_FOUND`.',
        params: localeParam,
        headers: conditionalReadHeaders,
        response: {
          200: describeResponse(bundleSchema, 'Bundle publicado del locale.', cacheHeaders),
          304: notModifiedResponse,
          default: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const { locale } = req.params as { locale: string };
      const bundle = await reader.getBundle(locale);
      if (bundle === null) {
        throw new AppError(ErrorCodes.notFound, 'Idioma no disponible.', 404);
      }
      if (withHttpCache(reply, bundle.contentVersion, req.headers['if-none-match'])) {
        return reply.code(304).send();
      }
      return bundle;
    },
  );

  app.get(
    '/v1/content/:locale/collections/:slug/items',
    {
      config: { rateLimit },
      schema: {
        tags: ['content'],
        operationId: 'listCollectionItems',
        summary: 'Items publicados de una colección',
        description:
          'Devuelve los items publicados de la colección en el locale indicado, ' +
          'sin `rowVersionToken`. Locale o colección inexistentes devuelven ' +
          '`404 NOT_FOUND`.',
        params: collectionParams,
        headers: conditionalReadHeaders,
        response: {
          200: describeResponse(itemsSchema, 'Items publicados de la colección.', cacheHeaders),
          304: notModifiedResponse,
          default: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const { locale, slug } = req.params as { locale: string; slug: string };
      const bundle = await reader.getBundle(locale);
      if (bundle === null) {
        throw new AppError(ErrorCodes.notFound, 'Idioma no disponible.', 404);
      }
      const items = await reader.getCollectionItems(locale, slug);
      if (items === null) {
        throw new AppError(ErrorCodes.notFound, 'Colección no encontrada.', 404);
      }
      if (withHttpCache(reply, bundle.contentVersion, req.headers['if-none-match'])) {
        return reply.code(304).send();
      }
      return { items };
    },
  );
}
