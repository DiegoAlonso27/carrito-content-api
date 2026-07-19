import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { parseExportKeys, requireExportKey } from '../../shared/security/export-key.js';
import { contentCacheSchema } from '../content/content.schemas.js';
import type { ContentCache } from '../content/content.types.js';
import { ExportService } from './export.service.js';
import { errorEnvelopeSchema } from '../../shared/errors/error-schema.js';

/**
 * Export servidor-a-servidor para el build de carrito-front.
 *
 * GET /v1/export/content-cache
 * - Auth: header X-Export-Key (timing-safe, doble clave para rotación;
 *   sin claves configuradas el endpoint queda deshabilitado → 401).
 * - ETag fuerte por contentVersion: sync-content.mjs puede hacer GET
 *   condicional (If-None-Match → 304 sin cuerpo).
 * - Response schema 200 = contentCacheSchema: barrera anti-fuga Fastify
 *   (serialización por schema; el golden exige el mismo orden de claves).
 */

const exportHeadersSchema = Type.Object({
  'x-export-key': Type.Optional(Type.String()),
  'if-none-match': Type.Optional(Type.String()),
});

export function exportRoutes(app: FastifyInstance): void {
  const service = new ExportService(app.mongo.contentDb);
  const keys = parseExportKeys(app.config.EXPORT_API_KEYS);

  app.get(
    '/v1/export/content-cache',
    {
      schema: {
        headers: exportHeadersSchema,
        response: {
          200: contentCacheSchema,
          304: Type.Null(),
          default: errorEnvelopeSchema,
        },
      },
    },
    async (req, reply) => {
      const provided = req.headers['x-export-key'];
      requireExportKey(typeof provided === 'string' ? provided : undefined, keys);

      const snapshot = await service.get();
      void reply.header('etag', snapshot.etag);
      void reply.header('cache-control', 'no-cache');

      if (req.headers['if-none-match'] === snapshot.etag) {
        return reply.code(304).send();
      }

      // Barrera Fastify: serialización vía contentCacheSchema (sin serializer
      // personalizado). El builder ya validó la forma; el test de contrato
      // exige que la salida coincida byte-a-byte con el golden.
      return JSON.parse(snapshot.body) as ContentCache;
    },
  );
}
