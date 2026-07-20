import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { pingMongo } from '../../shared/db/mongo.js';
import { ErrorCodes } from '../../shared/errors/app-error.js';
import { safeErrorLog } from '../../shared/logging/logger.js';
import { errorEnvelopeSchema } from '../../shared/errors/error-schema.js';
import { describeResponse } from '../../shared/docs/openapi-annotations.js';

const okSchema = Type.Object({ status: Type.Literal('ok') });
/**
 * Health checks diferenciados (sin versión /v1: contrato operativo, no público):
 * - liveness: el proceso responde; no toca dependencias.
 * - readiness: capacidad real de atender (ping a ambas bases de MongoDB).
 *   IIS/ARR y el monitoreo deben usar readiness, no liveness.
 */
export function healthRoutes(app: FastifyInstance): void {
  app.get(
    '/health/live',
    {
      schema: {
        tags: ['health'],
        operationId: 'healthLive',
        summary: 'Liveness del proceso',
        description:
          'Indica que el proceso responde. **No consulta dependencias**: que ' +
          'liveness esté en verde no implica que la API pueda atender contenido ' +
          'o formularios — para eso está readiness.',
        response: {
          200: describeResponse(okSchema, 'El proceso está vivo.'),
          default: describeResponse(errorEnvelopeSchema, 'Error con la envolvente estándar.'),
        },
      },
    },
    () => ({
      status: 'ok' as const,
    }),
  );

  app.get(
    '/health/ready',
    {
      schema: {
        tags: ['health'],
        operationId: 'healthReady',
        summary: 'Readiness: capacidad real de atender',
        description:
          'Ejecuta `ping` sobre `MONGO_DB_CONTENT` y `MONGO_DB_FORMS`. Comprueba ' +
          'ambas bases aunque contacto y reclamos estén desactivados. Es la sonda ' +
          'que deben usar IIS/ARR y el monitoreo.\n\n' +
          'Si alguna base no responde devuelve `503 SERVICE_NOT_READY` sin ' +
          'identificar cuál en la respuesta pública.',
        response: {
          200: describeResponse(okSchema, 'Ambas bases de MongoDB responden al ping.'),
          503: describeResponse(
            errorEnvelopeSchema,
            '`SERVICE_NOT_READY`: alguna base no responde. No identifica cuál.',
          ),
          default: describeResponse(errorEnvelopeSchema, 'Error con la envolvente estándar.'),
        },
      },
    },
    async (req, reply) => {
      try {
        await pingMongo(app.mongo);
        return { status: 'ok' as const };
      } catch (err) {
        req.log.warn({ error: safeErrorLog(err) }, 'readiness: MongoDB no disponible');
        return reply.status(503).send({
          error: {
            code: ErrorCodes.notReady,
            message: 'El servicio no está listo para atender solicitudes.',
            requestId: req.id,
          },
        });
      }
    },
  );
}
