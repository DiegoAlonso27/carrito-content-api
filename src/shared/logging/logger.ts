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
 *
 * Además se descarta la query string: puede transportar datos personales o
 * secretos (tokens, correos, documentos) y no aporta a la correlación. Solo
 * se registra la ruta.
 *
 * La barrera efectiva para headers, IP y query es este serializador: Pino lo
 * ejecuta antes de `redact`, por lo que los paths de headers no encuentran
 * campos en la salida actual. `redact` queda como defensa secundaria ante un
 * cambio futuro del serializador, no como fundamento de privacidad.
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
        return { id: request.id, method: request.method, url: pathWithoutQuery(request.url) };
      },
    },
    base: {
      service: 'carrito-content-api',
      env: config.NODE_ENV,
    },
  };
}

export interface SafeErrorLogOptions {
  /** Solo para fallos internos: conserva frames de código, nunca la línea con message. */
  includeStackFrames?: boolean;
}

/** Metadatos operativos sin message; opcionalmente incluye solo frames del stack. */
export function safeErrorLog(
  err: unknown,
  options: SafeErrorLogOptions = {},
): {
  type: string;
  code?: string;
  statusCode?: number;
  stack?: string;
} {
  if (typeof err !== 'object' || err === null) return { type: typeof err };

  const type = err instanceof Error ? err.name : 'ErrorLike';
  const code = 'code' in err && typeof err.code === 'string' ? err.code : undefined;
  const statusCode =
    'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : undefined;
  const stack =
    options.includeStackFrames === true && err instanceof Error
      ? sanitizedStackFrames(err.stack)
      : undefined;
  return {
    type,
    ...(code !== undefined ? { code } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(stack !== undefined ? { stack } : {}),
  };
}

/** Elimina la primera línea (`Error: message`) y conserva hasta 20 frames. */
function sanitizedStackFrames(stack: string | undefined): string | undefined {
  if (stack === undefined) return undefined;
  const frames = stack
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => /^\s*at\s/.test(line))
    .slice(0, 20)
    .join('\n')
    .slice(0, 4096);
  return frames.length > 0 ? frames : undefined;
}

/** Ruta sin query string (la query puede llevar datos personales o secretos). */
function pathWithoutQuery(url: string): string {
  const queryStart = url.indexOf('?');
  return queryStart === -1 ? url : url.slice(0, queryStart);
}
