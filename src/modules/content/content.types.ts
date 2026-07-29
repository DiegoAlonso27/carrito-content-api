/**
 * Tipos del contrato de contenido.
 *
 * Los tipos `Cache*` replican EXACTAMENTE las formas de content-cache.json
 * (contrato heredado del pipeline SQL; ver golden file en la raíz del repo).
 * Los tipos `*Doc` son los documentos de MongoDB: misma información más el
 * sobre editorial (status/revision/fechas). `rowVersionToken` no se persiste:
 * se deriva de `revision` al exportar.
 */

import type { Static } from '@sinclair/typebox';
import type {
  cacheAssetSchema,
  cacheCollectionSchema,
  cacheItemSchema,
  cacheLocaleSchema,
  cachePageSchema,
  cacheSettingSchema,
  cacheTextSchema,
  cacheVersionTokenSchema,
  contentCacheSchema,
} from './content.schemas.js';

export type CacheLocale = Static<typeof cacheLocaleSchema>;
export type CacheSetting = Static<typeof cacheSettingSchema>;
export type CachePage = Static<typeof cachePageSchema>;
export type CacheText = Static<typeof cacheTextSchema>;
export type CacheAsset = Static<typeof cacheAssetSchema>;
export type CacheCollection = Static<typeof cacheCollectionSchema>;
export type CacheItem = Static<typeof cacheItemSchema>;
export type CacheVersionToken = Static<typeof cacheVersionTokenSchema>;
/** Tablas de origen del pipeline SQL: forman parte del contrato del export. */
export type SourceTable = CacheVersionToken['sourceTable'];
export type ContentCache = Static<typeof contentCacheSchema>;

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
}
