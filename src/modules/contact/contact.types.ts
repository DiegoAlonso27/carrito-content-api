import type { Static } from '@sinclair/typebox';
import type { contactBodySchema, contactResponseSchema } from './contact.schemas.js';

/**
 * Tipos del formulario de contacto (F5).
 *
 * Campos y reglas de negocio heredados del contrato funcional de
 * `formularios-backend-csharp.md` (§ POST /api/contactos: submissionId,
 * nombreApellidos, correo, telefono, dni, mensaje, aceptaTerminos, honeypot
 * `website`, trazabilidad de lectura IsViewed/ViewedAtUtc/ViewedBy), sobre
 * el transporte y la persistencia de esta API (TypeBox + Fastify +
 * MongoDB). `ContactMessageDoc` es la única forma persistida en
 * `carrito_forms` (colección `contact_messages`); nunca incluye IP ni
 * User-Agent. `ContactMessageDto` es lo único que la API devuelve.
 */

export type ContactBody = Static<typeof contactBodySchema>;

export type ContactSubmissionInput = Omit<ContactBody, 'website'> & {
  /**
   * Snapshot del prefijo resuelto al momento del alta (p. ej. `"+51"`): si el
   * catálogo cambiara, el registro histórico no se reinterpreta.
   */
  telefonoPrefijo: string;
};

export type ContactMessageDoc = ContactSubmissionInput & {
  isViewed: boolean;
  viewedAtUtc: Date | null;
  viewedBy: string | null;
  createdAtUtc: Date;
};

export type ContactMessageDto = Static<typeof contactResponseSchema>;
