import type { Static } from '@sinclair/typebox';
import type {
  complaintPayloadSchema,
  complaintReceiptSchema,
} from './complaints.schemas.js';

/**
 * Tipos del Libro de Reclamaciones (F6).
 *
 * Contrato funcional heredado de `formularios-backend-csharp.md`
 * (§4 POST /api/reclamos, §5 persistencia), adaptado al transporte y
 * persistencia de esta API (TypeBox + Fastify + MongoDB, AGENTS.md). La
 * envolvente `{status,state,value}` del BFF C# NO se replica.
 *
 * Adaptaciones Mongo (ver ADR-007):
 * - El reclamo se persiste como un ÚNICO documento atómico en la colección
 *   `complaints` de `carrito_forms`. MongoDB standalone no tiene transacciones
 *   multi-documento, así que embeber hoja + firma + adjuntos + dispatch en un
 *   solo `insertOne` es lo que garantiza «todo o nada» (§5.6/§5.8 del plan).
 * - Los binarios (PNG de firma y adjuntos) viven en campos `Buffer` del propio
 *   documento; el `response schema` de Fastify es la barrera anti-fuga y NUNCA
 *   los incluye (AGENTS.md).
 *
 * Piezas deferidas por el gate legal P1–P18 (no modeladas aquí): descargos,
 * firma del proveedor y transiciones de estado del «servicio encargado
 * futuro» (§14 del plan).
 */

/** Payload JSON (parte `payload` del multipart), ya validado y normalizado. */
export type ComplaintPayload = Static<typeof complaintPayloadSchema>;

/**
 * Constancia devuelta al presentar el reclamo. Solo datos no sensibles
 * necesarios para imprimir/mostrar la hoja; sin `_id`, binarios ni internos.
 */
export type ComplaintReceiptDto = Static<typeof complaintReceiptSchema>;

export type ConsumerInput = ComplaintPayload['consumer'];
export type GuardianInput = NonNullable<ComplaintPayload['guardian']>;
export type ServiceInput = ComplaintPayload['service'];
export type DetailInput = ComplaintPayload['detail'];
export type DocumentType = ConsumerInput['documentType'];
export type ServiceKind = ServiceInput['type'];
export type ComplaintKind = DetailInput['type'];
export type Gender = ConsumerInput['gender'];
/** El alta pública solo crea `PENDIENTE` (§5.3). Otros estados: servicio futuro. */
export type ComplaintStatus = ComplaintReceiptDto['status'];
/** Snapshot del proveedor desde configuración del backend (§5.5, P8). */
export type ProviderSnapshot = ComplaintReceiptDto['provider'];
/** Metadatos de firma expuestos en la constancia — NUNCA el PNG (§5.4). */
export type SignatureDto = ComplaintReceiptDto['signature'];
/** Metadatos de adjunto expuestos — NUNCA el binario. */
export type AttachmentDto = ComplaintReceiptDto['attachments'][number];
export type DispatchStatus = ComplaintReceiptDto['emailReceipt']['status'];

/**
 * Consumidor PERSISTIDO: añade el snapshot del prefijo resuelto al alta, para
 * que un cambio futuro del catálogo no reinterprete el registro histórico
 * (ADR-010 §4). `phoneDialCode` entra a la hoja canónica firmada pero NUNCA a
 * la constancia: `ComplaintReceiptDto` declara `ConsumerInput` y el response
 * schema tampoco lo declara (doble barrera anti-fuga).
 */
export type ConsumerPersisted = ConsumerInput & { phoneDialCode: string };

/** Firma del consumidor: PNG del trazo + hashes de integridad (§5.8). */
export interface ConsumerSignature {
  method: 'TRAZO_MANUSCRITO';
  contentType: 'image/png';
  sizeBytes: number;
  /** PNG del trazo. Dato personal altamente sensible: nunca en DTO, logs ni correo. */
  content: Buffer;
  /** SHA-256 del PNG (detecta corrupción/sustitución). */
  contentHash: string;
  /** SHA-256 de la serialización canónica de la hoja firmada. */
  signedDocumentHash: string;
  /** Versión de la especificación de serialización canónica. */
  documentVersion: string;
  signedAtUtc: Date;
}

/** Adjunto del consumidor. Binario embebido; metadatos en el DTO. */
export interface ComplaintAttachment {
  /** Orden de subida; sella el hash canónico de la hoja (§5.8). Único por reclamo. */
  uploadOrder: number;
  originalFileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  content: Buffer;
  /** Cuarentena: los adjuntos nacen sin escanear (§6). */
  scanStatus: 'PENDIENTE';
}

/** Outbox de la constancia por correo, embebido (1:1 con el reclamo). */
export interface EmailDispatch {
  recipientEmail: string;
  status: DispatchStatus;
  attemptCount: number;
  lastAttemptAtUtc: Date | null;
  sentAtUtc: Date | null;
  /** Categoría de error, nunca contenido del mensaje ni datos personales. */
  lastErrorCode: string | null;
  templateVersion: string | null;
}

export interface ComplaintConfirmation {
  confirmed: true;
  textVersion: string;
  confirmedAtUtc: Date;
}

/** Documento persistido en `carrito_forms.complaints`. Único y atómico. */
export interface ComplaintDoc {
  submissionId: string;
  complaintCode: string;
  provider: ProviderSnapshot;
  consumer: ConsumerPersisted;
  guardian: GuardianInput | null;
  service: ServiceInput;
  detail: DetailInput;
  confirmation: ComplaintConfirmation;
  signature: ConsumerSignature;
  attachments: ComplaintAttachment[];
  emailDispatch: EmailDispatch;
  status: ComplaintStatus;
  statusUpdatedAtUtc: Date;
  /** NULL en el alta pública; el servicio futuro es el único que lo escribe. */
  statusUpdatedBy: string | null;
  createdAtUtc: Date;
  responseDueAtUtc: Date;
}

/**
 * Vista del reclamo SIN binarios: es lo que devuelven las lecturas del repo
 * (proyección `signature.content` / `attachments[].content` excluidos). Tipar
 * la proyección impide que una lectura de runtime toque el PNG de firma o el
 * contenido de un adjunto por accidente: el compilador ya no ofrece esos
 * campos (§5.1/§5.8, P18). El único punto donde existen los binarios es la
 * escritura (`ComplaintDoc`), que los recibe del request.
 */
export type ComplaintMetadataDoc = Omit<ComplaintDoc, 'signature' | 'attachments'> & {
  signature: Omit<ConsumerSignature, 'content'>;
  attachments: Omit<ComplaintAttachment, 'content'>[];
};
