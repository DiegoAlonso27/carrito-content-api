import type { Db, Document } from 'mongodb';

/** Nombres de colecciones de carrito_content (snake_case, convención del proyecto). */
export const contentCollections = {
  locales: 'locales',
  settings: 'settings',
  pages: 'pages',
  texts: 'texts',
  assets: 'assets',
  collections: 'content_collections',
  items: 'content_items',
  meta: 'meta',
} as const;

const statusEnum = ['draft', 'published', 'archived'];

/** Sobre editorial exigido por el validador de cada colección. */
const envelopeProps: Document = {
  status: { enum: statusEnum },
  revision: { bsonType: ['int', 'long', 'double'] },
  isActive: { bsonType: 'bool' },
  sortOrder: { bsonType: ['int', 'long', 'double'] },
  createdAt: { bsonType: 'date' },
  updatedAt: { bsonType: 'date' },
};

const envelopeRequired = ['status', 'revision', 'isActive', 'sortOrder', 'createdAt', 'updatedAt'];

function envelope(required: string[], properties: Document): Document {
  return {
    $jsonSchema: {
      bsonType: 'object',
      required: [...required, ...envelopeRequired],
      properties: { ...properties, ...envelopeProps },
    },
  };
}

/**
 * Validadores $jsonSchema por colección (nivel moderate): defensa en
 * profundidad sobre el sobre común y las claves naturales. La validación
 * fina (formas de `data`, longitudes) vive en el borde con TypeBox.
 */
const validators: Record<string, Document> = {
  [contentCollections.locales]: envelope(['code', 'name', 'isDefault'], {
    code: { bsonType: 'string' },
    name: { bsonType: 'string' },
    isDefault: { bsonType: 'bool' },
  }),
  [contentCollections.settings]: envelope(['key', 'value', 'valueType'], {
    key: { bsonType: 'string' },
    value: { bsonType: 'string' },
    valueType: { bsonType: 'string' },
  }),
  [contentCollections.pages]: envelope(['localeCode', 'slug', 'route', 'title'], {
    localeCode: { bsonType: 'string' },
    slug: { bsonType: 'string' },
    route: { bsonType: 'string' },
    title: { bsonType: 'string' },
  }),
  [contentCollections.texts]: envelope(['localeCode', 'key', 'value'], {
    localeCode: { bsonType: 'string' },
    key: { bsonType: 'string' },
    value: { bsonType: 'string' },
  }),
  [contentCollections.assets]: envelope(['slug', 'path', 'mimeType'], {
    slug: { bsonType: 'string' },
    path: { bsonType: 'string' },
    mimeType: { bsonType: 'string' },
  }),
  [contentCollections.collections]: envelope(['slug', 'name'], {
    slug: { bsonType: 'string' },
    name: { bsonType: 'string' },
  }),
  [contentCollections.items]: envelope(['collectionSlug', 'localeCode', 'slug', 'data'], {
    collectionSlug: { bsonType: 'string' },
    localeCode: { bsonType: 'string' },
    slug: { bsonType: 'string' },
    data: { bsonType: 'object' },
  }),
};

interface IndexSpec {
  collection: string;
  name: string;
  keys: Document;
  unique: boolean;
}

/**
 * Índices: los únicos son la idempotencia de migración/edición (clave
 * natural); los ix_ cubren la consulta pública "publicados por locale
 * (y colección) en orden".
 */
const indexes: IndexSpec[] = [
  {
    collection: contentCollections.locales,
    name: 'ux_locales_code',
    keys: { code: 1 },
    unique: true,
  },
  {
    collection: contentCollections.settings,
    name: 'ux_settings_key',
    keys: { key: 1 },
    unique: true,
  },
  {
    collection: contentCollections.pages,
    name: 'ux_pages_locale_slug',
    keys: { localeCode: 1, slug: 1 },
    unique: true,
  },
  {
    collection: contentCollections.pages,
    name: 'ix_pages_locale_status',
    keys: { localeCode: 1, status: 1 },
    unique: false,
  },
  {
    collection: contentCollections.texts,
    name: 'ux_texts_locale_key',
    keys: { localeCode: 1, key: 1 },
    unique: true,
  },
  {
    collection: contentCollections.texts,
    name: 'ix_texts_locale_status',
    keys: { localeCode: 1, status: 1 },
    unique: false,
  },
  {
    collection: contentCollections.assets,
    name: 'ux_assets_slug',
    keys: { slug: 1 },
    unique: true,
  },
  {
    collection: contentCollections.collections,
    name: 'ux_collections_slug',
    keys: { slug: 1 },
    unique: true,
  },
  {
    collection: contentCollections.items,
    name: 'ux_items_col_locale_slug',
    keys: { collectionSlug: 1, localeCode: 1, slug: 1 },
    unique: true,
  },
  {
    collection: contentCollections.items,
    name: 'ix_items_col_locale_status_sort',
    keys: { collectionSlug: 1, localeCode: 1, status: 1, sortOrder: 1 },
    unique: false,
  },
];

/**
 * Crea colecciones, validadores e índices de forma idempotente.
 * Se ejecuta desde la migración y los scripts operativos, no en el arranque
 * del servidor (la API de lectura no necesita permisos de DDL).
 */
export async function ensureContentSetup(db: Db): Promise<void> {
  const existing = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
  );

  for (const [name, validator] of Object.entries(validators)) {
    if (existing.has(name)) {
      await db.command({ collMod: name, validator, validationLevel: 'moderate' });
    } else {
      await db.createCollection(name, { validator, validationLevel: 'moderate' });
    }
  }
  if (!existing.has(contentCollections.meta)) {
    await db.createCollection(contentCollections.meta);
  }

  for (const spec of indexes) {
    await db
      .collection(spec.collection)
      .createIndex(spec.keys, { name: spec.name, unique: spec.unique });
  }
}
