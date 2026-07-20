import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { parseExportKeys, requireExportKey } from '../../shared/security/export-key.js';
import { contentCacheSchema } from '../content/content.schemas.js';
import type { ContentCache } from '../content/content.types.js';
import { ExportService } from './export.service.js';
import { errorEnvelopeSchema } from '../../shared/errors/error-schema.js';
import {
  EXPORT_KEY_SECURITY_SCHEME,
  cacheHeaders,
  describeResponse,
} from '../../shared/docs/openapi-annotations.js';

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
  'x-export-key': Type.Optional(
    Type.String({ description: 'Clave del export (ver esquema de seguridad `exportKey`).' }),
  ),
  'if-none-match': Type.Optional(
    Type.String({ description: 'ETag recibido en una descarga previa; habilita el `304`.' }),
  ),
});

export function exportRoutes(app: FastifyInstance): void {
  const service = new ExportService(app.mongo.contentDb);
  const keys = parseExportKeys(app.config.EXPORT_API_KEYS);

  app.get(
    '/v1/export/content-cache',
    {
      schema: {
        tags: ['export'],
        operationId: 'exportContentCache',
        summary: 'Cache de build (servidor-a-servidor)',
        description:
          'Devuelve el `content-cache.json` que `carrito-front` consume **en build**, ' +
          'compatible byte a byte con el golden (mismo orden de secciones, de claves ' +
          'y de arrays).\n\n' +
          '**Autenticación servidor-a-servidor.** Requiere `X-Export-Key`; la clave ' +
          'se usa solo desde un proceso de build seguro y nunca debe llegar al ' +
          'navegador. Sin claves configuradas en `EXPORT_API_KEYS` el endpoint queda ' +
          'deshabilitado y responde `401` aunque se envíe el header. La autenticación ' +
          'se exige también para obtener un `304`.\n\n' +
          'Orden de secciones: `generatedAtUtc`, `locales`, `settings`, `pages`, ' +
          '`texts`, `assets`, `collections`, `items`, `versionTokens`.',
        security: [{ [EXPORT_KEY_SECURITY_SCHEME]: [] }],
        headers: exportHeadersSchema,
        response: {
          200: describeResponse(
            contentCacheSchema,
            'Cache de build completo, compatible con el golden.',
            cacheHeaders,
          ),
          304: describeResponse(
            Type.Null(),
            'El ETag enviado sigue vigente; sin cuerpo. Requiere autenticación igualmente.',
            cacheHeaders,
          ),
          default: describeResponse(
            errorEnvelopeSchema,
            '`401 UNAUTHORIZED` si la clave falta, es inválida o el export está deshabilitado.',
          ),
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
