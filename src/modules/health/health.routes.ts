import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { pingMongo } from '../../shared/db/mongo.js';
import { ErrorCodes } from '../../shared/errors/app-error.js';

const okSchema = Type.Object({ status: Type.Literal('ok') });
const errorSchema = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    requestId: Type.String(),
  }),
});

/**
 * Health checks diferenciados (sin versión /v1: contrato operativo, no público):
 * - liveness: el proceso responde; no toca dependencias.
 * - readiness: capacidad real de atender (ping a ambas bases de MongoDB).
 *   IIS/ARR y el monitoreo deben usar readiness, no liveness.
 */
export function healthRoutes(app: FastifyInstance): void {
  app.get('/health/live', { schema: { response: { 200: okSchema } } }, () => ({
    status: 'ok' as const,
  }));

  app.get(
    '/health/ready',
    { schema: { response: { 200: okSchema, 503: errorSchema } } },
    async (req, reply) => {
      try {
        await pingMongo(app.mongo);
        return { status: 'ok' as const };
      } catch (err) {
        req.log.warn({ err }, 'readiness: MongoDB no disponible');
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
