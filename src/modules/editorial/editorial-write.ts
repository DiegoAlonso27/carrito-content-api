import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import type { TypeCheck } from '@sinclair/typebox/compiler';
import type { TObject } from '@sinclair/typebox';
import { editorialInputSchemas } from './editorial.schemas.js';
import type { EditorialSectionName } from './editorial.schemas.js';
import { editorialCollections } from './editorial.collections.js';
import { EditorialRepo } from './editorial.repo.js';
import type { EditorialGraph } from './editorial.repo.js';
import { isHtmlField } from './editorial.blocks.js';
import {
  validateBoardingPoint,
  validateDestination,
  validateService,
} from './editorial.validate.js';
import type { ValidationContext, ValidationIssue } from './editorial.validate.js';
import { ContentRepo, ContentTopologyError } from '../content/content.repo.js';
import { contentCollections } from '../content/content.collections.js';
import { sanitizeContentHtml } from '../content/content-import.js';
import type { AssetDoc, LocaleDoc } from '../content/content.types.js';
import type {
  BoardingPointDoc,
  DestinationDoc,
  EditorialBlock,
  EditorialDocStatus,
  ServiceDoc,
} from './editorial.types.js';

/**
 * Escritura del modelo editorial (CLIs `content:set` / `content:publish`
 * extendidos; sin panel en fase 1).
 *
 * Regla de estados: la entrada nunca trae `status`. Un documento nuevo nace en
 * `draft` y solo `--publish` o `content:publish` lo mueven, tras validar el
 * documento completo.
 */

export const editorialSectionCollections: Record<EditorialSectionName, string> = {
  localities: editorialCollections.localities,
  destinations: editorialCollections.destinations,
  'boarding-points': editorialCollections.boardingPoints,
  services: editorialCollections.services,
  amenities: editorialCollections.amenities,
};

const checkers = new Map<EditorialSectionName, TypeCheck<TObject>>(
  (Object.entries(editorialInputSchemas) as [EditorialSectionName, TObject][]).map(
    ([name, schema]) => [name, TypeCompiler.Compile(schema)],
  ),
);

export class EditorialWriteError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'EditorialWriteError';
  }
}

export interface EditorialSetResult {
  id: string;
  action: 'created' | 'updated' | 'unchanged';
  status: EditorialDocStatus;
  sanitizedFields: string[];
  warnings: string[];
}

export interface EditorialStatusResult {
  id: string;
  previous: EditorialDocStatus;
  current: EditorialDocStatus;
  warnings: string[];
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** Sanitiza toda clave `*Html` dentro del contenido de los bloques. */
export function sanitizeHtmlDeep(node: unknown, path: string, changed: string[]): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) sanitizeHtmlDeep(entry, `${path}[${String(i)}]`, changed);
    return;
  }
  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (isHtmlField(key) && typeof value === 'string') {
      const sanitized = sanitizeContentHtml(value);
      if (sanitized !== value) {
        record[key] = sanitized;
        changed.push(`${path}.${key}`);
      }
      continue;
    }
    sanitizeHtmlDeep(value, `${path}.${key}`, changed);
  }
}

function sanitizeRecord(section: EditorialSectionName, record: Record<string, unknown>): string[] {
  if (section !== 'destinations') return [];
  const blocks = record['blocks'];
  if (!Array.isArray(blocks)) return [];
  const changed: string[] = [];
  for (const [i, block] of blocks.entries()) {
    const content = (block as { content?: unknown }).content;
    sanitizeHtmlDeep(content, `blocks[${String(i)}].content`, changed);
  }
  return changed;
}

/**
 * Un bloque nuevo puede llegar sin `id` y se le asigna un UUID estable. En una
 * ACTUALIZACIÓN el `id` es obligatorio: generarlo otra vez rompería la
 * identidad del bloque en cada edición.
 */
function assignBlockIds(record: Record<string, unknown>, isCreation: boolean): void {
  const blocks = record['blocks'];
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) {
    const b = block as Partial<EditorialBlock>;
    if (typeof b.id === 'string' && b.id.length > 0) continue;
    if (isCreation) b.id = randomUUID();
  }
}

export async function buildValidationContext(db: Db): Promise<ValidationContext> {
  const contentRepo = new ContentRepo(db);
  const editorialRepo = new EditorialRepo(db);

  const locales = await contentRepo.findAll<LocaleDoc>(contentCollections.locales);
  const defaultLocale = locales.find((l) => l.isDefault && l.status === 'published');
  if (defaultLocale === undefined) {
    throw new EditorialWriteError(
      'no hay un locale por defecto publicado: créalo antes de validar contenido editorial',
    );
  }

  const assets = await contentRepo.findAll<AssetDoc>(contentCollections.assets);
  const graph = await editorialRepo.loadGraph();

  return {
    graph,
    defaultLocale: defaultLocale.code,
    assetSlugs: new Set(assets.map((a) => a.slug)),
    publishedAssetSlugs: new Set(
      assets.filter((a) => a.status === 'published' && a.isActive).map((a) => a.slug),
    ),
  };
}

function formatIssues(issues: ValidationIssue[]): string[] {
  return issues.map((i) => {
    const where = i.blockId === undefined ? '' : ` [bloque ${i.blockId}]`;
    return `${i.code}: ${i.message}${where}`;
  });
}

/** Valida un documento contra el grafo, sustituyendo su versión almacenada. */
function validateForPublish(
  section: EditorialSectionName,
  record: Record<string, unknown>,
  ctx: ValidationContext,
): { errors: string[]; warnings: string[] } {
  if (section === 'destinations') {
    const candidate = record as unknown as DestinationDoc;
    const graph: EditorialGraph = {
      ...ctx.graph,
      destinations: [
        ...ctx.graph.destinations.filter((d) => d.id !== candidate.id),
        { ...candidate, status: 'published' },
      ],
    };
    const result = validateDestination(candidate, { ...ctx, graph });
    return { errors: formatIssues(result.errors), warnings: formatIssues(result.warnings) };
  }
  if (section === 'services') {
    const result = validateService(record as unknown as ServiceDoc, ctx);
    return { errors: formatIssues(result.errors), warnings: formatIssues(result.warnings) };
  }
  if (section === 'boarding-points') {
    const issues = validateBoardingPoint(record as unknown as BoardingPointDoc);
    return { errors: formatIssues(issues), warnings: [] };
  }
  return { errors: [], warnings: [] };
}

export async function setEditorialRecords(
  db: Db,
  section: EditorialSectionName,
  records: unknown[],
  opts: { publish?: boolean } = {},
): Promise<{ results: EditorialSetResult[]; editorialVersion: number | null }> {
  const repo = new EditorialRepo(db);
  await repo.ensureSetup();
  const collection = editorialSectionCollections[section];
  const checker = checkers.get(section);
  if (checker === undefined) throw new EditorialWriteError(`sección desconocida '${section}'`);

  const prepared: {
    record: Record<string, unknown>;
    existing: (Record<string, unknown> & { status: EditorialDocStatus; createdAt: Date }) | null;
    sanitizedFields: string[];
  }[] = [];

  const schemaErrors: string[] = [];
  const seenIds = new Set<string>();

  for (const [i, raw] of records.entries()) {
    const record = structuredClone(raw) as Record<string, unknown>;
    const id = typeof record['id'] === 'string' ? record['id'] : '';
    if (id.length === 0) {
      schemaErrors.push(`[${String(i)}] falta 'id'`);
      continue;
    }
    if (seenIds.has(id)) {
      schemaErrors.push(`[${String(i)}] id duplicado en el lote '${id}'`);
      continue;
    }
    seenIds.add(id);

    const existing = await repo.findById<
      Record<string, unknown> & { status: EditorialDocStatus; createdAt: Date }
    >(collection, id);
    assignBlockIds(record, existing === null);

    const errors = [...checker.Errors(record)].map((e) => `[${String(i)}] ${e.path}: ${e.message}`);
    if (errors.length > 0) {
      schemaErrors.push(...errors);
      continue;
    }
    prepared.push({ record, existing, sanitizedFields: sanitizeRecord(section, record) });
  }

  if (schemaErrors.length > 0) {
    throw new EditorialWriteError(`registros inválidos para '${section}'`, schemaErrors);
  }

  const ctx = opts.publish === true ? await buildValidationContext(db) : null;

  const plans: {
    record: Record<string, unknown>;
    action: 'created' | 'updated';
    status: EditorialDocStatus;
    createdAt?: Date;
    sanitizedFields: string[];
    warnings: string[];
  }[] = [];
  const unchanged: EditorialSetResult[] = [];
  const publishErrors: string[] = [];

  for (const { record, existing, sanitizedFields } of prepared) {
    const id = String(record['id']);
    const currentStatus: EditorialDocStatus = existing?.status ?? 'draft';
    const targetStatus: EditorialDocStatus = opts.publish === true ? 'published' : currentStatus;

    let warnings: string[] = [];
    if (targetStatus === 'published' && ctx !== null) {
      const validation = validateForPublish(section, record, ctx);
      if (validation.errors.length > 0) {
        publishErrors.push(...validation.errors.map((e) => `${id}: ${e}`));
        continue;
      }
      warnings = validation.warnings.map((w) => `${id}: ${w}`);
    }

    if (existing !== null) {
      const { _id, status, revision, createdAt, updatedAt, ...content } = existing;
      void _id;
      void revision;
      void updatedAt;
      if (deepEqual(content, record) && status === targetStatus) {
        unchanged.push({ id, action: 'unchanged', status, sanitizedFields, warnings });
        continue;
      }
      plans.push({
        record,
        action: 'updated',
        status: targetStatus,
        createdAt,
        sanitizedFields,
        warnings,
      });
      continue;
    }

    plans.push({ record, action: 'created', status: targetStatus, sanitizedFields, warnings });
  }

  if (publishErrors.length > 0) {
    throw new EditorialWriteError(
      `no se puede publicar en '${section}': el documento no pasa la validación completa`,
      publishErrors,
    );
  }

  if (plans.length === 0) return { results: unchanged, editorialVersion: null };

  try {
    const { result, editorialVersion } = await repo.withWrite(async (tx) => {
      const results: EditorialSetResult[] = [...unchanged];
      for (const plan of plans) {
        const now = new Date();
        const revision = await tx.allocateRevision();
        const doc = {
          ...plan.record,
          status: plan.status,
          revision,
          createdAt: plan.createdAt ?? now,
          updatedAt: now,
        };
        if (plan.action === 'created') await tx.insertDoc(collection, doc);
        else await tx.replaceDoc(collection, String(plan.record['id']), doc);

        results.push({
          id: String(plan.record['id']),
          action: plan.action,
          status: plan.status,
          sanitizedFields: plan.sanitizedFields,
          warnings: plan.warnings,
        });
      }
      return { result: results, wrote: true };
    });
    return { results: result, editorialVersion };
  } catch (err) {
    if (err instanceof ContentTopologyError) throw new EditorialWriteError(err.message);
    throw err;
  }
}

export async function setEditorialStatus(
  db: Db,
  section: EditorialSectionName,
  id: string,
  target: EditorialDocStatus,
): Promise<{ result: EditorialStatusResult; editorialVersion: number | null }> {
  const repo = new EditorialRepo(db);
  const collection = editorialSectionCollections[section];
  const existing = await repo.findById<
    Record<string, unknown> & { status: EditorialDocStatus }
  >(collection, id);
  if (existing === null) throw new EditorialWriteError(`no existe '${id}' en '${section}'`);

  const previous = existing.status;
  if (previous === target) {
    return { result: { id, previous, current: target, warnings: [] }, editorialVersion: null };
  }

  let warnings: string[] = [];
  if (target === 'published') {
    const ctx = await buildValidationContext(db);
    const { _id, status, revision, createdAt, updatedAt, ...content } = existing;
    void _id;
    void status;
    void revision;
    void createdAt;
    void updatedAt;
    const validation = validateForPublish(section, content, ctx);
    if (validation.errors.length > 0) {
      throw new EditorialWriteError(
        `no se puede publicar '${id}': el documento no pasa la validación completa`,
        validation.errors,
      );
    }
    warnings = validation.warnings;
  }

  try {
    const { result, editorialVersion } = await repo.withWrite(async (tx) => {
      const revision = await tx.allocateRevision();
      await tx.updateStatus(collection, id, target, revision, new Date());
      return { result: { id, previous, current: target, warnings }, wrote: true };
    });
    return { result, editorialVersion };
  } catch (err) {
    if (err instanceof ContentTopologyError) throw new EditorialWriteError(err.message);
    throw err;
  }
}

export interface EditorialStatusSummary {
  section: EditorialSectionName;
  total: number;
  byStatus: Record<string, number>;
}

export async function editorialStatusSummary(db: Db): Promise<{
  editorialVersion: number;
  revisionSeq: number;
  sections: EditorialStatusSummary[];
  reviewQueueOpen: number;
}> {
  const repo = new EditorialRepo(db);
  const meta = await repo.getMeta();
  const sections: EditorialStatusSummary[] = [];
  for (const [name, collection] of Object.entries(editorialSectionCollections) as [
    EditorialSectionName,
    string,
  ][]) {
    const byStatus = await repo.countByStatus(collection);
    sections.push({
      section: name,
      total: Object.values(byStatus).reduce((a, b) => a + b, 0),
      byStatus,
    });
  }
  const open = await repo.listReviewQueue('open');
  return {
    editorialVersion: meta?.editorialVersion ?? 0,
    revisionSeq: meta?.revisionSeq ?? 0,
    sections,
    reviewQueueOpen: open.length,
  };
}

/** Valida todo el grafo sin escribir: insumo del ensayo de migración (Fase 5). */
export async function validateEditorialGraph(db: Db): Promise<{
  destinations: { id: string; canonicalUrl: string; errors: string[]; warnings: string[] }[];
  services: { id: string; errors: string[]; warnings: string[] }[];
  boardingPoints: { id: string; errors: string[] }[];
  totalErrors: number;
}> {
  const ctx = await buildValidationContext(db);
  const destinations = ctx.graph.destinations.map((d) => {
    const result = validateDestination(d, ctx);
    return {
      id: d.id,
      canonicalUrl: result.canonicalUrl,
      errors: formatIssues(result.errors),
      warnings: formatIssues(result.warnings),
    };
  });
  const services = ctx.graph.services.map((s) => {
    const result = validateService(s, ctx);
    return { id: s.id, errors: formatIssues(result.errors), warnings: formatIssues(result.warnings) };
  });
  const boardingPoints = ctx.graph.boardingPoints.map((p) => ({
    id: p.id,
    errors: formatIssues(validateBoardingPoint(p)),
  }));

  const totalErrors =
    destinations.reduce((n, d) => n + d.errors.length, 0) +
    services.reduce((n, s) => n + s.errors.length, 0) +
    boardingPoints.reduce((n, p) => n + p.errors.length, 0);

  return { destinations, services, boardingPoints, totalErrors };
}
