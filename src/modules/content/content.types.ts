/**
 * Tipos del contrato de contenido.
 *
 * Los tipos `Cache*` replican EXACTAMENTE las formas de content-cache.json
 * (contrato heredado del pipeline SQL; ver golden file en la raíz del repo).
 * Los tipos `*Doc` son los documentos de MongoDB: misma información más el
 * sobre editorial (status/revision/fechas). `rowVersionToken` no se persiste:
 * se deriva de `revision` al exportar.
 */

export interface CacheLocale {
  code: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
}

export interface CacheSetting {
  key: string;
  value: string;
  valueType: string;
  description: string;
  isActive: boolean;
  sortOrder: number;
}

export interface CachePage {
  localeCode: string;
  slug: string;
  route: string;
  title: string;
  metaTitle: string | null;
  metaDescription: string | null;
  ogImageSlug: string | null;
  isActive: boolean;
  sortOrder: number;
}

export interface CacheText {
  localeCode: string;
  key: string;
  value: string;
  isActive: boolean;
  sortOrder: number;
}

export interface CacheAsset {
  slug: string;
  path: string;
  altText: string | null;
  mimeType: string;
  width: number | null;
  height: number | null;
  isActive: boolean;
  sortOrder: number;
}

export interface CacheCollection {
  slug: string;
  name: string;
  description: string;
  isActive: boolean;
  sortOrder: number;
}

export interface CacheItem {
  collectionSlug: string;
  localeCode: string;
  slug: string;
  sortOrder: number;
  isActive: boolean;
  data: Record<string, unknown>;
  rowVersionToken: string;
}

/** Tablas de origen del pipeline SQL: forman parte del contrato del export. */
export type SourceTable =
  'Asset' | 'ContentCollection' | 'ContentItem' | 'ContentText' | 'Locale' | 'Page' | 'Setting';

export interface CacheVersionToken {
  sourceTable: SourceTable;
  sourceKey: string;
  rowVersionToken: string;
}

export interface ContentCache {
  generatedAtUtc: string;
  locales: CacheLocale[];
  settings: CacheSetting[];
  pages: CachePage[];
  texts: CacheText[];
  assets: CacheAsset[];
  collections: CacheCollection[];
  items: CacheItem[];
  versionTokens: CacheVersionToken[];
}

// ── Documentos de MongoDB ────────────────────────────────────────────────────

export type EditorialStatus = 'draft' | 'published' | 'archived';

/**
 * Sobre editorial común. `isActive` (visibilidad que el front aplica en
 * runtime) es ortogonal a `status`: el export incluye TODO lo `published`,
 * activo o no — verificado contra el golden file, que contiene items con
 * isActive:false.
 */
export interface EditorialEnvelope {
  status: EditorialStatus;
  /** Fuente del rowVersionToken sintético (0x + 16 hex). Incrementa al editar. */
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export type LocaleDoc = CacheLocale & EditorialEnvelope;
export type SettingDoc = CacheSetting & EditorialEnvelope;
export type PageDoc = CachePage & EditorialEnvelope;
export type TextDoc = CacheText & EditorialEnvelope;
export type AssetDoc = CacheAsset & EditorialEnvelope;
export type CollectionDoc = CacheCollection & EditorialEnvelope;
export type ItemDoc = Omit<CacheItem, 'rowVersionToken'> & EditorialEnvelope;

/** Singleton de metadatos globales del contenido (colección `meta`, _id 'content'). */
export interface ContentMetaDoc {
  _id: 'content';
  /** Incrementa con cualquier escritura editorial; base del ETag y el caché en memoria. */
  contentVersion: number;
  /** Próximo valor de token sintético a asignar. */
  tokenSeq: number;
  /**
   * true = escritura editorial en curso o interrumpida (standalone).
   * La lectura reconcilia con un bump de contentVersion (ADR-001).
   */
  editorialDirty: boolean;
}
