import type { FastifyServerOptions, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/env.js';

/**
 * Logger estructurado (pino, integrado en Fastify).
 *
 * Política del proyecto: los logs permiten correlacionar una solicitud
 * (requestId, endpoint, resultado, duración) sin revelar datos personales
 * ni credenciales. La lista de redacción cubre headers sensibles.
 *
 * El serializador `req` por defecto de Fastify incluye `remoteAddress` y
 * `remotePort`: la IP es dato personal y no debe aparecer en logs (AGENTS.md:
 * «logs sin datos personales», «no persistir IP»). Se reemplaza por uno que
 * solo emite método, ruta e id de solicitud — suficiente para correlacionar,
 * sin IP. Aplica a TODA la API (contacto F5 y reclamos F6 incluidos).
 */
export function buildLoggerOptions(config: AppConfig): NonNullable<FastifyServerOptions['logger']> {
  return {
    level: config.LOG_LEVEL,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-export-key"]'],
      censor: '[redactado]',
    },
    serializers: {
      req(request: FastifyRequest) {
        return { id: request.id, method: request.method, url: request.url };
      },
    },
    base: {
      service: 'carrito-content-api',
      env: config.NODE_ENV,
    },
  };
}
