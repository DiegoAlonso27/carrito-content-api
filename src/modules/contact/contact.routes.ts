import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { contactBodySchema, contactResponseSchema } from './contact.schemas.js';
import { ContactRepo } from './contact.repo.js';
import { resolveCountryPhone } from '../../shared/validation/country-phone.js';
import { errorEnvelopeSchema } from '../../shared/errors/error-schema.js';
import { describeResponse } from '../../shared/docs/openapi-annotations.js';
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
 * - El teléfono admite `- ( ) espacio` en la entrada pero se normaliza a solo
 *   dígitos nacionales; su longitud válida depende de `telefonoPais`
 *   (`resolveCountryPhone`, ADR-010) — regla de negocio cruzada entre dos
 *   campos, no expresable de forma legible como patrón JSON Schema. Se
 *   persiste el ISO2 y un snapshot del prefijo, nunca el valor crudo.
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
  telefonoPais: string;
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
  'telefonoPais',
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
        tags: ['contact'],
        operationId: 'submitContactMessage',
        summary: 'Alta idempotente de mensaje de contacto',
        description:
          'Registra un mensaje del formulario público de contacto.\n\n' +
          '- `201`: alta nueva.\n' +
          '- `200`: reintento del mismo `submissionId`; devuelve el mismo registro ' +
          '(idempotencia).\n\n' +
          'Los strings se recortan antes de validar. El teléfono viaja en dos campos: ' +
          '`telefonoPais` (ISO2 del catálogo de prefijos) y `telefono` (dígitos ' +
          'nacionales; admite `- ( ) espacio` como separadores, **no** `+`). El ' +
          'servidor valida la longitud según el país y persiste los dígitos, el ISO2 y ' +
          'un snapshot del prefijo; un país fuera del catálogo o un número que no ' +
          'cumple su regla devuelven `400 VALIDATION_ERROR` en el campo ' +
          'correspondiente.\n\n' +
          'La respuesta contiene únicamente `id`, `receivedAtUtc` e `isViewed`: nunca ' +
          'devuelve el contenido enviado. La API no persiste IP ni User-Agent, y el ' +
          'log de éxito solo lleva el identificador.\n\n' +
          'Cuerpo máximo 32 KiB. Rate limit por IP según `RATE_LIMIT_CONTACT_MAX` y ' +
          '`RATE_LIMIT_CONTACT_WINDOW_MINUTES`. Disponible solo con ' +
          '`FEATURE_CONTACT_ENABLED=true`; con el kill-switch en `false` la ruta no se ' +
          'registra y responde `404 NOT_FOUND`.',
        body: contactBodySchema,
        response: {
          200: describeResponse(
            contactResponseSchema,
            'Reintento del mismo `submissionId`: devuelve el registro ya existente.',
          ),
          201: describeResponse(contactResponseSchema, 'Mensaje registrado (alta nueva).'),
          default: describeResponse(
            errorEnvelopeSchema,
            '`400 VALIDATION_ERROR` con `details` por campo; `429 RATE_LIMITED` al agotar el ' +
              'presupuesto de la ruta.',
          ),
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

      const phone = resolveCountryPhone(body.telefonoPais, body.telefono, {
        phone: 'telefono',
        country: 'telefonoPais',
      });

      const input: ContactSubmissionInput = {
        submissionId: body.submissionId,
        nombreApellidos: body.nombreApellidos,
        correo: body.correo,
        telefono: phone.nationalNumber,
        telefonoPais: phone.iso2,
        telefonoPrefijo: phone.dialCode,
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
