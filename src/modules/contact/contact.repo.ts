import type { Db, Document, WithId } from 'mongodb';
import { MongoServerError } from 'mongodb';
import type { ContactMessageDoc, ContactMessageDto, ContactSubmissionInput } from './contact.types.js';

/**
 * Persistencia del formulario de contacto — única vía de lectura/escritura
 * de `contact_messages`, siempre en `carrito_forms` (jamás en
 * `carrito_content`: separación dura de datos personales, AGENTS.md).
 *
 * `ContactRepo.submit` NUNCA ejecuta DDL (createCollection/collMod/
 * createIndex): exigiría permisos de esquema a la cuenta pública de
 * ejecución en cada POST y crearía una carrera entre las primeras
 * solicitudes concurrentes. `ensureContactSetup` corre una única vez, de
 * forma operativa, vía `scripts/forms/setup-contact.ts` (cuenta de
 * migración distinta — mismo patrón de dos cuentas del contrato heredado,
 * formularios-backend-csharp.md §5.1) o explícitamente en el setup de las
 * pruebas de integración.
 */

export const contactCollections = {
  messages: 'contact_messages',
} as const;

const messagesValidator: Document = {
  $jsonSchema: {
    bsonType: 'object',
    required: [
      'submissionId',
      'nombreApellidos',
      'correo',
      'telefono',
      'dni',
      'mensaje',
      'aceptaTerminos',
      'isViewed',
      'createdAtUtc',
    ],
    properties: {
      submissionId: { bsonType: 'string' },
      nombreApellidos: { bsonType: 'string' },
      correo: { bsonType: 'string' },
      telefono: { bsonType: 'string' },
      dni: { bsonType: 'string' },
      mensaje: { bsonType: 'string' },
      aceptaTerminos: { bsonType: 'bool' },
      isViewed: { bsonType: 'bool' },
      viewedAtUtc: { bsonType: ['date', 'null'] },
      viewedBy: { bsonType: ['string', 'null'] },
      createdAtUtc: { bsonType: 'date' },
    },
  },
};

/**
 * Crea la colección, su validador e índices de forma idempotente.
 *
 * Deliberadamente NO se invoca desde `ContactRepo.submit` (ver cabecera del
 * archivo). El índice único de `submissionId` es lo que sostiene la
 * idempotencia del alta (mismo id ⇒ mismo registro, nunca un duplicado).
 */
export async function ensureContactSetup(db: Db): Promise<void> {
  const existing = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
  );
  if (existing.has(contactCollections.messages)) {
    await db.command({
      collMod: contactCollections.messages,
      validator: messagesValidator,
      validationLevel: 'moderate',
    });
  } else {
    await db.createCollection(contactCollections.messages, {
      validator: messagesValidator,
      validationLevel: 'moderate',
    });
  }

  const col = db.collection(contactCollections.messages);
  await col.createIndex(
    { submissionId: 1 },
    { name: 'ux_contact_messages_submission_id', unique: true },
  );
  await col.createIndex({ createdAtUtc: -1 }, { name: 'ix_contact_messages_created_at' });
}

function isDuplicateKeyError(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

function toDto(doc: WithId<ContactMessageDoc>): ContactMessageDto {
  return {
    id: doc._id.toHexString(),
    receivedAtUtc: doc.createdAtUtc.toISOString(),
    isViewed: doc.isViewed,
  };
}

export interface ContactSubmitResult {
  dto: ContactMessageDto;
  /** false = `submissionId` ya existía; se devolvió el registro previo (200), no se creó otro. */
  created: boolean;
}

export class ContactRepo {
  constructor(private readonly db: Db) {}

  /**
   * Alta idempotente por `submissionId`: un envío repetido (mismo id — p. ej.
   * un reintento de red del cliente) devuelve el registro existente en vez
   * de duplicarlo. Ante una carrera entre dos solicitudes con el mismo id,
   * el índice único deja pasar solo un `insertOne`; el perdedor recupera el
   * documento ganador en vez de fallar.
   */
  async submit(input: ContactSubmissionInput): Promise<ContactSubmitResult> {
    const col = this.db.collection<ContactMessageDoc>(contactCollections.messages);

    const existing = await col.findOne({ submissionId: input.submissionId });
    if (existing !== null) {
      return { dto: toDto(existing), created: false };
    }

    const doc: ContactMessageDoc = {
      ...input,
      isViewed: false,
      viewedAtUtc: null,
      viewedBy: null,
      createdAtUtc: new Date(),
    };

    try {
      const { insertedId } = await col.insertOne(doc);
      return { dto: toDto({ ...doc, _id: insertedId }), created: true };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        const winner = await col.findOne({ submissionId: input.submissionId });
        if (winner !== null) {
          return { dto: toDto(winner), created: false };
        }
      }
      throw err;
    }
  }
}
