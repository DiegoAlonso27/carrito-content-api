import type { FastifyServerOptions } from 'fastify';
import type { AppConfig } from '../config/env.js';

/**
 * Logger estructurado (pino, integrado en Fastify).
 *
 * Política del proyecto: los logs permiten correlacionar una solicitud
 * (requestId, endpoint, resultado, duración) sin revelar datos personales
 * ni credenciales. Fastify no serializa cuerpos de request por defecto;
 * la lista de redacción cubre headers sensibles y crecerá junto con los
 * módulos de formularios (F5/F6).
 */
export function buildLoggerOptions(config: AppConfig): NonNullable<FastifyServerOptions['logger']> {
  return {
    level: config.LOG_LEVEL,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-export-key"]'],
      censor: '[redactado]',
    },
    base: {
      service: 'carrito-content-api',
      env: config.NODE_ENV,
    },
  };
}
