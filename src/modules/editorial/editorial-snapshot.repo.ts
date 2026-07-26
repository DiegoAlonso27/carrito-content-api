import type { ClientSession, Db } from 'mongodb';
import { ContentTopologyError, isTransactionUnsupported } from '../content/content.repo.js';

/**
 * Persistencia de snapshots editoriales. Un snapshot es un artefacto inmutable:
 * se inserta una vez y solo cambia su `state` (`active` ⇄ `superseded`).
 * Revertir es activar otra versión ya validada, nunca reconstruir.
 */

export const EDITORIAL_SNAPSHOTS_COLLECTION = 'editorial_snapshots';

/** Cuántas versiones se conservan por locale. La activa y la anterior son intocables. */
export const SNAPSHOT_RETENTION = 5;

export interface StoredSnapshot {
  version: string;
  versionNumber: number;
  locale: string;
  state: 'active' | 'superseded';
  body: string;
  checksum: string;
  etag: string;
  generatedAtUtc: string;
  documentCount: number;
  createdAt: Date;
  activatedAt: Date | null;
  activatedBy: string | null;
  activationReason: string | null;
}

export type SnapshotSummary = Omit<StoredSnapshot, 'body'>;

export class EditorialSnapshotRepo {
  constructor(private readonly db: Db) {}

  private col() {
    return this.db.collection<StoredSnapshot>(EDITORIAL_SNAPSHOTS_COLLECTION);
  }

  async ensureSetup(): Promise<void> {
    const exists = await this.db
      .listCollections({ name: EDITORIAL_SNAPSHOTS_COLLECTION }, { nameOnly: true })
      .hasNext();
    if (!exists) await this.db.createCollection(EDITORIAL_SNAPSHOTS_COLLECTION);

    await this.col().createIndex(
      { locale: 1, version: 1 },
      { name: 'ux_editorial_snapshots_locale_version', unique: true },
    );
    await this.col().createIndex(
      { locale: 1, state: 1 },
      { name: 'ix_editorial_snapshots_locale_state' },
    );
  }

  async findActive(locale: string): Promise<StoredSnapshot | null> {
    return this.col().findOne({ locale, state: 'active' });
  }

  async findByVersion(locale: string, version: string): Promise<StoredSnapshot | null> {
    return this.col().findOne({ locale, version });
  }

  async nextVersionNumber(locale: string): Promise<number> {
    const last = await this.col()
      .find({ locale })
      .sort({ versionNumber: -1 })
      .limit(1)
      .toArray();
    return (last[0]?.versionNumber ?? 0) + 1;
  }

  async list(locale?: string): Promise<SnapshotSummary[]> {
    const filter = locale === undefined ? {} : { locale };
    const docs = await this.col()
      .find(filter, { projection: { body: 0 } })
      .sort({ locale: 1, versionNumber: -1 })
      .toArray();
    return docs;
  }

  /**
   * Inserta el snapshot y lo activa en una sola transacción: nunca puede quedar
   * el locale sin activo ni con dos activos.
   */
  async insertAndActivate(
    snapshot: StoredSnapshot,
    activation: { operator: string; reason: string },
  ): Promise<void> {
    await this.withTransaction(async (session) => {
      await this.col().updateMany(
        { locale: snapshot.locale, state: 'active' },
        { $set: { state: 'superseded' } },
        { session },
      );
      await this.col().insertOne(
        {
          ...snapshot,
          state: 'active',
          activatedAt: new Date(),
          activatedBy: activation.operator,
          activationReason: activation.reason,
        },
        { session },
      );
    });
  }

  async activateExisting(
    locale: string,
    version: string,
    activation: { operator: string; reason: string },
  ): Promise<void> {
    await this.withTransaction(async (session) => {
      await this.col().updateMany(
        { locale, state: 'active' },
        { $set: { state: 'superseded' } },
        { session },
      );
      await this.col().updateOne(
        { locale, version },
        {
          $set: {
            state: 'active',
            activatedAt: new Date(),
            activatedBy: activation.operator,
            activationReason: activation.reason,
          },
        },
        { session },
      );
    });
  }

  /**
   * Retención: conserva las `SNAPSHOT_RETENTION` versiones más recientes del
   * locale. La activa y la inmediatamente anterior nunca se tocan, aunque el
   * límite fuera menor.
   */
  async prune(locale: string, keep = SNAPSHOT_RETENTION): Promise<string[]> {
    const all = await this.col()
      .find({ locale }, { projection: { body: 0 } })
      .sort({ versionNumber: -1 })
      .toArray();

    const protectedVersions = new Set<string>();
    const active = all.find((s) => s.state === 'active');
    if (active !== undefined) protectedVersions.add(active.version);
    const previous = all.find((s) => s.state !== 'active');
    if (previous !== undefined) protectedVersions.add(previous.version);

    const removable = all
      .slice(Math.max(keep, protectedVersions.size))
      .filter((s) => !protectedVersions.has(s.version));

    if (removable.length === 0) return [];
    await this.col().deleteMany({
      locale,
      version: { $in: removable.map((s) => s.version) },
    });
    return removable.map((s) => s.version);
  }

  private async withTransaction(fn: (session: ClientSession) => Promise<void>): Promise<void> {
    const session = this.db.client.startSession();
    try {
      await session.withTransaction(async () => {
        await fn(session);
      });
    } catch (err) {
      if (isTransactionUnsupported(err)) {
        throw new ContentTopologyError(
          'Publicar o revertir un snapshot exige MongoDB en replica set ' +
            '(transacciones multi-documento). Standalone no está soportado (ADR-001).',
        );
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }
}
