import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { parseExportKeys, requireExportKey } from '../../shared/security/export-key.js';
import { editorialSnapshotSchema } from '../editorial/editorial-snapshot.schemas.js';
import { EditorialSnapshotService } from '../editorial/editorial-snapshot.service.js';
import { AppError, ErrorCodes } from '../../shared/errors/app-error.js';
import { errorEnvelopeSchema } from '../../shared/errors/error-schema.js';
import {
  EXPORT_KEY_SECURITY_SCHEME,
  cacheHeaders,
  describeResponse,
} from '../../shared/docs/openapi-annotations.js';

/**
 * Export del modelo editorial por bloques (snapshot v2, doc 08).
 *
 * Endpoint NUEVO y en paralelo: `/v1/export/content-cache` no cambia de forma
 * ni de comportamiento hasta el cutover. Un consumidor que no conozca v2 sigue
 * funcionando exactamente igual.
 *
 * Sirve el snapshot ACTIVO almacenado, no una construcción al vuelo: el
 * artefacto servido es bit a bit el que pasó el gate de publicación.
 */

const exportHeadersSchema = Type.Object({
  'x-export-key': Type.Optional(
    Type.String({ description: 'Clave del export (ver esquema de seguridad `exportKey`).' }),
  ),
  'if-none-match': Type.Optional(
    Type.String({ description: 'ETag recibido en una descarga previa; habilita el `304`.' }),
  ),
});

const localeParam = Type.Object({
  locale: Type.String({
    minLength: 2,
    maxLength: 10,
    description: 'Locale del snapshot (p. ej. `es-PE`).',
  }),
});

export function editorialExportRoutes(app: FastifyInstance): void {
  const service = new EditorialSnapshotService(app.mongo.contentDb);
  const keys = parseExportKeys(app.config.EXPORT_API_KEYS);

  app.get(
    '/v1/export/editorial/:locale',
    {
      schema: {
        tags: ['export'],
        operationId: 'exportEditorialSnapshot',
        summary: 'Snapshot editorial versionado (servidor-a-servidor)',
        description:
          'Devuelve el snapshot editorial **activo** del locale: destinos compuestos por ' +
          'bloques, localidades, puntos de embarque, servicios, comodidades, medios y ' +
          'redirecciones, con `manifest` por documento y `checksum` SHA-256.\n\n' +
          'Formato nuevo y paralelo: no sustituye a `/v1/export/content-cache`, que ' +
          'mantiene su contrato sin cambios.\n\n' +
          'El snapshot se publica con `editorial:snapshot --publish`. Si el locale no ' +
          'tiene snapshot activo, responde `404 NOT_FOUND`: no se construye nada al ' +
          'vuelo. El ETag es la versión del snapshot, así que solo cambia cuando se ' +
          'publica o se revierte una versión.',
        security: [{ [EXPORT_KEY_SECURITY_SCHEME]: [] }],
        params: localeParam,
        headers: exportHeadersSchema,
        response: {
          200: describeResponse(
            editorialSnapshotSchema,
            'Snapshot editorial activo del locale.',
            cacheHeaders,
          ),
          304: describeResponse(
            Type.Null(),
            'El ETag enviado sigue vigente; sin cuerpo. Requiere autenticación igualmente.',
            cacheHeaders,
          ),
          default: describeResponse(
            errorEnvelopeSchema,
            '`401 UNAUTHORIZED` sin clave válida; `404 NOT_FOUND` si el locale no tiene ' +
              'snapshot activo.',
          ),
        },
      },
    },
    async (req, reply) => {
      const provided = req.headers['x-export-key'];
      requireExportKey(typeof provided === 'string' ? provided : undefined, keys);

      const { locale } = req.params as { locale: string };
      const snapshot = await service.getActive(locale);
      if (snapshot === null) {
        throw new AppError(
          ErrorCodes.notFound,
          'No hay snapshot editorial activo para ese idioma.',
          404,
        );
      }

      void reply.header('etag', snapshot.etag);
      void reply.header('cache-control', 'no-cache');
      if (req.headers['if-none-match'] === snapshot.etag) {
        return reply.code(304).send();
      }

      return JSON.parse(snapshot.body) as unknown;
    },
  );
}
