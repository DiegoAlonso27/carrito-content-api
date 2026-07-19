import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { contactBodySchema, contactResponseSchema } from './contact.schemas.js';
import { ContactRepo } from './contact.repo.js';
import { AppError, ErrorCodes } from '../../shared/errors/app-error.js';
import { errorEnvelopeSchema } from '../../shared/errors/error-schema.js';
import type { ContactMessageDto, ContactSubmissionInput } from './contact.types.js';

/**
 * Formulario de contacto público (F5) — POST /v1/contact.
 *
 * Contrato funcional heredado de `formularios-backend-csharp.md`
 * (§ POST /api/contactos): mismos campos y reglas de negocio (idempotencia
 * por `submissionId`, honeypot `website`, `aceptaTerminos` obligatorio,
 * teléfono normalizado a dígitos, trazabilidad de lectura `isViewed`).
 * Transporte, envolvente de error y persistencia son los de esta API
 * (TypeBox + Fastify + MongoDB, AGENTS.md) — no la envolvente
 * `{status,state,value}` del BFF original.
 *
 * - `preValidation` recorta los campos de texto ANTES de que TypeBox mida
 *   longitudes: validar sobre el valor crudo dejaría pasar `"   a   "` por
 *   encima de `minLength` y lo guardaría con contenido inválido.
 * - El teléfono admite `+ - ( ) espacio` en la entrada pero se normaliza a
 *   solo dígitos para contar 6–15 y para persistir — regla de negocio, no
 *   de formato: no es expresable de forma legible como patrón JSON Schema.
 * - El honeypot activado responde éxito (201) sin tocar la base ni loguear
 *   el contenido del envío.
 * - Nunca se guarda IP ni User-Agent; el log de éxito solo lleva el id.
 * - `bodyLimit` pequeño (32 KB): es un formulario de texto, no adjuntos.
 */

interface ContactBody {
  submissionId: string;
  nombreApellidos: string;
  correo: string;
  telefono: string;
  dni: string;
  mensaje: string;
  aceptaTerminos: true;
  website?: string;
}

const TRIMMED_FIELDS = [
  'submissionId',
  'nombreApellidos',
  'correo',
  'telefono',
  'dni',
  'mensaje',
  'website',
] as const;

function trimTextFields(body: Record<string, unknown>): void {
  for (const field of TRIMMED_FIELDS) {
    const value = body[field];
    if (typeof value === 'string') body[field] = value.trim();
  }
}

function fakeHoneypotSuccess(): ContactMessageDto {
  return {
    id: new ObjectId().toHexString(),
    receivedAtUtc: new Date().toISOString(),
    isViewed: false,
  };
}

export function contactRoutes(app: FastifyInstance): void {
  const repo = new ContactRepo(app.mongo.formsDb);
  const rateLimit = {
    max: app.config.RATE_LIMIT_CONTACT_MAX,
    timeWindow: `${String(app.config.RATE_LIMIT_CONTACT_WINDOW_MINUTES)} minutes`,
  };

  app.post(
    '/v1/contact',
    {
      bodyLimit: 32 * 1024,
      config: { rateLimit },
      schema: {
        body: contactBodySchema,
        response: {
          200: contactResponseSchema,
          201: contactResponseSchema,
          default: errorEnvelopeSchema,
        },
      },
      preValidation: (req, _reply, done) => {
        trimTextFields(req.body as Record<string, unknown>);
        done();
      },
    },
    async (req, reply) => {
      const body = req.body as ContactBody;

      if (body.website !== undefined && body.website.length > 0) {
        // Honeypot: éxito falso, nunca se persiste ni se loguea el contenido.
        return reply.code(201).send(fakeHoneypotSuccess());
      }

      const telefono = body.telefono.replace(/\D/g, '');
      if (telefono.length < 6 || telefono.length > 15) {
        throw new AppError(ErrorCodes.validation, 'Datos inválidos.', 400, {
          telefono: ['debe tener entre 6 y 15 dígitos'],
        });
      }

      const input: ContactSubmissionInput = {
        submissionId: body.submissionId,
        nombreApellidos: body.nombreApellidos,
        correo: body.correo,
        telefono,
        dni: body.dni,
        mensaje: body.mensaje,
        aceptaTerminos: body.aceptaTerminos,
      };

      const { dto, created } = await repo.submit(input);
      // Solo el id (no personal) y si fue alta nueva, para correlacionar soporte.
      req.log.info({ contactMessageId: dto.id, created }, 'mensaje de contacto recibido');
      return reply.code(created ? 201 : 200).send(dto);
    },
  );
}
