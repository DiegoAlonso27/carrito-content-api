import type { ClientSession, Db, Document, Filter } from 'mongodb';
import {
  editorialCollectionIndexes,
  editorialCollections,
  editorialCollectionValidators,
} from './editorial.collections.js';
import { ContentTopologyError, isTransactionUnsupported } from '../content/content.repo.js';
import type {
  AmenityDoc,
  BoardingPointDoc,
  DestinationDoc,
  EditorialDocStatus,
  EditorialMetaDoc,
  LocalityDoc,
  ReviewQueueDoc,
  ServiceDoc,
} from './editorial.types.js';

/**
 * Única vía de persistencia del modelo editorial (AGENTS.md: persistencia solo
 * en `*.repo.ts`).
 *
 * Usa su propio contador (`meta/_id:'editorial'`): una edición editorial no
 * debe invalidar el ETag del export flat que consume el front hoy.
 */
export class EditorialRepo {
  constructor(private readonly db: Db) {}

  async ensureSetup(): Promise<void> {
    const existing = new Set(
      (await this.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
    );

    for (const [name, validator] of Object.entries(editorialCollectionValidators)) {
      if (existing.has(name)) {
        await this.db.command({ collMod: name, validator, validationLevel: 'moderate' });
      } else {
        await this.db.createCollection(name, { validator, validationLevel: 'moderate' });
      }
    }
    for (const name of [editorialCollections.reviewQueue, editorialCollections.meta]) {
      if (!existing.has(name)) await this.db.createCollection(name);
    }

    for (const spec of editorialCollectionIndexes) {
      await this.db
        .collection(spec.collection)
        .createIndex(spec.keys, { name: spec.name, unique: spec.unique });
    }
  }

  // ── Meta ──────────────────────────────────────────────────────────────────

  async getMeta(): Promise<EditorialMetaDoc | null> {
    return this.db
      .collection<EditorialMetaDoc>(editorialCollections.meta)
      .findOne({ _id: 'editorial' });
  }

  async getEditorialVersion(): Promise<number> {
    const meta = await this.getMeta();
    return meta?.editorialVersion ?? 0;
  }

  // ── Lectura ───────────────────────────────────────────────────────────────

  async findById<T>(collection: string, id: string): Promise<T | null> {
    return this.db.collection(collection).findOne({ id }) as Promise<T | null>;
  }

  async findAll<T>(collection: string, filter: Filter<Document> = {}): Promise<T[]> {
    return this.db.collection(collection).find(filter).toArray() as Promise<T[]>;
  }

  async findPublished<T>(collection: string): Promise<T[]> {
    return this.findAll<T>(collection, { status: 'published' });
  }

  async countByStatus(collection: string): Promise<Record<string, number>> {
    const groups = await this.db
      .collection(collection)
      .aggregate<{ _id: string; count: number }>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      .toArray();
    return Object.fromEntries(groups.map((g) => [g._id, g.count]));
  }

  /** Snapshot completo del grafo editorial: lo usan validación y export. */
  async loadGraph(): Promise<EditorialGraph> {
    const c = editorialCollections;
    const [localities, destinations, boardingPoints, services, amenities] = await Promise.all([
      this.findAll<LocalityDoc>(c.localities),
      this.findAll<DestinationDoc>(c.destinations),
      this.findAll<BoardingPointDoc>(c.boardingPoints),
      this.findAll<ServiceDoc>(c.services),
      this.findAll<AmenityDoc>(c.amenities),
    ]);
    return { localities, destinations, boardingPoints, services, amenities };
  }

  async listReviewQueue(state?: 'open' | 'resolved'): Promise<ReviewQueueDoc[]> {
    const filter = state === undefined ? {} : { state };
    return this.findAll<ReviewQueueDoc>(editorialCollections.reviewQueue, filter);
  }

  // ── Escritura ─────────────────────────────────────────────────────────────

  /**
   * Ejecuta `fn` y el bump de `editorialVersion` en una transacción.
   * Standalone no está soportado para mutaciones (ADR-001).
   */
  async withWrite<T>(
    fn: (tx: EditorialModelTx) => Promise<{ result: T; wrote: boolean }>,
  ): Promise<{ result: T; editorialVersion: number | null }> {
    const session = this.db.client.startSession();
    try {
      let outcome: { result: T; wrote: boolean } | undefined;
      let editorialVersion: number | null = null;

      try {
        await session.withTransaction(async () => {
          const tx = new EditorialModelTx(this.db, session);
          outcome = await fn(tx);
          if (outcome.wrote) {
            editorialVersion = await tx.bumpEditorialVersion();
          }
        });
      } catch (err) {
        if (isTransactionUnsupported(err)) {
          throw new ContentTopologyError(
            'Las escrituras editoriales requieren MongoDB en replica set ' +
              '(transacciones multi-documento). Standalone no está soportado ' +
              'para mutaciones (ADR-001).',
          );
        }
        throw err;
      }

      if (outcome === undefined) throw new Error('transacción editorial sin resultado');
      return { result: outcome.result, editorialVersion };
    } finally {
      await session.endSession();
    }
  }
}

export interface EditorialGraph {
  localities: LocalityDoc[];
  destinations: DestinationDoc[];
  boardingPoints: BoardingPointDoc[];
  services: ServiceDoc[];
  amenities: AmenityDoc[];
}

export class EditorialModelTx {
  constructor(
    private readonly db: Db,
    private readonly session: ClientSession,
  ) {}

  private opts(): { session: ClientSession } {
    return { session: this.session };
  }

  async allocateRevision(): Promise<number> {
    const meta = await this.db
      .collection<EditorialMetaDoc>(editorialCollections.meta)
      .findOneAndUpdate(
        { _id: 'editorial' },
        { $inc: { revisionSeq: 1 }, $setOnInsert: { editorialVersion: 1 } },
        { upsert: true, returnDocument: 'before', ...this.opts() },
      );
    return meta?.revisionSeq ?? 1;
  }

  async bumpEditorialVersion(): Promise<number> {
    const meta = await this.db
      .collection<EditorialMetaDoc>(editorialCollections.meta)
      .findOneAndUpdate(
        { _id: 'editorial' },
        { $inc: { editorialVersion: 1 }, $setOnInsert: { revisionSeq: 1 } },
        { upsert: true, returnDocument: 'after', ...this.opts() },
      );
    return meta?.editorialVersion ?? 1;
  }

  async findById<T>(collection: string, id: string): Promise<T | null> {
    return this.db.collection(collection).findOne({ id }, this.opts()) as Promise<T | null>;
  }

  async insertDoc(collection: string, doc: Document): Promise<void> {
    await this.db.collection(collection).insertOne(doc, this.opts());
  }

  async replaceDoc(collection: string, id: string, doc: Document): Promise<void> {
    await this.db.collection(collection).replaceOne({ id }, doc, this.opts());
  }

  async updateStatus(
    collection: string,
    id: string,
    status: EditorialDocStatus,
    revision: number,
    updatedAt: Date,
  ): Promise<void> {
    await this.db
      .collection(collection)
      .updateOne({ id }, { $set: { status, revision, updatedAt } }, this.opts());
  }

  async upsertReviewEntry(doc: ReviewQueueDoc): Promise<void> {
    const { id, createdAt, ...rest } = doc;
    await this.db.collection(editorialCollections.reviewQueue).updateOne(
      { id },
      { $set: rest, $setOnInsert: { id, createdAt } },
      { upsert: true, ...this.opts() },
    );
  }
}
