import type { Db } from 'mongodb';
import {
  buildSnapshot,
  verifySnapshotIntegrity,
} from './editorial-snapshot.js';
import type { EditorialSnapshotBody } from './editorial-snapshot.js';
import { EditorialSnapshotRepo } from './editorial-snapshot.repo.js';
import type { SnapshotSummary } from './editorial-snapshot.repo.js';

/**
 * Ciclo de vida del snapshot editorial: publicar, servir y revertir.
 *
 * Publicar y revertir son operaciones explícitas de operación, con responsable
 * y motivo registrados (doc 08). El endpoint sirve SIEMPRE el snapshot activo
 * almacenado: nunca reconstruye al vuelo, para que el artefacto que valida el
 * gate sea exactamente el que consume el front.
 */

export class SnapshotPublishError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'SnapshotPublishError';
  }
}

export interface PublishOptions {
  locale: string;
  operator: string;
  reason: string;
  /** Ejecuta todas las validaciones y no escribe nada. */
  dryRun?: boolean;
}

export interface PublishResult {
  version: string;
  checksum: string;
  etag: string;
  documentCount: number;
  destinationCount: number;
  warnings: string[];
  pruned: string[];
  dryRun: boolean;
}

function etagOf(locale: string, version: string): string {
  return `"editorial-${locale}-${version}"`;
}

export async function publishEditorialSnapshot(
  db: Db,
  opts: PublishOptions,
): Promise<PublishResult> {
  const repo = new EditorialSnapshotRepo(db);
  await repo.ensureSetup();

  const versionNumber = await repo.nextVersionNumber(opts.locale);
  const version = `v${String(versionNumber)}`;
  const generatedAtUtc = new Date().toISOString();

  const { body, errors, warnings } = await buildSnapshot(db, {
    locale: opts.locale,
    version,
    generatedAtUtc,
  });

  if (body === null) {
    throw new SnapshotPublishError(
      `el snapshot de '${opts.locale}' no se puede publicar`,
      errors,
    );
  }

  // Cinturón y tirantes: el snapshot recién construido se verifica como si
  // viniera de fuera. Si el builder y el verificador discrepan, no se publica.
  const integrity = verifySnapshotIntegrity(body);
  if (integrity.length > 0) {
    throw new SnapshotPublishError(
      `el snapshot de '${opts.locale}' no supera la verificación de integridad`,
      integrity,
    );
  }

  const serialized = JSON.stringify(body);
  const result: PublishResult = {
    version,
    checksum: body.checksum,
    etag: etagOf(opts.locale, version),
    documentCount: body.manifest.length,
    destinationCount: body.destinations.length,
    warnings,
    pruned: [],
    dryRun: opts.dryRun === true,
  };

  if (opts.dryRun === true) return result;

  await repo.insertAndActivate(
    {
      version,
      versionNumber,
      locale: opts.locale,
      state: 'active',
      body: serialized,
      checksum: body.checksum,
      etag: result.etag,
      generatedAtUtc,
      documentCount: body.manifest.length,
      createdAt: new Date(),
      activatedAt: null,
      activatedBy: null,
      activationReason: null,
    },
    { operator: opts.operator, reason: opts.reason },
  );

  result.pruned = await repo.prune(opts.locale);
  return result;
}

export interface RollbackOptions {
  locale: string;
  version: string;
  operator: string;
  reason: string;
}

/**
 * Rollback = seleccionar una versión anterior ya validada. Antes de activarla
 * se recalculan sus hashes: no se vuelve a un artefacto que no se sostiene.
 */
export async function rollbackEditorialSnapshot(
  db: Db,
  opts: RollbackOptions,
): Promise<{ version: string; checksum: string; etag: string; previousVersion: string | null }> {
  const repo = new EditorialSnapshotRepo(db);
  const target = await repo.findByVersion(opts.locale, opts.version);
  if (target === null) {
    throw new SnapshotPublishError(
      `no existe el snapshot '${opts.version}' del locale '${opts.locale}'`,
    );
  }

  const current = await repo.findActive(opts.locale);
  if (current !== null && current.version === opts.version) {
    return {
      version: target.version,
      checksum: target.checksum,
      etag: target.etag,
      previousVersion: null,
    };
  }

  const body = JSON.parse(target.body) as EditorialSnapshotBody;
  const problems = verifySnapshotIntegrity(body);
  if (problems.length > 0) {
    throw new SnapshotPublishError(
      `el snapshot '${opts.version}' no supera la verificación de integridad: no se activa`,
      problems,
    );
  }

  await repo.activateExisting(opts.locale, opts.version, {
    operator: opts.operator,
    reason: opts.reason,
  });

  return {
    version: target.version,
    checksum: target.checksum,
    etag: target.etag,
    previousVersion: current?.version ?? null,
  };
}

export async function listEditorialSnapshots(
  db: Db,
  locale?: string,
): Promise<SnapshotSummary[]> {
  return new EditorialSnapshotRepo(db).list(locale);
}

export interface ServedSnapshot {
  body: string;
  etag: string;
  version: string;
  generatedAtUtc: string;
}

/**
 * Sirve el snapshot activo. Cachea en memoria por versión y verifica la
 * integridad una vez por versión cargada: un documento manipulado en MongoDB no
 * llega al front.
 */
export class EditorialSnapshotService {
  private readonly repo: EditorialSnapshotRepo;
  private readonly cache = new Map<string, ServedSnapshot>();

  constructor(db: Db) {
    this.repo = new EditorialSnapshotRepo(db);
  }

  async getActive(locale: string): Promise<ServedSnapshot | null> {
    const stored = await this.repo.findActive(locale);
    if (stored === null) return null;

    const cached = this.cache.get(locale);
    if (cached !== undefined && cached.version === stored.version) return cached;

    const body = JSON.parse(stored.body) as EditorialSnapshotBody;
    const problems = verifySnapshotIntegrity(body);
    if (problems.length > 0) {
      throw new SnapshotPublishError(
        `el snapshot activo de '${locale}' está corrupto y no se sirve`,
        problems,
      );
    }

    const served: ServedSnapshot = {
      body: stored.body,
      etag: stored.etag,
      version: stored.version,
      generatedAtUtc: stored.generatedAtUtc,
    };
    this.cache.set(locale, served);
    return served;
  }
}
