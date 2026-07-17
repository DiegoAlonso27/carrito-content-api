/**
 * Error de aplicación con código estable y estado HTTP.
 *
 * Los códigos forman parte del contrato de error público
 * ({ error: { code, message, requestId, details? } }); nunca se exponen
 * stack traces, nombres de colecciones ni detalles de infraestructura.
 */
export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details: Record<string, string[]> | undefined;

  constructor(
    code: string,
    message: string,
    statusCode: number,
    details?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const ErrorCodes = {
  validation: 'VALIDATION_ERROR',
  notFound: 'NOT_FOUND',
  unauthorized: 'UNAUTHORIZED',
  rateLimited: 'RATE_LIMITED',
  notReady: 'SERVICE_NOT_READY',
  internal: 'INTERNAL_ERROR',
} as const;
