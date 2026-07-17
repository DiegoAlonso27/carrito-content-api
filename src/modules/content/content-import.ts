import type { Db, Document, Filter } from 'mongodb';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import sanitizeHtml from 'sanitize-html';
import { contentCacheSchema, htmlDataFields, itemDataSchemas } from './content.schemas.js';
import { contentCollections, ensureContentSetup } from './content.collections.js';
import {
  assetToCache,
  collectionToCache,
  formatToken,
  itemToCache,
  localeToCache,
  pageToCache,
  parseToken,
  settingToCache,
  sourceKeyOf,
  textToCache,
} from './content.mappers.js';
import type {
  AssetDoc,
  CacheItem,
  CollectionDoc,
  ContentCache,
  ContentMetaDoc,
  ItemDoc,
  LocaleDoc,
  PageDoc,
  SettingDoc,
  SourceTable,
  TextDoc,
} from './content.types.js';

// ── Validación del archivo fuente ───────────────────────────────────────────

const cacheChecker = TypeCompiler.Compile(contentCacheSchema);
const dataCheckers = new Map(
  Object.entries(itemDataSchemas).map(([slug, schema]) => [slug, TypeCompiler.Compile(schema)]),
);

/** Valida la forma completa del cache (sobre + `data` por colección). */
export function validateCache(raw: unknown): { cache: ContentCache | null; errors: string[] } {
  const errors: string[] = [];
  for (const issue of cacheChecker.Errors(raw)) {
    errors.push(`${issue.path}: ${issue.message}`);
    if (errors.length >= 20) break;
  }
  if (errors.length > 0) return { cache: null, errors };

  const cache = raw as ContentCache;
  for (const item of cache.items) {
    const checker = dataCheckers.get(item.collectionSlug);
    const id = `items/${item.collectionSlug}/${item.localeCode}/${item.slug}`;
    if (!checker) {
      errors.push(`${id}: colección sin esquema de data registrado`);
      continue;
    }
    for (const issue of checker.Errors(item.data)) {
      errors.push(`${id}: data${issue.path} ${issue.message}`);
    }
  }
  return errors.length > 0 ? { cache: null, errors } : { cache, errors: [] };
}

// ── Sanitización de HTML embebido ───────────────────────────────────────────

/**
 * Allowlist estricta para answerHtml/bodyHtml. El contenido actual solo usa
 * <p> y <h4> sin atributos; se admite un margen editorial mínimo sin
 * atributos de evento ni estilos.
 */
const sanitizeOptions: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'strong', 'em', 'ul', 'ol', 'li', 'h3', 'h4'],
  allowedAttributes: {},
  disallowedTagsMode: 'discard',
};

export function sanitizeContentHtml(html: string): string {
  return sanitizeHtml(html, sanitizeOptions);
}

export interface SanitizationChange {
  itemKey: string;
  field: string;
  original: string;
  sanitized: string;
}

/** Devuelve los campos cuyo HTML cambiaría al sanitizar (gate de importación). */
export function checkHtmlSanitization(cache: ContentCache): SanitizationChange[] {
  const changes: SanitizationChange[] = [];
  for (const item of cache.items) {
    for (const field of htmlDataFields[item.collectionSlug] ?? []) {
      const original = item.data[field];
      if (typeof original !== 'string') continue;
      const sanitized = sanitizeContentHtml(original);
      if (sanitized !== original) {
        changes.push({
          itemKey: `${item.collectionSlug}/${item.localeCode}/${item.slug}`,
          field,
          original,
          sanitized,
        });
      }
    }
  }
  return changes;
}

// ── Tokens de versión del archivo fuente ────────────────────────────────────

class TokenMap {
  private readonly map = new Map<string, number>();

  constructor(cache: ContentCache) {
    for (const t of cache.versionTokens) {
      this.map.set(`${t.sourceTable}:${t.sourceKey}`, parseToken(t.rowVersionToken));
    }
  }

  revisionOf(table: SourceTable, key: string): number {
    const revision = this.map.get(`${table}:${key}`);
    if (revision === undefined) {
      throw new Error(`versionTokens no contiene ${table}:${key} — archivo fuente inconsistente`);
    }
    return revision;
  }

  get maxRevision(): number {
    return Math.max(0, ...this.map.values());
  }
}

// ── Importación idempotente ─────────────────────────────────────────────────

export interface SectionSummary {
  inserted: number;
  updated: number;
  unchanged: number;
  total: number;
}

export type ImportSummary = Record<
  'locales' | 'settings' | 'pages' | 'texts' | 'assets' | 'collections' | 'items',
  SectionSummary
>;

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

/** Forma mínima común de los documentos almacenados (con sobre temporal). */
interface StoredDoc extends Document {
  createdAt: Date;
  updatedAt: Date;
}

async function upsertSection<T extends Document>(
  db: Db,
  collection: string,
  records: T[],
  keyOf: (r: T) => Filter<StoredDoc>,
  now: Date,
): Promise<SectionSummary> {
  const col = db.collection<StoredDoc>(collection);
  const summary: SectionSummary = { inserted: 0, updated: 0, unchanged: 0, total: records.length };

  for (const desired of records) {
    const existing = await col.findOne(keyOf(desired));
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
    await col.replaceOne(keyOf(desired), { ...desired, createdAt, updatedAt: now });
    summary.updated += 1;
  }
  return summary;
}

type Bare<T> = Omit<T, 'createdAt' | 'updatedAt'>;

/**
 * Importa el cache a carrito_content de forma idempotente (upsert por clave
 * natural; una segunda corrida sin cambios no modifica nada).
 *
 * Todo registro presente en el cache nace `published`: el export del pipeline
 * SQL incluye también registros isActive:false (el filtrado es del front),
 * así que `status` e `isActive` son dimensiones independientes.
 *
 * `revision` se siembra desde versionTokens para que el primer export
 * reproduzca los tokens originales exactos.
 */
export async function importCache(db: Db, cache: ContentCache): Promise<ImportSummary> {
  await ensureContentSetup(db);
  const tokens = new TokenMap(cache);
  const now = new Date();
  const published = { status: 'published' as const };

  const locales: Bare<LocaleDoc>[] = cache.locales.map((r) => ({
    ...r,
    ...published,
    revision: tokens.revisionOf('Locale', sourceKeyOf.Locale(r)),
  }));
  const settings: Bare<SettingDoc>[] = cache.settings.map((r) => ({
    ...r,
    ...published,
    revision: tokens.revisionOf('Setting', sourceKeyOf.Setting(r)),
  }));
  const pages: Bare<PageDoc>[] = cache.pages.map((r) => ({
    ...r,
    ...published,
    revision: tokens.revisionOf('Page', sourceKeyOf.Page(r)),
  }));
  const texts: Bare<TextDoc>[] = cache.texts.map((r) => ({
    ...r,
    ...published,
    revision: tokens.revisionOf('ContentText', sourceKeyOf.ContentText(r)),
  }));
  const assets: Bare<AssetDoc>[] = cache.assets.map((r) => ({
    ...r,
    ...published,
    revision: tokens.revisionOf('Asset', sourceKeyOf.Asset(r)),
  }));
  const collections: Bare<CollectionDoc>[] = cache.collections.map((r) => ({
    ...r,
    ...published,
    revision: tokens.revisionOf('ContentCollection', sourceKeyOf.ContentCollection(r)),
  }));
  const items: Bare<ItemDoc>[] = cache.items.map(({ rowVersionToken, ...r }) => {
    void rowVersionToken;
    return {
      ...r,
      ...published,
      revision: tokens.revisionOf('ContentItem', sourceKeyOf.ContentItem(r)),
    };
  });

  const c = contentCollections;
  const summary: ImportSummary = {
    locales: await upsertSection(db, c.locales, locales, (r) => ({ code: r.code }), now),
    settings: await upsertSection(db, c.settings, settings, (r) => ({ key: r.key }), now),
    pages: await upsertSection(
      db,
      c.pages,
      pages,
      (r) => ({ localeCode: r.localeCode, slug: r.slug }),
      now,
    ),
    texts: await upsertSection(
      db,
      c.texts,
      texts,
      (r) => ({ localeCode: r.localeCode, key: r.key }),
      now,
    ),
    assets: await upsertSection(db, c.assets, assets, (r) => ({ slug: r.slug }), now),
    collections: await upsertSection(
      db,
      c.collections,
      collections,
      (r) => ({ slug: r.slug }),
      now,
    ),
    items: await upsertSection(
      db,
      c.items,
      items,
      (r) => ({ collectionSlug: r.collectionSlug, localeCode: r.localeCode, slug: r.slug }),
      now,
    ),
  };

  // contentVersion solo se inicializa; tokenSeq nunca retrocede (ediciones
  // posteriores a una migración repetida conservan tokens monótonos).
  await db
    .collection<ContentMetaDoc>(c.meta)
    .updateOne(
      { _id: 'content' },
      { $setOnInsert: { contentVersion: 1 }, $max: { tokenSeq: tokens.maxRevision + 1 } },
      { upsert: true },
    );

  return summary;
}

// ── Verificación contra el archivo fuente ───────────────────────────────────

export interface VerifyResult {
  ok: boolean;
  diffs: string[];
}

/**
 * Reconstruye la forma del contrato desde MongoDB y la compara registro a
 * registro con el archivo fuente (incluidos los rowVersionToken derivados de
 * `revision`). No compara orden: eso pertenece al test de contrato del
 * export (F2).
 */
export async function verifyCache(db: Db, cache: ContentCache): Promise<VerifyResult> {
  const diffs: string[] = [];
  const c = contentCollections;

  async function compareSection<TDoc extends Document, TCache>(
    name: string,
    collection: string,
    sourceRecords: TCache[],
    toCache: (d: TDoc) => TCache,
    keyOf: (r: TCache) => string,
  ): Promise<void> {
    const docs = await db.collection(collection).find({}).toArray();
    const fromDb = new Map(
      docs.map((d) => {
        const mapped = toCache(d as unknown as TDoc);
        return [keyOf(mapped), mapped] as const;
      }),
    );
    if (fromDb.size !== sourceRecords.length) {
      diffs.push(`${name}: ${fromDb.size} documentos vs ${sourceRecords.length} en el archivo`);
    }
    for (const source of sourceRecords) {
      const stored = fromDb.get(keyOf(source));
      if (stored === undefined) {
        diffs.push(`${name}/${keyOf(source)}: ausente en MongoDB`);
      } else if (!deepEqual(stored, source)) {
        diffs.push(`${name}/${keyOf(source)}: contenido distinto`);
      }
      if (diffs.length >= 20) return;
    }
  }

  await compareSection(c.locales, c.locales, cache.locales, localeToCache, (r) => r.code);
  await compareSection(c.settings, c.settings, cache.settings, settingToCache, (r) => r.key);
  await compareSection(c.pages, c.pages, cache.pages, pageToCache, sourceKeyOf.Page);
  await compareSection(c.texts, c.texts, cache.texts, textToCache, sourceKeyOf.ContentText);
  await compareSection(c.assets, c.assets, cache.assets, assetToCache, (r) => r.slug);
  await compareSection(
    'content_collections',
    c.collections,
    cache.collections,
    collectionToCache,
    (r) => r.slug,
  );
  await compareSection<ItemDoc, CacheItem>(
    'content_items',
    c.items,
    cache.items,
    itemToCache,
    sourceKeyOf.ContentItem,
  );

  const meta = await db.collection<ContentMetaDoc>(c.meta).findOne({ _id: 'content' });
  if (meta === null) {
    diffs.push('meta/content: ausente');
  } else {
    const expectedSeq = new TokenMap(cache).maxRevision + 1;
    if (meta.tokenSeq < expectedSeq) {
      diffs.push(
        `meta/content: tokenSeq ${String(meta.tokenSeq)} < esperado ${String(expectedSeq)} (${formatToken(expectedSeq)})`,
      );
    }
  }

  return { ok: diffs.length === 0, diffs };
}
