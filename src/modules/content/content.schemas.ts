import { Type } from '@sinclair/typebox';
import type { TObject, TSchema } from '@sinclair/typebox';

/**
 * Esquemas TypeBox del contrato de contenido: validan el golden file en la
 * migración (F1), las escrituras editoriales (F4) y sirven de response
 * schemas en los endpoints (F2/F3).
 *
 * `additionalProperties: false` en todo: un campo no declarado es un error
 * de contrato, no un dato a conservar en silencio.
 */

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

const editorialFlags = {
  isActive: Type.Boolean(),
  sortOrder: Type.Number(),
};

export const cacheLocaleSchema = Type.Object(
  {
    code: Type.String({ minLength: 2 }),
    name: Type.String({ minLength: 1 }),
    isDefault: Type.Boolean(),
    ...editorialFlags,
  },
  { additionalProperties: false },
);

export const cacheSettingSchema = Type.Object(
  {
    key: Type.String({ minLength: 1 }),
    value: Type.String(),
    valueType: Type.String({ minLength: 1 }),
    description: Type.String(),
    ...editorialFlags,
  },
  { additionalProperties: false },
);

export const cachePageSchema = Type.Object(
  {
    localeCode: Type.String({ minLength: 2 }),
    slug: Type.String({ minLength: 1 }),
    route: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    metaTitle: nullable(Type.String()),
    metaDescription: nullable(Type.String()),
    ogImageSlug: nullable(Type.String()),
    ...editorialFlags,
  },
  { additionalProperties: false },
);

export const cacheTextSchema = Type.Object(
  {
    localeCode: Type.String({ minLength: 2 }),
    key: Type.String({ minLength: 1 }),
    value: Type.String(),
    ...editorialFlags,
  },
  { additionalProperties: false },
);

export const cacheAssetSchema = Type.Object(
  {
    slug: Type.String({ minLength: 1 }),
    path: Type.String({ minLength: 1 }),
    altText: nullable(Type.String()),
    mimeType: Type.String({ minLength: 1 }),
    width: nullable(Type.Number()),
    height: nullable(Type.Number()),
    ...editorialFlags,
  },
  { additionalProperties: false },
);

export const cacheCollectionSchema = Type.Object(
  {
    slug: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    description: Type.String(),
    ...editorialFlags,
  },
  { additionalProperties: false },
);

export const cacheItemSchema = Type.Object(
  {
    collectionSlug: Type.String({ minLength: 1 }),
    localeCode: Type.String({ minLength: 2 }),
    slug: Type.String({ minLength: 1 }),
    sortOrder: Type.Number(),
    isActive: Type.Boolean(),
    // La forma fina se valida por colección con itemDataSchemas.
    data: Type.Record(Type.String(), Type.Unknown()),
    rowVersionToken: Type.String({ pattern: '^0x[0-9A-F]{16}$' }),
  },
  { additionalProperties: false },
);

export const cacheVersionTokenSchema = Type.Object(
  {
    sourceTable: Type.Union([
      Type.Literal('Asset'),
      Type.Literal('ContentCollection'),
      Type.Literal('ContentItem'),
      Type.Literal('ContentText'),
      Type.Literal('Locale'),
      Type.Literal('Page'),
      Type.Literal('Setting'),
    ]),
    sourceKey: Type.String({ minLength: 1 }),
    rowVersionToken: Type.String({ pattern: '^0x[0-9A-F]{16}$' }),
  },
  { additionalProperties: false },
);

export const contentCacheSchema = Type.Object(
  {
    generatedAtUtc: Type.String(),
    locales: Type.Array(cacheLocaleSchema),
    settings: Type.Array(cacheSettingSchema),
    pages: Type.Array(cachePageSchema),
    texts: Type.Array(cacheTextSchema),
    assets: Type.Array(cacheAssetSchema),
    collections: Type.Array(cacheCollectionSchema),
    items: Type.Array(cacheItemSchema),
    versionTokens: Type.Array(cacheVersionTokenSchema),
  },
  { additionalProperties: false },
);

// ── Esquemas de `data` por colección ────────────────────────────────────────
// Derivados del golden file completo (83 items, 15 formas distintas).

const galleryEntry = Type.Object({ imageAsset: Type.String() }, { additionalProperties: false });

const attractionEntry = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    imageAsset: Type.String(),
    duration: Type.String(),
    distance: Type.String(),
  },
  { additionalProperties: false },
);

const tipEntry = Type.Object(
  { icon: Type.String(), title: Type.String(), description: Type.String() },
  { additionalProperties: false },
);

const serviceOptionEntry = Type.Object(
  { iconAsset: Type.String(), name: Type.String() },
  { additionalProperties: false },
);

/**
 * Registro por collectionSlug. Una colección sin entrada aquí no puede
 * importarse ni editarse: agregar el esquema es parte de crear la colección.
 */
export const itemDataSchemas: Record<string, TObject> = {
  announcements: Type.Object(
    {
      title: Type.String(),
      body: Type.String(),
      style: Type.String(),
      activeFrom: nullable(Type.String()),
      activeTo: nullable(Type.String()),
      dismissKey: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  banners: Type.Object({ imageAsset: Type.String() }, { additionalProperties: false }),
  'contact-items': Type.Object(
    { name: Type.String(), to: Type.String(), iconKey: Type.String() },
    { additionalProperties: false },
  ),
  'destination-guides': Type.Object(
    {
      title: Type.String(),
      region: Type.String(),
      imageAsset: Type.String(),
      population: Type.String(),
      altitude: Type.String(),
      temperature: Type.String(),
      description: Type.String(),
      history: Type.String(),
      gastronomy: Type.String(),
      festivities: Type.String(),
      gallery: Type.Array(galleryEntry),
      attractions: Type.Array(attractionEntry),
      bestTime: Type.String(),
      bestTimeDetail: Type.String(),
      duration: Type.String(),
      durationDetail: Type.String(),
      howToArrive: Type.String(),
      howToArriveDetail: Type.String(),
      tips: Type.Array(tipEntry),
      services: Type.Array(Type.String()),
    },
    { additionalProperties: false },
  ),
  destinations: Type.Object(
    {
      tour: Type.String(),
      title: Type.String(),
      subTitle: Type.String(),
      description: Type.String(),
      imageAsset: Type.String(),
    },
    { additionalProperties: false },
  ),
  faqs: Type.Object(
    { question: Type.String(), answerHtml: Type.String() },
    { additionalProperties: false },
  ),
  features: Type.Object(
    {
      iconAsset: Type.String(),
      title: Type.String(),
      subTitle: Type.String(),
      description: Type.String(),
    },
    { additionalProperties: false },
  ),
  'footer-links': Type.Object(
    {
      label: Type.String(),
      to: Type.String(),
      group: Type.String(),
      iconKey: nullable(Type.String()),
    },
    { additionalProperties: false },
  ),
  'gallery-services': Type.Object({ imageAsset: Type.String() }, { additionalProperties: false }),
  'legal-sections': Type.Object(
    { page: Type.Optional(Type.String()), title: Type.String(), bodyHtml: Type.String() },
    { additionalProperties: false },
  ),
  'nav-links': Type.Object(
    { label: Type.String(), to: Type.String() },
    { additionalProperties: false },
  ),
  offers: Type.Object(
    {
      title: Type.String(),
      subTitle: Type.String(),
      price: Type.String(),
      imageAsset: Type.String(),
      tour: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  parcels: Type.Object(
    { title: Type.String(), description: Type.String(), imageAsset: Type.String() },
    { additionalProperties: false },
  ),
  'payment-methods': Type.Object(
    { name: Type.String(), iconAsset: Type.String() },
    { additionalProperties: false },
  ),
  services: Type.Object(
    {
      preTitle: Type.String(),
      title: Type.String(),
      description: Type.String(),
      imageAsset: Type.String(),
      to: Type.String(),
      options: Type.Array(serviceOptionEntry),
    },
    { additionalProperties: false },
  ),
};

/** Campos de `data` que contienen HTML y pasan por la sanitización allowlist. */
export const htmlDataFields: Record<string, string[]> = {
  faqs: ['answerHtml'],
  'legal-sections': ['bodyHtml'],
};
