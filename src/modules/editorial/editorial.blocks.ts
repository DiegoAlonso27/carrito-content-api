import { Type } from '@sinclair/typebox';
import type { TObject, TSchema } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import type { TypeCheck } from '@sinclair/typebox/compiler';
import type { PageType } from './editorial.types.js';

/**
 * Catálogo de bloques v1 (doc 05). `video`, `banner` y `accordion` quedan
 * fuera a propósito: no deben bloquear el primer corte.
 *
 * Cada tipo declara dos esquemas:
 * - `config`: neutro al idioma (referencias a medios y a otros documentos);
 * - `content`: texto por locale.
 *
 * Cuando un bloque tiene lista (galería, atracciones, servicios urbanos), la
 * parte visual vive en `config.items` y el texto en `content[locale].items`,
 * emparejados por índice: la validación exige la misma longitud. Así una
 * traducción no puede reasignar imágenes por accidente.
 */

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const optionalText = (maxLength: number) => nullable(Type.String({ maxLength }));
const assetSlug = Type.String({ minLength: 1, maxLength: 120 });
const refId = Type.String({ minLength: 1, maxLength: 120 });

export const blockTypes = [
  'destination-hero',
  'destination-overview',
  'destination-location',
  'destination-rich-text',
  'destination-gallery',
  'destination-attractions',
  'destination-practical-info',
  'destination-tips',
  'city-services',
  'transport-services',
  'boarding-points',
  'destination-faq',
  'related-destinations',
  'alert',
  'cta',
] as const;

export type BlockType = (typeof blockTypes)[number];

/**
 * Derechos de un medio. `unverified` es el estado por defecto de todo medio
 * heredado: existe en el CMS pero nadie ha registrado su origen. Un medio
 * `unverified` nunca entra al snapshot publicado (doc 04) — pero tampoco
 * bloquea la publicación del documento que lo contiene: se excluye con aviso.
 */
export const mediaRights = ['own', 'licensed', 'public-domain', 'unverified'] as const;

export type MediaRightsValue = (typeof mediaRights)[number];

export function isPublishableMedia(rights: string): boolean {
  return rights !== 'unverified';
}

export interface BlockTypeSpec {
  /** Esquema de la configuración neutra al idioma. */
  config: TObject;
  /** Esquema del contenido de un locale. */
  content: TObject;
  /** `pageType` que admiten este bloque (doc 03). */
  pageTypes: readonly PageType[];
  /** El bloque empareja `config.items` con `content[locale].items` por índice. */
  pairedItems: boolean;
}

const emptyConfig = Type.Object({}, { additionalProperties: false });

/** Ítem visual de una galería: derechos obligatorios (doc 04). */
const galleryConfigItem = Type.Object(
  {
    assetSlug,
    credit: optionalText(200),
    rights: Type.Union(mediaRights.map((r) => Type.Literal(r))),
  },
  { additionalProperties: false },
);

const galleryContentItem = Type.Object(
  { alt: text(300), caption: optionalText(300) },
  { additionalProperties: false },
);

export const blockCatalog: Record<BlockType, BlockTypeSpec> = {
  'destination-hero': {
    pageTypes: ['full', 'short'],
    pairedItems: false,
    config: Type.Object(
      { imageAssetSlug: nullable(assetSlug), overlay: Type.Boolean() },
      { additionalProperties: false },
    ),
    content: Type.Object(
      { kicker: optionalText(120), title: text(160), subtitle: optionalText(300) },
      { additionalProperties: false },
    ),
  },
  'destination-overview': {
    pageTypes: ['full', 'short'],
    pairedItems: false,
    config: emptyConfig,
    content: Type.Object(
      {
        summary: text(1200),
        highlights: Type.Array(
          Type.Object(
            { label: text(60), value: text(60) },
            { additionalProperties: false },
          ),
          { maxItems: 8 },
        ),
      },
      { additionalProperties: false },
    ),
  },
  'destination-location': {
    pageTypes: ['full', 'short'],
    pairedItems: false,
    // La geografía vive en Locality: el bloque no la duplica, solo decide
    // cómo se muestra y añade una nota editorial opcional.
    config: Type.Object(
      { showMap: Type.Boolean(), mapUrl: optionalText(500) },
      { additionalProperties: false },
    ),
    content: Type.Object({ note: optionalText(600) }, { additionalProperties: false }),
  },
  'destination-rich-text': {
    pageTypes: ['full'],
    pairedItems: false,
    config: emptyConfig,
    content: Type.Object(
      { title: optionalText(160), bodyHtml: text(20000) },
      { additionalProperties: false },
    ),
  },
  'destination-gallery': {
    pageTypes: ['full', 'short'],
    pairedItems: true,
    config: Type.Object(
      { items: Type.Array(galleryConfigItem, { maxItems: 40 }) },
      { additionalProperties: false },
    ),
    content: Type.Object(
      { title: optionalText(160), items: Type.Array(galleryContentItem, { maxItems: 40 }) },
      { additionalProperties: false },
    ),
  },
  'destination-attractions': {
    pageTypes: ['full'],
    pairedItems: true,
    config: Type.Object(
      {
        items: Type.Array(
          Type.Object({ assetSlug: nullable(assetSlug) }, { additionalProperties: false }),
          { maxItems: 20 },
        ),
      },
      { additionalProperties: false },
    ),
    content: Type.Object(
      {
        title: optionalText(160),
        items: Type.Array(
          Type.Object(
            {
              name: text(160),
              description: text(1200),
              duration: optionalText(60),
              distance: optionalText(60),
            },
            { additionalProperties: false },
          ),
          { maxItems: 20 },
        ),
      },
      { additionalProperties: false },
    ),
  },
  'destination-practical-info': {
    pageTypes: ['full'],
    pairedItems: false,
    config: emptyConfig,
    content: Type.Object(
      {
        title: optionalText(160),
        items: Type.Array(
          Type.Object(
            { label: text(80), value: text(160), detail: optionalText(400) },
            { additionalProperties: false },
          ),
          { maxItems: 12 },
        ),
      },
      { additionalProperties: false },
    ),
  },
  'destination-tips': {
    pageTypes: ['full'],
    pairedItems: false,
    config: emptyConfig,
    content: Type.Object(
      {
        title: optionalText(160),
        items: Type.Array(
          Type.Object(
            { icon: text(16), title: text(120), description: text(600) },
            { additionalProperties: false },
          ),
          { maxItems: 12 },
        ),
      },
      { additionalProperties: false },
    ),
  },
  // Servicios de la ciudad. NUNCA lleva comodidades del bus (doc 04).
  'city-services': {
    pageTypes: ['full', 'short'],
    pairedItems: true,
    config: Type.Object(
      {
        items: Type.Array(
          Type.Object({ iconAssetSlug: nullable(assetSlug) }, { additionalProperties: false }),
          { maxItems: 30 },
        ),
      },
      { additionalProperties: false },
    ),
    content: Type.Object(
      {
        title: optionalText(160),
        items: Type.Array(
          Type.Object(
            {
              category: text(60),
              name: text(160),
              description: optionalText(600),
              address: optionalText(300),
              schedule: optionalText(160),
              contact: optionalText(160),
            },
            { additionalProperties: false },
          ),
          { maxItems: 30 },
        ),
      },
      { additionalProperties: false },
    ),
  },
  // Oferta comercial de la empresa: referencias a `editorial_services`.
  'transport-services': {
    pageTypes: ['full', 'short'],
    pairedItems: false,
    config: Type.Object(
      { serviceIds: Type.Array(refId, { maxItems: 12 }) },
      { additionalProperties: false },
    ),
    content: Type.Object(
      { title: optionalText(160), note: optionalText(600) },
      { additionalProperties: false },
    ),
  },
  'boarding-points': {
    pageTypes: ['full', 'short'],
    pairedItems: false,
    config: Type.Object(
      { boardingPointIds: Type.Array(refId, { maxItems: 30 }) },
      { additionalProperties: false },
    ),
    content: Type.Object(
      { title: optionalText(160), note: optionalText(600) },
      { additionalProperties: false },
    ),
  },
  'destination-faq': {
    pageTypes: ['full'],
    pairedItems: false,
    config: emptyConfig,
    content: Type.Object(
      {
        title: optionalText(160),
        items: Type.Array(
          Type.Object(
            { question: text(300), answerHtml: text(4000) },
            { additionalProperties: false },
          ),
          { maxItems: 30 },
        ),
      },
      { additionalProperties: false },
    ),
  },
  'related-destinations': {
    pageTypes: ['full', 'short'],
    pairedItems: false,
    config: Type.Object(
      { destinationIds: Type.Array(refId, { maxItems: 12 }) },
      { additionalProperties: false },
    ),
    content: Type.Object({ title: optionalText(160) }, { additionalProperties: false }),
  },
  alert: {
    pageTypes: ['full', 'short'],
    pairedItems: false,
    config: Type.Object(
      { style: Type.Union([Type.Literal('info'), Type.Literal('warning'), Type.Literal('danger')]) },
      { additionalProperties: false },
    ),
    content: Type.Object(
      { title: optionalText(160), body: text(800) },
      { additionalProperties: false },
    ),
  },
  cta: {
    pageTypes: ['full', 'short'],
    pairedItems: false,
    config: Type.Object({ href: text(500) }, { additionalProperties: false }),
    content: Type.Object(
      { title: optionalText(160), label: text(80), description: optionalText(400) },
      { additionalProperties: false },
    ),
  },
};

export function isBlockType(value: string): value is BlockType {
  return (blockTypes as readonly string[]).includes(value);
}

/** Bloques exigidos en todo destino publicable, sea `full` o `short`. */
export const requiredBlockTypes: readonly BlockType[] = ['destination-hero', 'destination-overview'];

/**
 * Composición condicional: mostrar la oferta comercial obliga a mostrar el
 * aviso de variabilidad (decisión D-G / contexto maestro §3). Sin él, el
 * contenido editorial se lee como disponibilidad garantizada.
 */
export const conditionalBlockRules: readonly { when: BlockType; requires: BlockType }[] = [
  { when: 'transport-services', requires: 'alert' },
];

export const transportServicesAlertText =
  'Los servicios y horarios disponibles pueden variar según la fecha seleccionada.';

const configCheckers = new Map<BlockType, TypeCheck<TObject>>(
  (Object.entries(blockCatalog) as [BlockType, BlockTypeSpec][]).map(([t, spec]) => [
    t,
    TypeCompiler.Compile(spec.config),
  ]),
);
const contentCheckers = new Map<BlockType, TypeCheck<TObject>>(
  (Object.entries(blockCatalog) as [BlockType, BlockTypeSpec][]).map(([t, spec]) => [
    t,
    TypeCompiler.Compile(spec.content),
  ]),
);

export function checkBlockConfig(type: BlockType, config: unknown): string[] {
  const checker = configCheckers.get(type);
  if (checker === undefined) return [`tipo de bloque desconocido '${type}'`];
  return [...checker.Errors(config)].map((e) => `config${e.path}: ${e.message}`);
}

export function checkBlockContent(type: BlockType, locale: string, content: unknown): string[] {
  const checker = contentCheckers.get(type);
  if (checker === undefined) return [`tipo de bloque desconocido '${type}'`];
  return [...checker.Errors(content)].map((e) => `content.${locale}${e.path}: ${e.message}`);
}

// ── Referencias ─────────────────────────────────────────────────────────────

export interface BlockRefs {
  assets: string[];
  services: string[];
  boardingPoints: string[];
  destinations: string[];
}

const assetKeys = new Set(['assetSlug', 'imageAssetSlug', 'iconAssetSlug']);

/**
 * Extrae las referencias de `config` por convención de nombre de campo. La
 * convención es parte del contrato de bloque: un tipo nuevo que referencie
 * documentos debe usar `serviceIds` / `boardingPointIds` / `destinationIds`
 * o `*AssetSlug`, o su referencia no se validará.
 */
export function blockRefs(config: unknown): BlockRefs {
  const refs: BlockRefs = { assets: [], services: [], boardingPoints: [], destinations: [] };
  const pushIds = (target: string[], value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const entry of value) if (typeof entry === 'string' && entry.length > 0) target.push(entry);
  };

  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (assetKeys.has(key)) {
        if (typeof value === 'string' && value.length > 0) refs.assets.push(value);
        continue;
      }
      if (key === 'serviceIds') {
        pushIds(refs.services, value);
        continue;
      }
      if (key === 'boardingPointIds') {
        pushIds(refs.boardingPoints, value);
        continue;
      }
      if (key === 'destinationIds') {
        pushIds(refs.destinations, value);
        continue;
      }
      walk(value);
    }
  };

  walk(config);
  return refs;
}

/** Campos de contenido que llevan HTML: cualquier clave que termine en `Html`. */
export function isHtmlField(key: string): boolean {
  return key.endsWith('Html');
}
