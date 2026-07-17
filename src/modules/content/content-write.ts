import type { Db } from 'mongodb';
import { Type } from '@sinclair/typebox';
import type { TObject } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import type { TypeCheck } from '@sinclair/typebox/compiler';
import {
  cacheAssetSchema,
  cacheCollectionSchema,
  cacheItemSchema,
  cacheLocaleSchema,
  cachePageSchema,
  cacheSettingSchema,
  cacheTextSchema,
  htmlDataFields,
  itemDataSchemas,
} from './content.schemas.js';
import { contentCollections } from './content.collections.js';
import { formatToken } from './content.mappers.js';
import { sanitizeContentHtml } from './content-import.js';
import { ContentRepo, ContentTopologyError } from './content.repo.js';
import type { EditorialStoredDoc } from './content.repo.js';
import type { AssetDoc, CollectionDoc, EditorialStatus, LocaleDoc } from './content.types.js';

/**
 * Escritura editorial (CLIs `scripts/content/`; sin panel en fase 1).
 * Sin acceso directo a MongoDB: delega persistencia a `ContentRepo`.
 */

export type SectionName =
  'locales' | 'settings' | 'pages' | 'texts' | 'assets' | 'collections' | 'items';

interface SectionSpec {
  collection: string;
  schema: TObject;
  keyFields: string[];
}

const inputItemSchema = Type.Omit(cacheItemSchema, ['rowVersionToken']);

export const sections: Record<SectionName, SectionSpec> = {
  locales: {
    collection: contentCollections.locales,
    schema: cacheLocaleSchema,
    keyFields: ['code'],
  },
  settings: {
    collection: contentCollections.settings,
    schema: cacheSettingSchema,
    keyFields: ['key'],
  },
  pages: {
    collection: contentCollections.pages,
    schema: cachePageSchema,
    keyFields: ['localeCode', 'slug'],
  },
  texts: {
    collection: contentCollections.texts,
    schema: cacheTextSchema,
    keyFields: ['localeCode', 'key'],
  },
  assets: { collection: contentCollections.assets, schema: cacheAssetSchema, keyFields: ['slug'] },
  collections: {
    collection: contentCollections.collections,
    schema: cacheCollectionSchema,
    keyFields: ['slug'],
  },
  items: {
    collection: contentCollections.items,
    schema: inputItemSchema,
    keyFields: ['collectionSlug', 'localeCode', 'slug'],
  },
};

const checkers = new Map<SectionName, TypeCheck<TObject>>(
  (Object.entries(sections) as [SectionName, SectionSpec][]).map(([name, spec]) => [
    name,
    TypeCompiler.Compile(spec.schema),
  ]),
);
const dataCheckers = new Map(
  Object.entries(itemDataSchemas).map(([slug, schema]) => [slug, TypeCompiler.Compile(schema)]),
);

export class ContentWriteError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'ContentWriteError';
  }
}

export interface SetResult {
  key: string;
  action: 'created' | 'updated' | 'unchanged';
  status: EditorialStatus;
  token: string;
  sanitizedFields: string[];
}

export interface StatusChangeResult {
  key: string;
  previous: EditorialStatus;
  current: EditorialStatus;
  token: string;
}

export interface SectionStatusSummary {
  section: SectionName;
  total: number;
  byStatus: Record<string, number>;
}

function keyOf(spec: SectionSpec, record: Record<string, unknown>): string {
  return spec.keyFields.map((f) => String(record[f])).join('/');
}

function keyFilter(spec: SectionSpec, record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(spec.keyFields.map((f) => [f, record[f]]));
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

function validateRecord(section: SectionName, record: unknown): string[] {
  const checker = checkers.get(section);
  if (checker === undefined) return ['sección desconocida'];
  const errors = [...checker.Errors(record)].map((e) => `${e.path}: ${e.message}`);
  if (section === 'items' && errors.length === 0) {
    const item = record as { collectionSlug: string; data: Record<string, unknown> };
    const dataChecker = dataCheckers.get(item.collectionSlug);
    if (dataChecker === undefined) {
      errors.push(`data: la colección '${item.collectionSlug}' no tiene esquema registrado`);
    } else {
      errors.push(...[...dataChecker.Errors(item.data)].map((e) => `data${e.path}: ${e.message}`));
    }
  }
  return errors;
}

function sanitizeItemHtml(section: SectionName, record: Record<string, unknown>): string[] {
  if (section !== 'items') return [];
  const item = record as { collectionSlug: string; data: Record<string, unknown> };
  const changed: string[] = [];
  for (const field of htmlDataFields[item.collectionSlug] ?? []) {
    const original = item.data[field];
    if (typeof original !== 'string') continue;
    const sanitized = sanitizeContentHtml(original);
    if (sanitized !== original) {
      item.data[field] = sanitized;
      changed.push(field);
    }
  }
  return changed;
}

function assetSlugsInValue(value: unknown): string[] {
  const slugs: string[] = [];
  const walk = (obj: unknown): void => {
    if (obj === null || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (const entry of obj) walk(entry);
      return;
    }
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if ((k === 'imageAsset' || k === 'iconAsset') && typeof v === 'string' && v.length > 0) {
        slugs.push(v);
      } else {
        walk(v);
      }
    }
  };
  walk(value);
  return slugs;
}

interface ReferenceContext {
  locales: Map<string, LocaleDoc>;
  collections: Map<string, CollectionDoc>;
  assets: Map<string, AssetDoc>;
}

async function loadReferenceContext(
  repo: ContentRepo,
  section: SectionName,
  records: Record<string, unknown>[],
): Promise<ReferenceContext> {
  const localeCodes = new Set<string>();
  const collectionSlugs = new Set<string>();
  const assetSlugs = new Set<string>();

  for (const record of records) {
    if (section === 'items' || section === 'pages' || section === 'texts') {
      localeCodes.add(String(record['localeCode']));
    }
    if (section === 'items') {
      collectionSlugs.add(String(record['collectionSlug']));
      for (const slug of assetSlugsInValue(record['data'])) assetSlugs.add(slug);
    }
    if (section === 'pages') {
      const og = record['ogImageSlug'];
      if (typeof og === 'string' && og.length > 0) assetSlugs.add(og);
    }
  }

  const locales = new Map<string, LocaleDoc>();
  for (const code of localeCodes) {
    const doc = await repo.findLocaleByCode(code);
    if (doc !== null) locales.set(code, doc);
  }

  const collections = new Map<string, CollectionDoc>();
  for (const slug of collectionSlugs) {
    const doc = await repo.findCollectionBySlug(slug);
    if (doc !== null) collections.set(slug, doc);
  }

  const assets = await repo.findAssetsBySlugs([...assetSlugs]);
  return { locales, collections, assets };
}

function assertLocaleExists(code: string, ctx: ReferenceContext): void {
  if (!ctx.locales.has(code)) {
    throw new ContentWriteError(`el locale '${code}' no existe (créalo primero)`);
  }
}

function assertCollectionExists(slug: string, ctx: ReferenceContext): void {
  if (!ctx.collections.has(slug)) {
    throw new ContentWriteError(`la colección '${slug}' no existe (créala primero)`);
  }
}

function assertAssetExists(slug: string, ctx: ReferenceContext): void {
  if (!ctx.assets.has(slug)) {
    throw new ContentWriteError(`el asset '${slug}' no existe (créalo primero)`);
  }
}

function checkExistence(
  section: SectionName,
  record: Record<string, unknown>,
  ctx: ReferenceContext,
): void {
  if (section === 'items') {
    assertCollectionExists(String(record['collectionSlug']), ctx);
    for (const slug of assetSlugsInValue(record['data'])) assertAssetExists(slug, ctx);
  }
  if (section === 'items' || section === 'pages' || section === 'texts') {
    assertLocaleExists(String(record['localeCode']), ctx);
  }
  if (section === 'pages') {
    const og = record['ogImageSlug'];
    if (typeof og === 'string' && og.length > 0) assertAssetExists(og, ctx);
  }
}

function editorialContent(doc: EditorialStoredDoc & { _id?: unknown }): Record<string, unknown> {
  const { _id, status, revision, createdAt, updatedAt, ...content } = doc;
  void _id;
  void status;
  void revision;
  void createdAt;
  void updatedAt;
  return content;
}

function checkPublishInvariants(
  section: SectionName,
  record: Record<string, unknown>,
  ctx: ReferenceContext,
): void {
  if (section === 'items') {
    const slug = String(record['collectionSlug']);
    const col = ctx.collections.get(slug);
    if (col === undefined) {
      throw new ContentWriteError(`la colección '${slug}' no existe (créala primero)`);
    }
    if (col.status !== 'published') {
      throw new ContentWriteError(
        `no se puede publicar: la colección '${slug}' no está publicada (estado ${col.status})`,
      );
    }
  }

  if (section === 'items' || section === 'pages' || section === 'texts') {
    const code = String(record['localeCode']);
    const locale = ctx.locales.get(code);
    if (locale === undefined) {
      throw new ContentWriteError(`el locale '${code}' no existe (créalo primero)`);
    }
    if (locale.status !== 'published') {
      throw new ContentWriteError(
        `no se puede publicar: el locale '${code}' no está publicado (estado ${locale.status})`,
      );
    }
    if (!locale.isActive) {
      throw new ContentWriteError(`no se puede publicar: el locale '${code}' está inactivo`);
    }
  }

  if (section === 'items') {
    for (const assetSlug of assetSlugsInValue(record['data'])) {
      assertAssetExists(assetSlug, ctx);
    }
  }
  if (section === 'pages') {
    const og = record['ogImageSlug'];
    if (typeof og === 'string' && og.length > 0) assertAssetExists(og, ctx);
  }
}

interface PlannedWrite {
  key: string;
  filter: Record<string, unknown>;
  record: Record<string, unknown>;
  sanitizedFields: string[];
  targetStatus: EditorialStatus;
  action: 'created' | 'updated';
  existingCreatedAt?: Date;
}

export async function setRecords(
  db: Db,
  section: SectionName,
  records: unknown[],
  opts: { publish?: boolean } = {},
): Promise<{ results: SetResult[]; contentVersion: number | null }> {
  const repo = new ContentRepo(db);
  await repo.ensureSetup();
  const spec = sections[section];

  const allErrors: string[] = [];
  for (const [i, record] of records.entries()) {
    for (const e of validateRecord(section, record)) allErrors.push(`[${String(i)}] ${e}`);
  }
  if (allErrors.length > 0) {
    throw new ContentWriteError(`registros inválidos para '${section}'`, allErrors);
  }

  // Claves naturales duplicadas en el mismo lote → fallo de índice único a mitad.
  const batchKeys = records.map((raw) => keyOf(spec, raw as Record<string, unknown>));
  const seenKeys = new Set<string>();
  const duplicateKeys: string[] = [];
  for (const [i, key] of batchKeys.entries()) {
    if (seenKeys.has(key)) duplicateKeys.push(`[${String(i)}] clave duplicada '${key}'`);
    else seenKeys.add(key);
  }
  if (duplicateKeys.length > 0) {
    throw new ContentWriteError(
      `claves naturales duplicadas en el lote '${section}'`,
      duplicateKeys,
    );
  }

  const prepared = records.map((raw) => {
    const record = structuredClone(raw) as Record<string, unknown>;
    const sanitizedFields = sanitizeItemHtml(section, record);
    return { record, sanitizedFields };
  });

  const refCtx = await loadReferenceContext(
    repo,
    section,
    prepared.map((p) => p.record),
  );

  for (const { record } of prepared) {
    checkExistence(section, record, refCtx);
  }

  const planned: PlannedWrite[] = [];
  const unchanged: SetResult[] = [];

  for (const { record, sanitizedFields } of prepared) {
    const key = keyOf(spec, record);
    const filter = keyFilter(spec, record);
    const existing = await repo.findEditorialDoc(spec.collection, filter);

    if (existing === null) {
      const targetStatus: EditorialStatus = opts.publish === true ? 'published' : 'draft';
      if (targetStatus === 'published') {
        checkPublishInvariants(section, record, refCtx);
      }
      planned.push({
        key,
        filter,
        record,
        sanitizedFields,
        targetStatus,
        action: 'created',
      });
      continue;
    }

    const { _id, status, revision, createdAt, updatedAt, ...existingContent } = existing;
    void _id;
    void updatedAt;
    const currentStatus = status;
    const targetStatus: EditorialStatus = opts.publish === true ? 'published' : currentStatus;
    const contentChanged = !deepEqual(existingContent, record);
    const statusChanged = targetStatus !== currentStatus;

    if (!contentChanged && !statusChanged) {
      unchanged.push({
        key,
        action: 'unchanged',
        status: currentStatus,
        token: formatToken(revision),
        sanitizedFields,
      });
      continue;
    }

    if (targetStatus === 'published') {
      checkPublishInvariants(section, record, refCtx);
    }

    planned.push({
      key,
      filter,
      record,
      sanitizedFields,
      targetStatus,
      action: 'updated',
      existingCreatedAt: createdAt,
    });
  }

  if (planned.length === 0) {
    return { results: unchanged, contentVersion: null };
  }

  try {
    const { result, contentVersion } = await repo.withEditorialWrite(async (tx) => {
      const results: SetResult[] = [...unchanged];

      for (const plan of planned) {
        const now = new Date();
        if (plan.action === 'created') {
          const revision = await tx.allocateRevision();
          await tx.insertEditorialDoc(spec.collection, {
            ...plan.record,
            status: plan.targetStatus,
            revision,
            createdAt: now,
            updatedAt: now,
          });
          results.push({
            key: plan.key,
            action: 'created',
            status: plan.targetStatus,
            token: formatToken(revision),
            sanitizedFields: plan.sanitizedFields,
          });
          continue;
        }

        const existingCreatedAt = plan.existingCreatedAt;
        if (existingCreatedAt === undefined) {
          throw new Error('plan editorial sin documento existente');
        }
        const revision = await tx.allocateRevision();
        await tx.replaceEditorialDoc(spec.collection, plan.filter, {
          ...plan.record,
          status: plan.targetStatus,
          revision,
          createdAt: existingCreatedAt,
          updatedAt: now,
        });
        results.push({
          key: plan.key,
          action: 'updated',
          status: plan.targetStatus,
          token: formatToken(revision),
          sanitizedFields: plan.sanitizedFields,
        });
      }

      return { result: results, wrote: true };
    });

    return { results: result, contentVersion };
  } catch (err) {
    if (err instanceof ContentTopologyError) {
      throw new ContentWriteError(err.message);
    }
    throw err;
  }
}

export async function setStatus(
  db: Db,
  section: SectionName,
  key: string,
  target: EditorialStatus,
): Promise<{ result: StatusChangeResult; contentVersion: number | null }> {
  const repo = new ContentRepo(db);
  const spec = sections[section];
  const parts = key.split('/');
  if (parts.length !== spec.keyFields.length) {
    throw new ContentWriteError(
      `clave inválida para '${section}': se espera ${spec.keyFields.join('/')}`,
    );
  }
  const filter = Object.fromEntries(spec.keyFields.map((f, i) => [f, parts[i]]));

  const existing = await repo.findEditorialDoc(spec.collection, filter);
  if (existing === null) {
    throw new ContentWriteError(`no existe '${key}' en '${section}'`);
  }

  const previous = existing.status;
  if (previous === target) {
    return {
      result: { key, previous, current: target, token: formatToken(existing.revision) },
      contentVersion: null,
    };
  }

  if (target === 'published') {
    const content = editorialContent(existing);
    const refCtx = await loadReferenceContext(repo, section, [content]);
    checkPublishInvariants(section, content, refCtx);
  }

  try {
    const { result, contentVersion } = await repo.withEditorialWrite(async (tx) => {
      const revision = await tx.allocateRevision();
      const now = new Date();
      await tx.updateEditorialStatus(spec.collection, filter, target, revision, now);
      return {
        result: { key, previous, current: target, token: formatToken(revision) },
        wrote: true,
      };
    });

    return { result, contentVersion };
  } catch (err) {
    if (err instanceof ContentTopologyError) {
      throw new ContentWriteError(err.message);
    }
    throw err;
  }
}

export async function statusSummary(db: Db): Promise<{
  contentVersion: number;
  tokenSeq: number;
  sections: SectionStatusSummary[];
}> {
  const repo = new ContentRepo(db);
  const meta = await repo.getMeta();

  const summaries: SectionStatusSummary[] = [];
  for (const [name, spec] of Object.entries(sections) as [SectionName, SectionSpec][]) {
    const groups = await repo.aggregateStatusCounts(spec.collection);
    summaries.push({
      section: name,
      total: groups.reduce((sum, g) => sum + g.count, 0),
      byStatus: Object.fromEntries(groups.map((g) => [g._id, g.count])),
    });
  }
  return {
    contentVersion: meta?.contentVersion ?? 0,
    tokenSeq: meta?.tokenSeq ?? 0,
    sections: summaries,
  };
}

export async function listSectionDocs(
  db: Db,
  section: SectionName,
  status?: EditorialStatus,
): Promise<EditorialStoredDoc[]> {
  const repo = new ContentRepo(db);
  return repo.findByStatus(sections[section].collection, status);
}
