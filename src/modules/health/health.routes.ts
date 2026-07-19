import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { pingMongo } from '../../shared/db/mongo.js';
import { ErrorCodes } from '../../shared/errors/app-error.js';
import { safeErrorLog } from '../../shared/logging/logger.js';
import { errorEnvelopeSchema } from '../../shared/errors/error-schema.js';

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
    { schema: { response: { 200: okSchema, default: errorEnvelopeSchema } } },
    () => ({
      status: 'ok' as const,
    }),
  );

  app.get(
    '/health/ready',
    { schema: { response: { 200: okSchema, default: errorEnvelopeSchema } } },
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
