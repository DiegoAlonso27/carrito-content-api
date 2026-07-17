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

export interface ContactSubmissionInput {
  /** UUID v4 generado por el cliente; clave de idempotencia del envío. */
  submissionId: string;
  nombreApellidos: string;
  correo: string;
  /** Solo dígitos (normalizado: se descartan +, espacios, guiones y paréntesis antes de guardar). */
  telefono: string;
  dni: string;
  mensaje: string;
  aceptaTerminos: true;
}

export type ContactMessageDoc = ContactSubmissionInput & {
  isViewed: boolean;
  viewedAtUtc: Date | null;
  viewedBy: string | null;
  createdAtUtc: Date;
};

export interface ContactMessageDto {
  id: string;
  receivedAtUtc: string;
  isViewed: boolean;
}
