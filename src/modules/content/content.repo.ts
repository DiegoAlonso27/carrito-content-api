import type { ClientSession, Db, Document, Filter, WithId } from 'mongodb';
import { MongoServerError } from 'mongodb';
import {
  contentCollectionIndexes,
  contentCollections,
  contentCollectionValidators,
} from './content.collections.js';
import type {
  AssetDoc,
  CollectionDoc,
  ContentMetaDoc,
  EditorialStatus,
  LocaleDoc,
} from './content.types.js';

/** Documento editorial mínimo almacenado en MongoDB. */
export interface EditorialStoredDoc extends Document {
  status: EditorialStatus;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface StatusCount {
  _id: string;
  count: number;
}

export interface ImportUpsertOutcome {
  inserted: number;
  updated: number;
  unchanged: number;
  total: number;
}

/**
 * Mutaciones editoriales requieren transacciones multi-documento (replica set).
 * Standalone no está soportado para escritura (ADR-001).
 */
export class ContentTopologyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentTopologyError';
  }
}

/**
 * Única vía de lectura/escritura/DDL sobre `carrito_content` (AGENTS.md:
 * persistencia solo en `*.repo.ts`).
 */
export class ContentRepo {
  constructor(private readonly db: Db) {}

  // ── DDL ───────────────────────────────────────────────────────────────────

  /**
   * Crea colecciones, validadores e índices de forma idempotente.
   * Solo migración/scripts operativos — la API de lectura no necesita DDL.
   */
  async ensureSetup(): Promise<void> {
    const existing = new Set(
      (await this.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
    );

    for (const [name, validator] of Object.entries(contentCollectionValidators)) {
      if (existing.has(name)) {
        await this.db.command({ collMod: name, validator, validationLevel: 'moderate' });
      } else {
        await this.db.createCollection(name, { validator, validationLevel: 'moderate' });
      }
    }
    if (!existing.has(contentCollections.meta)) {
      await this.db.createCollection(contentCollections.meta);
    }

    for (const spec of contentCollectionIndexes) {
      await this.db
        .collection(spec.collection)
        .createIndex(spec.keys, { name: spec.name, unique: spec.unique });
    }
  }

  // ── Meta ──────────────────────────────────────────────────────────────────

  async getMeta(): Promise<ContentMetaDoc | null> {
    return this.db.collection<ContentMetaDoc>(contentCollections.meta).findOne({ _id: 'content' });
  }

  async getContentVersion(): Promise<number> {
    const meta = await this.getMeta();
    return meta?.contentVersion ?? 0;
  }

  // ── Referencias (preflight editorial) ─────────────────────────────────────

  async findLocaleByCode(code: string): Promise<LocaleDoc | null> {
    return this.db.collection<LocaleDoc>(contentCollections.locales).findOne({ code });
  }

  async findCollectionBySlug(slug: string): Promise<CollectionDoc | null> {
    return this.db.collection<CollectionDoc>(contentCollections.collections).findOne({ slug });
  }

  async findAssetBySlug(slug: string): Promise<AssetDoc | null> {
    return this.db.collection<AssetDoc>(contentCollections.assets).findOne({ slug });
  }

  async findAssetsBySlugs(slugs: readonly string[]): Promise<Map<string, AssetDoc>> {
    if (slugs.length === 0) return new Map();
    const docs = await this.db
      .collection<AssetDoc>(contentCollections.assets)
      .find({ slug: { $in: [...slugs] } })
      .toArray();
    return new Map(docs.map((d) => [d.slug, d]));
  }

  // ── Editorial CRUD ────────────────────────────────────────────────────────

  async findEditorialDoc(
    collection: string,
    filter: Filter<Document>,
  ): Promise<WithId<EditorialStoredDoc> | null> {
    return this.db.collection<EditorialStoredDoc>(collection).findOne(filter);
  }

  async countDocuments(collection: string): Promise<number> {
    return this.db.collection(collection).countDocuments();
  }

  async aggregateStatusCounts(collection: string): Promise<StatusCount[]> {
    return this.db
      .collection(collection)
      .aggregate<StatusCount>([{ $group: { _id: '$status', count: { $sum: 1 } } }])
      .toArray();
  }

  async findByStatus(
    collection: string,
    status?: EditorialStatus,
  ): Promise<WithId<EditorialStoredDoc>[]> {
    const filter = status !== undefined ? { status } : {};
    return this.db.collection<EditorialStoredDoc>(collection).find(filter).toArray();
  }

  // ── Lectura publicada (runtime + export) ──────────────────────────────────

  async findPublished<T extends object>(
    collection: string,
    filter: Filter<Document> = {},
  ): Promise<T[]> {
    return this.db
      .collection(collection)
      .find({ status: 'published', ...filter })
      .toArray() as Promise<T[]>;
  }

  async findPublishedLocales(): Promise<LocaleDoc[]> {
    return this.findPublished<LocaleDoc>(contentCollections.locales, { isActive: true });
  }

  async findAll<T extends object>(collection: string): Promise<T[]> {
    return this.db.collection(collection).find({}).toArray() as Promise<T[]>;
  }

  // ── Importación ───────────────────────────────────────────────────────────

  async upsertImportSection<T extends Document>(
    collection: string,
    records: T[],
    keyOf: (r: T) => Filter<Document>,
    now: Date,
    deepEqual: (a: unknown, b: unknown) => boolean,
  ): Promise<ImportUpsertOutcome> {
    const col = this.db.collection<Document>(collection);
    const summary: ImportUpsertOutcome = {
      inserted: 0,
      updated: 0,
      unchanged: 0,
      total: records.length,
    };

    for (const desired of records) {
      const filter = keyOf(desired);
      const existing = await col.findOne(filter);
      if (existing === null) {
        await col.insertOne({ ...desired, createdAt: now, updatedAt: now });
        summary.inserted += 1;
        continue;
      }
      const { _id, createdAt, updatedAt, ...existingContent } = existing;
      void _id;
      void updatedAt;
      if (deepEqual(existingContent, desired)) {
        summary.unchanged += 1;
        continue;
      }
      const created = createdAt instanceof Date ? createdAt : now;
      await col.replaceOne(filter, { ...desired, createdAt: created, updatedAt: now });
      summary.updated += 1;
    }
    return summary;
  }

  async seedImportMeta(maxRevision: number): Promise<void> {
    await this.db.collection<ContentMetaDoc>(contentCollections.meta).updateOne(
      { _id: 'content' },
      {
        $setOnInsert: { contentVersion: 1 },
        $max: { tokenSeq: maxRevision + 1 },
      },
      { upsert: true },
    );
  }

  // ── Escritura editorial (solo con transacciones / replica set) ────────────

  /**
   * Ejecuta `fn` y el bump de `contentVersion` en una transacción.
   * Si el deployment no soporta transacciones → ContentTopologyError (ADR-001).
   */
  async withEditorialWrite<T>(
    fn: (tx: EditorialTx) => Promise<{ result: T; wrote: boolean }>,
  ): Promise<{ result: T; contentVersion: number | null }> {
    const session = this.db.client.startSession();
    try {
      try {
        return await this.runTransactionalWrite(session, fn);
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
    } finally {
      await session.endSession();
    }
  }

  private async runTransactionalWrite<T>(
    session: ClientSession,
    fn: (tx: EditorialTx) => Promise<{ result: T; wrote: boolean }>,
  ): Promise<{ result: T; contentVersion: number | null }> {
    let outcome: { result: T; wrote: boolean } | undefined;
    let contentVersion: number | null = null;

    await session.withTransaction(async () => {
      const tx = new EditorialTx(this.db, session);
      outcome = await fn(tx);
      if (outcome.wrote) {
        contentVersion = await tx.bumpContentVersion();
      }
    });

    if (outcome === undefined) {
      throw new Error('transacción editorial sin resultado');
    }
    return { result: outcome.result, contentVersion };
  }
}

function isTransactionUnsupported(err: unknown): boolean {
  if (!(err instanceof MongoServerError)) return false;
  // IllegalOperation (20): transacciones solo en replica set / mongos.
  if (err.code === 20) return true;
  const message = err.message.toLowerCase();
  return (
    message.includes('transaction numbers are only allowed') ||
    message.includes('transactions are not supported') ||
    message.includes('replica set member or mongos')
  );
}

/** Operaciones editoriales atadas a una sesión/transacción MongoDB. */
export class EditorialTx {
  constructor(
    private readonly db: Db,
    private readonly session: ClientSession,
  ) {}

  private sessionOpts(): { session: ClientSession } {
    return { session: this.session };
  }

  findEditorialDoc(
    collection: string,
    filter: Filter<Document>,
  ): Promise<WithId<EditorialStoredDoc> | null> {
    return this.db.collection<EditorialStoredDoc>(collection).findOne(filter, this.sessionOpts());
  }

  async allocateRevision(): Promise<number> {
    const meta = await this.db
      .collection<ContentMetaDoc>(contentCollections.meta)
      .findOneAndUpdate(
        { _id: 'content' },
        { $inc: { tokenSeq: 1 }, $setOnInsert: { contentVersion: 1 } },
        { upsert: true, returnDocument: 'before', ...this.sessionOpts() },
      );
    return meta?.tokenSeq ?? 1;
  }

  async bumpContentVersion(): Promise<number> {
    const meta = await this.db
      .collection<ContentMetaDoc>(contentCollections.meta)
      .findOneAndUpdate(
        { _id: 'content' },
        { $inc: { contentVersion: 1 }, $setOnInsert: { tokenSeq: 1 } },
        { upsert: true, returnDocument: 'after', ...this.sessionOpts() },
      );
    return meta?.contentVersion ?? 1;
  }

  async insertEditorialDoc(collection: string, doc: EditorialStoredDoc): Promise<void> {
    await this.db.collection<EditorialStoredDoc>(collection).insertOne(doc, this.sessionOpts());
  }

  async replaceEditorialDoc(
    collection: string,
    filter: Filter<Document>,
    doc: EditorialStoredDoc,
  ): Promise<void> {
    await this.db
      .collection<EditorialStoredDoc>(collection)
      .replaceOne(filter, doc, this.sessionOpts());
  }

  async updateEditorialStatus(
    collection: string,
    filter: Filter<Document>,
    status: EditorialStatus,
    revision: number,
    updatedAt: Date,
  ): Promise<void> {
    await this.db
      .collection<EditorialStoredDoc>(collection)
      .updateOne(filter, { $set: { status, revision, updatedAt } }, this.sessionOpts());
  }
}
