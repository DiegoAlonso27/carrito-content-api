import type { ClientSession, Db, Document, Filter, WithId } from 'mongodb';
import { MongoServerError } from 'mongodb';
import { contentCollections, ensureContentSetup } from './content.collections.js';
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
 * Única vía de lectura/escritura sobre `carrito_content`.
 *
 * DDL (`ensureSetup`), meta (`contentVersion`/`tokenSeq`), import, export,
 * lectura pública y escritura editorial pasan por aquí — AGENTS.md exige
 * persistencia solo en `*.repo.ts`.
 *
 * Escrituras editoriales: transacción multi-documento si hay replica set;
 * en standalone, flag `editorialDirty` + reconciliación en lectura (ADR-001).
 */
export class ContentRepo {
  constructor(private readonly db: Db) {}

  // ── DDL ───────────────────────────────────────────────────────────────────

  async ensureSetup(): Promise<void> {
    await ensureContentSetup(this.db);
  }

  // ── Meta ──────────────────────────────────────────────────────────────────

  async getMeta(): Promise<ContentMetaDoc | null> {
    return this.db.collection<ContentMetaDoc>(contentCollections.meta).findOne({ _id: 'content' });
  }

  /**
   * Versión global para ETag/caché. Si `editorialDirty` quedó true tras una
   * interrupción (standalone), incrementa contentVersion y limpia el flag
   * antes de devolver — invalida cachés que podrían servir datos viejos.
   */
  async getContentVersion(): Promise<number> {
    const meta = await this.getMeta();
    if (meta?.editorialDirty === true) {
      return this.reconcileDirtyMeta();
    }
    return meta?.contentVersion ?? 0;
  }

  /**
   * Compare-and-swap: solo bump si sigue dirty (evita doble bump concurrente).
   */
  async reconcileDirtyMeta(): Promise<number> {
    const meta = await this.db
      .collection<ContentMetaDoc>(contentCollections.meta)
      .findOneAndUpdate(
        { _id: 'content', editorialDirty: true },
        { $inc: { contentVersion: 1 }, $set: { editorialDirty: false } },
        { returnDocument: 'after' },
      );
    if (meta !== null) return meta.contentVersion;
    const current = await this.getMeta();
    return current?.contentVersion ?? 0;
  }

  // ── Referencias (preflight editorial) ─────────────────────────────────────

  async findLocaleByCode(code: string): Promise<LocaleDoc | null> {
    return this.db
      .collection<LocaleDoc>(contentCollections.locales)
      .findOne({ code });
  }

  async findCollectionBySlug(slug: string): Promise<CollectionDoc | null> {
    return this.db
      .collection<CollectionDoc>(contentCollections.collections)
      .findOne({ slug });
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

  async findPublished<T extends object>(collection: string, filter: Filter<Document> = {}): Promise<T[]> {
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
        $set: { editorialDirty: false },
      },
      { upsert: true },
    );
  }

  // ── Escritura editorial transaccional ─────────────────────────────────────

  /**
   * Ejecuta `fn` con escritura editorial + `contentVersion` acoplados.
   * Usa transacción multi-documento si el deployment lo soporta (replica set);
   * en Mongo standalone aplica dirty-flag + reconciliación (ADR-001).
   */
  async withEditorialWrite<T>(
    fn: (tx: EditorialTx) => Promise<{ result: T; wrote: boolean }>,
  ): Promise<{ result: T; contentVersion: number | null }> {
    const session = this.db.client.startSession();
    try {
      try {
        return await this.runTransactionalWrite(session, fn);
      } catch (err) {
        if (!isTransactionUnsupported(err)) throw err;
        return await this.runSequentialWrite(fn);
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

  /**
   * Fallback standalone: marca dirty → escribe → bump y limpia dirty.
   * Si el proceso cae a mitad, la próxima lectura reconcilia (ADR-001).
   */
  private async runSequentialWrite<T>(
    fn: (tx: EditorialTx) => Promise<{ result: T; wrote: boolean }>,
  ): Promise<{ result: T; contentVersion: number | null }> {
    const tx = new EditorialTx(this.db);
    await tx.markEditorialDirty();
    // Si falla tras markDirty, editorialDirty queda true → getContentVersion reconcilia.
    const outcome = await fn(tx);
    if (outcome.wrote) {
      const contentVersion = await tx.bumpContentVersion();
      return { result: outcome.result, contentVersion };
    }
    await tx.clearEditorialDirty();
    return { result: outcome.result, contentVersion: null };
  }
}

function isTransactionUnsupported(err: unknown): boolean {
  if (!(err instanceof MongoServerError)) return false;
  if (err.code === 20) return true;
  const message = err.message.toLowerCase();
  return (
    message.includes('transaction numbers are only allowed') ||
    message.includes('replica set member') ||
    message.includes('not master')
  );
}

/** Operaciones editoriales; `session` opcional (transacción o fallback). */
export class EditorialTx {
  constructor(
    private readonly db: Db,
    private readonly session?: ClientSession,
  ) {}

  private sessionOpts(): { session?: ClientSession } {
    return this.session !== undefined ? { session: this.session } : {};
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
        {
          $inc: { tokenSeq: 1 },
          $setOnInsert: { contentVersion: 1, editorialDirty: false },
        },
        { upsert: true, returnDocument: 'before', ...this.sessionOpts() },
      );
    return meta?.tokenSeq ?? 1;
  }

  async markEditorialDirty(): Promise<void> {
    await this.db.collection<ContentMetaDoc>(contentCollections.meta).updateOne(
      { _id: 'content' },
      {
        $set: { editorialDirty: true },
        $setOnInsert: { contentVersion: 1, tokenSeq: 1 },
      },
      { upsert: true, ...this.sessionOpts() },
    );
  }

  async clearEditorialDirty(): Promise<void> {
    await this.db
      .collection<ContentMetaDoc>(contentCollections.meta)
      .updateOne({ _id: 'content' }, { $set: { editorialDirty: false } }, this.sessionOpts());
  }

  /** Incrementa contentVersion y deja editorialDirty=false (éxito o reconciliación). */
  async bumpContentVersion(): Promise<number> {
    const meta = await this.db
      .collection<ContentMetaDoc>(contentCollections.meta)
      .findOneAndUpdate(
        { _id: 'content' },
        {
          $inc: { contentVersion: 1 },
          $set: { editorialDirty: false },
          $setOnInsert: { tokenSeq: 1 },
        },
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
