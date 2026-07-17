import type { Db, Document, Filter } from 'mongodb';
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
import { contentCollections, ensureContentSetup } from './content.collections.js';
import { formatToken } from './content.mappers.js';
import { sanitizeContentHtml } from './content-import.js';
import type { ContentMetaDoc, EditorialStatus } from './content.types.js';

/**
 * Escritura editorial (la usan los CLIs de scripts/content/; sin panel en
 * fase 1). Única ruta de escritura del contenido: valida contra los mismos
 * esquemas del contrato, sanitiza el HTML embebido, asigna `revision` desde
 * el contador global (token nuevo por cada cambio) e incrementa
 * `contentVersion` (invalida cachés/ETag de bundle y export).
 */

export type SectionName =
  'locales' | 'settings' | 'pages' | 'texts' | 'assets' | 'collections' | 'items';

interface SectionSpec {
  collection: string;
  schema: TObject;
  /** Clave natural con la MISMA forma que el sourceKey del contrato. */
  keyFields: string[];
}

/** Item de entrada editorial: la forma del contrato sin rowVersionToken (derivado). */
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

/** Forma mínima de los documentos editoriales almacenados. */
interface EditorialStoredDoc extends Document {
  status: EditorialStatus;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

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

function keyOf(spec: SectionSpec, record: Record<string, unknown>): string {
  return spec.keyFields.map((f) => String(record[f])).join('/');
}

function keyFilter(spec: SectionSpec, record: Record<string, unknown>): Filter<Document> {
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

async function allocateRevision(db: Db): Promise<number> {
  const meta = await db
    .collection<ContentMetaDoc>(contentCollections.meta)
    .findOneAndUpdate(
      { _id: 'content' },
      { $inc: { tokenSeq: 1 }, $setOnInsert: { contentVersion: 1 } },
      { upsert: true, returnDocument: 'before' },
    );
  // Primer uso sobre BD vacía: el doc no existía; arranca en 1.
  return meta?.tokenSeq ?? 1;
}

async function bumpContentVersion(db: Db): Promise<number> {
  const meta = await db
    .collection<ContentMetaDoc>(contentCollections.meta)
    .findOneAndUpdate(
      { _id: 'content' },
      { $inc: { contentVersion: 1 } },
      { upsert: true, returnDocument: 'after' },
    );
  return meta?.contentVersion ?? 1;
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

/** Sanitiza los campos HTML de un item; devuelve los campos modificados. */
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

/** Verifica integridad referencial mínima antes de escribir. */
async function checkReferences(
  db: Db,
  section: SectionName,
  record: Record<string, unknown>,
): Promise<void> {
  if (section === 'items') {
    const slug = record['collectionSlug'];
    const exists = await db
      .collection(contentCollections.collections)
      .findOne({ slug }, { projection: { _id: 1 } });
    if (exists === null) {
      throw new ContentWriteError(`la colección '${String(slug)}' no existe (créala primero)`);
    }
  }
  if (section === 'items' || section === 'pages' || section === 'texts') {
    const code = record['localeCode'];
    const exists = await db
      .collection(contentCollections.locales)
      .findOne({ code }, { projection: { _id: 1 } });
    if (exists === null) {
      throw new ContentWriteError(`el locale '${String(code)}' no existe (créalo primero)`);
    }
  }
}

/**
 * Crea o actualiza registros de una sección.
 *
 * - Registro NUEVO: nace `draft` salvo publish=true (publicar es un acto
 *   explícito). Registro EXISTENTE: conserva su status (publish=true lo
 *   publica en la misma operación).
 * - Sin cambios reales → no se asigna token ni se toca contentVersion.
 */
export async function setRecords(
  db: Db,
  section: SectionName,
  records: unknown[],
  opts: { publish?: boolean } = {},
): Promise<{ results: SetResult[]; contentVersion: number | null }> {
  await ensureContentSetup(db);
  const spec = sections[section];

  // Validación completa ANTES de escribir nada (todo-o-nada por lote).
  const allErrors: string[] = [];
  for (const [i, record] of records.entries()) {
    for (const e of validateRecord(section, record)) allErrors.push(`[${String(i)}] ${e}`);
  }
  if (allErrors.length > 0) {
    throw new ContentWriteError(`registros inválidos para '${section}'`, allErrors);
  }

  const col = db.collection<EditorialStoredDoc>(spec.collection);
  const results: SetResult[] = [];
  let wrote = false;

  for (const raw of records) {
    const record = raw as Record<string, unknown>;
    await checkReferences(db, section, record);
    const sanitizedFields = sanitizeItemHtml(section, record);
    const key = keyOf(spec, record);
    const existing = await col.findOne(keyFilter(spec, record));
    const now = new Date();

    if (existing === null) {
      const status: EditorialStatus = opts.publish === true ? 'published' : 'draft';
      const revision = await allocateRevision(db);
      await col.insertOne({ ...record, status, revision, createdAt: now, updatedAt: now });
      wrote = true;
      results.push({
        key,
        action: 'created',
        status,
        token: formatToken(revision),
        sanitizedFields,
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
      results.push({
        key,
        action: 'unchanged',
        status: currentStatus,
        token: formatToken(revision),
        sanitizedFields,
      });
      continue;
    }

    const newRevision = await allocateRevision(db);
    await col.replaceOne(keyFilter(spec, record), {
      ...record,
      status: targetStatus,
      revision: newRevision,
      createdAt,
      updatedAt: now,
    });
    wrote = true;
    results.push({
      key,
      action: 'updated',
      status: targetStatus,
      token: formatToken(newRevision),
      sanitizedFields,
    });
  }

  const contentVersion = wrote ? await bumpContentVersion(db) : null;
  return { results, contentVersion };
}

/** Cambia el estado editorial de un registro identificado por su clave natural. */
export async function setStatus(
  db: Db,
  section: SectionName,
  key: string,
  target: EditorialStatus,
): Promise<{ result: StatusChangeResult; contentVersion: number | null }> {
  const spec = sections[section];
  const parts = key.split('/');
  if (parts.length !== spec.keyFields.length) {
    throw new ContentWriteError(
      `clave inválida para '${section}': se espera ${spec.keyFields.join('/')}`,
    );
  }
  const filter = Object.fromEntries(spec.keyFields.map((f, i) => [f, parts[i]]));

  const col = db.collection<EditorialStoredDoc>(spec.collection);
  const existing = await col.findOne(filter);
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

  const revision = await allocateRevision(db);
  await col.updateOne(filter, {
    $set: { status: target, revision, updatedAt: new Date() },
  });
  const contentVersion = await bumpContentVersion(db);
  return {
    result: { key, previous, current: target, token: formatToken(revision) },
    contentVersion,
  };
}

export interface SectionStatusSummary {
  section: SectionName;
  total: number;
  byStatus: Record<string, number>;
}

/** Resumen editorial: conteos por sección/estado + meta global. */
export async function statusSummary(db: Db): Promise<{
  contentVersion: number;
  tokenSeq: number;
  sections: SectionStatusSummary[];
}> {
  const meta = await db
    .collection<ContentMetaDoc>(contentCollections.meta)
    .findOne({ _id: 'content' });

  const summaries: SectionStatusSummary[] = [];
  for (const [name, spec] of Object.entries(sections) as [SectionName, SectionSpec][]) {
    const groups = (await groupByStatus(db, spec.collection)) as {
      _id: string;
      count: number;
    }[];
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

function groupByStatus(db: Db, collection: string): Promise<unknown[]> {
  return db
    .collection(collection)
    .aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])
    .toArray();
}
