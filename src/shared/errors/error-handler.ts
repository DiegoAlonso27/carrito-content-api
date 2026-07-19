import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, ErrorCodes } from './app-error.js';
import { safeErrorLog } from '../logging/logger.js';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, string[]>;
  };
}

function buildBody(
  req: FastifyRequest,
  code: string,
  message: string,
  details?: Record<string, string[]>,
): ErrorBody {
  return {
    error: {
      code,
      message,
      requestId: req.id,
      ...(details ? { details } : {}),
    },
  };
}

/** Agrupa los errores de validación de Ajv por campo: { campo: [mensajes] }. */
function groupValidationErrors(
  validation: NonNullable<FastifyError['validation']>,
): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const issue of validation) {
    const missing =
      typeof issue.params?.['missingProperty'] === 'string'
        ? `/${issue.params['missingProperty']}`
        : '';
    const field = (issue.instancePath || missing).replace(/^\//, '').replaceAll('/', '.') || '_';
    (grouped[field] ??= []).push(issue.message ?? 'valor inválido');
  }
  return grouped;
}

/**
 * Manejo centralizado de errores y 404 con el contrato público estándar.
 * Los errores 5xx se registran completos en el log (sanitizado) y se
 * responden con mensaje genérico: nunca stack traces ni detalles internos.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    void reply.status(404).send(buildBody(req, ErrorCodes.notFound, 'Recurso no encontrado.'));
  });

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      void reply.status(err.statusCode).send(buildBody(req, err.code, err.message, err.details));
      return;
    }

    if (err.validation) {
      void reply
        .status(400)
        .send(
          buildBody(
            req,
            ErrorCodes.validation,
            'Datos inválidos.',
            groupValidationErrors(err.validation),
          ),
        );
      return;
    }

    if (err.statusCode === 429) {
      // @fastify/rate-limit ya agregó Retry-After a la respuesta.
      void reply
        .status(429)
        .send(
          buildBody(
            req,
            ErrorCodes.rateLimited,
            'Demasiadas solicitudes. Intenta nuevamente más tarde.',
          ),
        );
      return;
    }

    const statusCode = err.statusCode !== undefined && err.statusCode >= 400 ? err.statusCode : 500;

    if (statusCode >= 500) {
      req.log.error(
        { error: safeErrorLog(err, { includeStackFrames: true }) },
        'error no controlado',
      );
      void reply
        .status(statusCode)
        .send(buildBody(req, ErrorCodes.internal, 'Error interno del servidor.'));
      return;
    }

    // 4xx de Fastify/plugins: código HTTP conservado, mensaje público estable
    // (el mensaje técnico queda solo en el log sanitizado).
    req.log.info({ error: safeErrorLog(err) }, 'error de cliente');
    const { code, message } = publicClientError(statusCode, err.code);
    void reply.status(statusCode).send(buildBody(req, code, message));
  });
}

/** Mensajes públicos estables para 4xx no mapeados a AppError. */
function publicClientError(
  statusCode: number,
  pluginCode: string | undefined,
): { code: string; message: string } {
  switch (statusCode) {
    case 400:
      return { code: ErrorCodes.validation, message: 'Solicitud inválida.' };
    case 401:
      return { code: ErrorCodes.unauthorized, message: 'No autorizado.' };
    case 403:
      return { code: 'FORBIDDEN', message: 'Acceso denegado.' };
    case 404:
      return { code: ErrorCodes.notFound, message: 'Recurso no encontrado.' };
    case 405:
      return { code: 'METHOD_NOT_ALLOWED', message: 'Método no permitido.' };
    case 413:
      return { code: 'PAYLOAD_TOO_LARGE', message: 'Cuerpo demasiado grande.' };
    case 415:
      return { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Tipo de contenido no soportado.' };
    default:
      return {
        code: pluginCode ?? 'REQUEST_ERROR',
        message: 'Solicitud rechazada.',
      };
  }
}
