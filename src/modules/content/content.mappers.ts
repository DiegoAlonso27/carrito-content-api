import type {
  AssetDoc,
  CacheAsset,
  CacheCollection,
  CacheItem,
  CacheLocale,
  CachePage,
  CacheSetting,
  CacheText,
  CacheVersionToken,
  CollectionDoc,
  ItemDoc,
  LocaleDoc,
  PageDoc,
  SettingDoc,
  SourceTable,
  TextDoc,
} from './content.types.js';

/**
 * Mapeo documento ⇄ forma del contrato.
 *
 * ATENCIÓN: el ORDEN de las claves de cada literal replica el orden exacto
 * del content-cache.json actual. La compatibilidad byte-a-byte del export
 * (test de contrato, F2) depende de este orden: no reordenar.
 */

/** Token sintético con la forma exacta del rowversion SQL: 0x + 16 hex mayúsculas. */
export function formatToken(revision: number): string {
  return '0x' + revision.toString(16).toUpperCase().padStart(16, '0');
}

export function parseToken(token: string): number {
  return Number.parseInt(token.slice(2), 16);
}

export function localeToCache(d: LocaleDoc): CacheLocale {
  return {
    code: d.code,
    name: d.name,
    isDefault: d.isDefault,
    isActive: d.isActive,
    sortOrder: d.sortOrder,
  };
}

export function settingToCache(d: SettingDoc): CacheSetting {
  return {
    key: d.key,
    value: d.value,
    valueType: d.valueType,
    description: d.description,
    isActive: d.isActive,
    sortOrder: d.sortOrder,
  };
}

export function pageToCache(d: PageDoc): CachePage {
  return {
    localeCode: d.localeCode,
    slug: d.slug,
    route: d.route,
    title: d.title,
    metaTitle: d.metaTitle,
    metaDescription: d.metaDescription,
    ogImageSlug: d.ogImageSlug,
    isActive: d.isActive,
    sortOrder: d.sortOrder,
  };
}

export function textToCache(d: TextDoc): CacheText {
  return {
    localeCode: d.localeCode,
    key: d.key,
    value: d.value,
    isActive: d.isActive,
    sortOrder: d.sortOrder,
  };
}

export function assetToCache(d: AssetDoc): CacheAsset {
  return {
    slug: d.slug,
    path: d.path,
    altText: d.altText,
    mimeType: d.mimeType,
    width: d.width,
    height: d.height,
    isActive: d.isActive,
    sortOrder: d.sortOrder,
  };
}

export function collectionToCache(d: CollectionDoc): CacheCollection {
  return {
    slug: d.slug,
    name: d.name,
    description: d.description,
    isActive: d.isActive,
    sortOrder: d.sortOrder,
  };
}

export function itemToCache(d: ItemDoc): CacheItem {
  return {
    collectionSlug: d.collectionSlug,
    localeCode: d.localeCode,
    slug: d.slug,
    sortOrder: d.sortOrder,
    isActive: d.isActive,
    // El orden interno de `data` se preserva tal como se importó/editó.
    data: d.data,
    rowVersionToken: formatToken(d.revision),
  };
}

/**
 * sourceKey del pipeline SQL por tipo de registro (parte del contrato de
 * versionTokens): Asset/ContentCollection → slug; Locale → code;
 * Setting → key; Page → locale/slug; ContentText → locale/key;
 * ContentItem → collection/locale/slug.
 */
export const sourceKeyOf = {
  Locale: (d: Pick<LocaleDoc, 'code'>): string => d.code,
  Setting: (d: Pick<SettingDoc, 'key'>): string => d.key,
  Page: (d: Pick<PageDoc, 'localeCode' | 'slug'>): string => `${d.localeCode}/${d.slug}`,
  ContentText: (d: Pick<TextDoc, 'localeCode' | 'key'>): string => `${d.localeCode}/${d.key}`,
  Asset: (d: Pick<AssetDoc, 'slug'>): string => d.slug,
  ContentCollection: (d: Pick<CollectionDoc, 'slug'>): string => d.slug,
  ContentItem: (d: Pick<ItemDoc, 'collectionSlug' | 'localeCode' | 'slug'>): string =>
    `${d.collectionSlug}/${d.localeCode}/${d.slug}`,
} as const satisfies Record<SourceTable, (d: never) => string>;

export function versionToken(
  sourceTable: SourceTable,
  sourceKey: string,
  revision: number,
): CacheVersionToken {
  return {
    sourceTable,
    sourceKey,
    rowVersionToken: formatToken(revision),
  };
}
