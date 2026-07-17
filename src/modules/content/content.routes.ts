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
import { ContentReadService } from './content-read.service.js';
import { AppError, ErrorCodes } from '../../shared/errors/app-error.js';

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

const localeParam = Type.Object({ locale: Type.String({ minLength: 2, maxLength: 10 }) });
const collectionParams = Type.Object({
  locale: Type.String({ minLength: 2, maxLength: 10 }),
  slug: Type.String({ minLength: 1, maxLength: 100 }),
});

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
  const service = new ContentReadService(app.mongo.contentDb);
  const rateLimit = {
    max: app.config.RATE_LIMIT_READ_PER_MINUTE,
    timeWindow: '1 minute',
  };

  app.get(
    '/v1/locales',
    {
      config: { rateLimit },
      schema: { response: { 200: localesSchema, 304: Type.Null() } },
    },
    async (req, reply) => {
      const { contentVersion, locales } = await service.getLocales();
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
      schema: { params: localeParam, response: { 200: bundleSchema, 304: Type.Null() } },
    },
    async (req, reply) => {
      const { locale } = req.params as { locale: string };
      const bundle = await service.getBundle(locale);
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
      schema: { params: collectionParams, response: { 200: itemsSchema, 304: Type.Null() } },
    },
    async (req, reply) => {
      const { locale, slug } = req.params as { locale: string; slug: string };
      const bundle = await service.getBundle(locale);
      if (bundle === null) {
        throw new AppError(ErrorCodes.notFound, 'Idioma no disponible.', 404);
      }
      const items = await service.getCollectionItems(locale, slug);
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
