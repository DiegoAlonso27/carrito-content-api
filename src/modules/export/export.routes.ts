import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { parseExportKeys, requireExportKey } from '../../shared/security/export-key.js';
import { ExportService } from './export.service.js';

/**
 * Export servidor-a-servidor para el build de carrito-front.
 *
 * GET /v1/export/content-cache
 * - Auth: header X-Export-Key (timing-safe, doble clave para rotación;
 *   sin claves configuradas el endpoint queda deshabilitado → 401).
 * - ETag fuerte por contentVersion: sync-content.mjs puede hacer GET
 *   condicional (If-None-Match → 304 sin cuerpo).
 * - Cuerpo 200 pre-serializado y validado contra `contentCacheSchema` en
 *   ExportService (ADR-002: no fast-json-stringify sobre el golden).
 */

const exportHeadersSchema = Type.Object({
  'x-export-key': Type.Optional(Type.String()),
  'if-none-match': Type.Optional(Type.String()),
});

const errorEnvelopeSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String(),
        message: Type.String(),
        requestId: Type.String(),
        details: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export function exportRoutes(app: FastifyInstance): void {
  const service = new ExportService(app.mongo.contentDb);
  const keys = parseExportKeys(app.config.EXPORT_API_KEYS);

  app.get(
    '/v1/export/content-cache',
    {
      schema: {
        headers: exportHeadersSchema,
        response: {
          304: Type.Null(),
          401: errorEnvelopeSchema,
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
      return reply.type('application/json; charset=utf-8').send(snapshot.body);
    },
  );
}
