import type {
  AssetDoc,
  CacheVersionToken,
  CollectionDoc,
  ItemDoc,
  LocaleDoc,
  PageDoc,
  SettingDoc,
  TextDoc,
} from './content.types.js';

/**
 * Orden del contrato, verificado empíricamente contra el golden file
 * (codepoints planos; la data actual no tiene empates ni ambigüedades de
 * mayúsculas). Lo comparten el export (byte-compatibilidad, F2) y el bundle
 * runtime (F3) para que ambos entreguen el mismo orden. Cambiar cualquier
 * comparador rompe el test de contrato.
 */
const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const chain =
  <T>(...cmps: ((a: T, b: T) => number)[]) =>
  (a: T, b: T): number => {
    for (const cmp of cmps) {
      const r = cmp(a, b);
      if (r !== 0) return r;
    }
    return 0;
  };

export const compareLocales = chain<Pick<LocaleDoc, 'sortOrder' | 'code'>>(
  (a, b) => a.sortOrder - b.sortOrder,
  (a, b) => byString(a.code, b.code),
);

export const compareSettings = (a: Pick<SettingDoc, 'key'>, b: Pick<SettingDoc, 'key'>): number =>
  byString(a.key, b.key);

export const comparePages = (a: Pick<PageDoc, 'slug'>, b: Pick<PageDoc, 'slug'>): number =>
  byString(a.slug, b.slug);

export const compareTexts = chain<Pick<TextDoc, 'localeCode' | 'key'>>(
  (a, b) => byString(a.localeCode, b.localeCode),
  (a, b) => byString(a.key, b.key),
);

export const compareAssets = (a: Pick<AssetDoc, 'slug'>, b: Pick<AssetDoc, 'slug'>): number =>
  byString(a.slug, b.slug);

export const compareCollections = chain<Pick<CollectionDoc, 'sortOrder' | 'slug'>>(
  (a, b) => a.sortOrder - b.sortOrder,
  (a, b) => byString(a.slug, b.slug),
);

export const compareItems = chain<
  Pick<ItemDoc, 'collectionSlug' | 'localeCode' | 'sortOrder' | 'slug'>
>(
  (a, b) => byString(a.collectionSlug, b.collectionSlug),
  (a, b) => byString(a.localeCode, b.localeCode),
  (a, b) => a.sortOrder - b.sortOrder,
  (a, b) => byString(a.slug, b.slug),
);

export const compareVersionTokens = chain<CacheVersionToken>(
  (a, b) => byString(a.sourceTable, b.sourceTable),
  (a, b) => byString(a.sourceKey, b.sourceKey),
);
