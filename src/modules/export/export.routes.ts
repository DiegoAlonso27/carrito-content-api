import type { FastifyInstance } from 'fastify';
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
 * - El cuerpo se sirve pre-serializado (ver ExportService: contrato
 *   byte-a-byte, sin serialización por schema).
 */
export function exportRoutes(app: FastifyInstance): void {
  const service = new ExportService(app.mongo.contentDb);
  const keys = parseExportKeys(app.config.EXPORT_API_KEYS);

  app.get('/v1/export/content-cache', async (req, reply) => {
    const provided = req.headers['x-export-key'];
    requireExportKey(typeof provided === 'string' ? provided : undefined, keys);

    const snapshot = await service.get();
    void reply.header('etag', snapshot.etag);
    void reply.header('cache-control', 'no-cache');

    if (req.headers['if-none-match'] === snapshot.etag) {
      return reply.code(304).send();
    }
    return reply.type('application/json; charset=utf-8').send(snapshot.body);
  });
}
