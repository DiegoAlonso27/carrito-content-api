import type { Db, Document, WithId } from 'mongodb';
import { MongoServerError } from 'mongodb';
import { listedIndexNames } from '../../shared/db/indexes.js';
import type {
  ComplaintDoc,
  ComplaintMetadataDoc,
  ComplaintReceiptDto,
  DispatchStatus,
} from './complaints.types.js';

/**
 * Persistencia del Libro de Reclamaciones (F6) — única vía de lectura/escritura
 * de `complaints`, siempre en `carrito_forms` (jamás en `carrito_content`:
 * separación dura de datos personales, AGENTS.md).
 *
 * Atomicidad (§5.8): el reclamo se guarda como un ÚNICO documento (hoja + firma
 * + adjuntos + dispatch). MongoDB standalone no tiene transacciones multi-doc,
 * así que `insertOne` es la unidad atómica «todo o nada»: si la firma o un
 * adjunto no se pudieron preparar, la ruta ni siquiera llama a `submit` y no
 * existe reclamo (la constancia nunca miente).
 *
 * `submit` NUNCA ejecuta DDL: `ensureComplaintsSetup` corre una única vez de
 * forma operativa (scripts/forms/setup-complaints.ts, cuenta de migración) o en
 * el setup de las pruebas — mismo patrón de dos cuentas que contacto.
 */

export const complaintsCollections = {
  complaints: 'complaints',
} as const;

export const obsoleteComplaintsIndexNames = ['ix_complaints_created_at'] as const;

const complaintsValidator: Document = {
  $jsonSchema: {
    bsonType: 'object',
    required: [
      'submissionId',
      'complaintCode',
      'provider',
      'consumer',
      'service',
      'detail',
      'confirmation',
      'signature',
      'attachments',
      'emailDispatch',
      'status',
      'createdAtUtc',
      'responseDueAtUtc',
    ],
    properties: {
      submissionId: { bsonType: 'string' },
      complaintCode: { bsonType: 'string' },
      provider: { bsonType: 'object' },
      consumer: { bsonType: 'object' },
      guardian: { bsonType: ['object', 'null'] },
      service: { bsonType: 'object' },
      detail: { bsonType: 'object' },
      confirmation: { bsonType: 'object' },
      signature: { bsonType: 'object' },
      attachments: { bsonType: 'array' },
      emailDispatch: { bsonType: 'object' },
      status: { enum: ['PENDIENTE'] },
      statusUpdatedBy: { bsonType: ['string', 'null'] },
      createdAtUtc: { bsonType: 'date' },
      responseDueAtUtc: { bsonType: 'date' },
    },
  },
};

/**
 * Crea la colección, su validador e índices de forma idempotente. El índice
 * único de `submissionId` sostiene la idempotencia del alta; el de
 * `complaintCode` garantiza unicidad del código no predecible.
 */
export async function ensureComplaintsSetup(db: Db): Promise<void> {
  const existing = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
  );
  if (existing.has(complaintsCollections.complaints)) {
    await db.command({
      collMod: complaintsCollections.complaints,
      validator: complaintsValidator,
      validationLevel: 'moderate',
    });
  } else {
    await db.createCollection(complaintsCollections.complaints, {
      validator: complaintsValidator,
      validationLevel: 'moderate',
    });
  }

  const col = db.collection(complaintsCollections.complaints);
  await col.createIndex({ submissionId: 1 }, { name: 'ux_complaints_submission_id', unique: true });
  await col.createIndex({ complaintCode: 1 }, { name: 'ux_complaints_code', unique: true });
}

/** Detecta índices obsoletos conocidos sin ejecutar dropIndex. */
export async function findObsoleteComplaintsIndexes(db: Db): Promise<string[]> {
  const exists = await db
    .listCollections({ name: complaintsCollections.complaints }, { nameOnly: true })
    .hasNext();
  if (!exists) return [];
  const names = listedIndexNames(
    await db.collection(complaintsCollections.complaints).listIndexes().toArray(),
  );
  return obsoleteComplaintsIndexNames.filter((name) => names.has(name));
}

function isDuplicateKeyError(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

/**
 * DTO de constancia: nunca binarios de firma/adjuntos, nunca `_id`. Acepta la
 * vista SIN binarios, así que ni siquiera tiene acceso al PNG ni al contenido
 * de los adjuntos (el tipo lo impide, no solo la convención).
 */
export function toReceiptDto(doc: WithId<ComplaintMetadataDoc>): ComplaintReceiptDto {
  return {
    code: doc.complaintCode,
    receivedAtUtc: doc.createdAtUtc.toISOString(),
    status: doc.status,
    responseDueAtUtc: doc.responseDueAtUtc.toISOString(),
    provider: doc.provider,
    sheet: {
      consumer: doc.consumer,
      guardian: doc.guardian,
      service: doc.service,
      detail: doc.detail,
      confirmedAtUtc: doc.confirmation.confirmedAtUtc.toISOString(),
      confirmationTextVersion: doc.confirmation.textVersion,
    },
    signature: {
      type: 'CONSUMIDOR',
      method: doc.signature.method,
      signedAtUtc: doc.signature.signedAtUtc.toISOString(),
      signedDocumentHash: doc.signature.signedDocumentHash,
      contentHash: doc.signature.contentHash,
      documentVersion: doc.signature.documentVersion,
    },
    attachments: doc.attachments.map((a) => ({
      uploadOrder: a.uploadOrder,
      fileName: a.originalFileName,
      sizeBytes: a.sizeBytes,
      sha256: a.sha256,
    })),
    emailReceipt: { recipient: doc.emailDispatch.recipientEmail, status: doc.emailDispatch.status },
  };
}

export interface ComplaintSubmitResult {
  dto: ComplaintReceiptDto;
  /** false = `submissionId` ya existía; se devolvió el registro previo (200). */
  created: boolean;
  /** _id del documento recién creado, para actualizar el dispatch tras el envío. */
  insertedId: WithId<ComplaintDoc>['_id'] | null;
}

/**
 * Proyección que excluye los binarios (PNG de firma y contenido de adjuntos).
 * Ninguna lectura de runtime necesita el binario: la constancia se construye
 * solo con metadatos y hashes. Así la cuenta de ejecución nunca los carga en
 * memoria en una lectura — complemento en la app de la restricción de acceso
 * al binario que exige el diseño heredado (§5.1/§5.8, P18). El aislamiento
 * fuerte (que la cuenta Mongo NO pueda leer el binario) es privilegio de BD y
 * se define al cerrar P18; en el código nunca se proyecta el binario en lectura.
 */
const METADATA_PROJECTION = {
  'signature.content': 0,
  'attachments.content': 0,
} as const;

export class ComplaintRepo {
  constructor(private readonly db: Db) {}

  /** Lectura sin binarios: solo metadatos (para la constancia idempotente). */
  async findBySubmissionId(submissionId: string): Promise<WithId<ComplaintMetadataDoc> | null> {
    return this.db
      .collection<ComplaintDoc>(complaintsCollections.complaints)
      .findOne<WithId<ComplaintMetadataDoc>>({ submissionId }, { projection: METADATA_PROJECTION });
  }

  /**
   * Alta idempotente por `submissionId`: un reintento (mismo id) devuelve el
   * registro existente en vez de duplicarlo. Ante una carrera, el índice único
   * deja pasar un solo `insertOne`; el perdedor recupera el ganador.
   *
   * Las lecturas de deduplicación proyectan sin binarios: la respuesta solo
   * necesita metadatos y no debe traer el PNG de firma ni los adjuntos.
   */
  async submit(doc: ComplaintDoc): Promise<ComplaintSubmitResult> {
    const col = this.db.collection<ComplaintDoc>(complaintsCollections.complaints);

    const existing = await col.findOne<WithId<ComplaintMetadataDoc>>(
      { submissionId: doc.submissionId },
      { projection: METADATA_PROJECTION },
    );
    if (existing !== null) {
      return { dto: toReceiptDto(existing), created: false, insertedId: null };
    }

    try {
      const { insertedId } = await col.insertOne(doc);
      return { dto: toReceiptDto({ ...doc, _id: insertedId }), created: true, insertedId };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        const winner = await col.findOne<WithId<ComplaintMetadataDoc>>(
          { submissionId: doc.submissionId },
          { projection: METADATA_PROJECTION },
        );
        if (winner !== null) {
          return { dto: toReceiptDto(winner), created: false, insertedId: null };
        }
      }
      throw err;
    }
  }

  /**
   * Actualiza el sub-documento `emailDispatch` tras el intento de envío inline.
   * Un fallo aquí NUNCA revierte el reclamo (el registro ya es válido, §5.6).
   */
  async updateDispatch(
    insertedId: WithId<ComplaintDoc>['_id'],
    patch: {
      status: DispatchStatus;
      sentAtUtc: Date | null;
      lastErrorCode: string | null;
      templateVersion: string | null;
    },
  ): Promise<void> {
    await this.db.collection<ComplaintDoc>(complaintsCollections.complaints).updateOne(
      { _id: insertedId },
      {
        $set: {
          'emailDispatch.status': patch.status,
          'emailDispatch.attemptCount': 1,
          'emailDispatch.lastAttemptAtUtc': new Date(),
          'emailDispatch.sentAtUtc': patch.sentAtUtc,
          'emailDispatch.lastErrorCode': patch.lastErrorCode,
          'emailDispatch.templateVersion': patch.templateVersion,
        },
      },
    );
  }
}
