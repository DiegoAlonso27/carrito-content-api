import { Type } from '@sinclair/typebox';
import type { TObject, TSchema } from '@sinclair/typebox';
import { editorialDocStatuses } from './editorial.types.js';
import { mediaRights } from './editorial.blocks.js';

/**
 * Esquemas de entrada del modelo editorial. Como en el módulo flat,
 * `additionalProperties: false` en todo: un campo no declarado es un error de
 * contrato, no un dato a conservar en silencio.
 *
 * El `status` NO viaja en la entrada: lo gobierna el CLI (`--publish`,
 * `content:publish`). Así una edición de contenido no puede publicar por
 * descuido.
 */

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const id = Type.String({ minLength: 1, maxLength: 120, pattern: '^[a-z0-9][a-z0-9-]*$' });
const slug = Type.String({ minLength: 1, maxLength: 120, pattern: '^[a-z0-9][a-z0-9-]*$' });
const localeCode = Type.String({ minLength: 2, maxLength: 10 });
const assetSlug = Type.String({ minLength: 1, maxLength: 120 });

export const blockStatusSchema = Type.Union(editorialDocStatuses.map((s) => Type.Literal(s)));

export const blockSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 64 }),
    type: Type.String({ minLength: 1, maxLength: 60 }),
    order: Type.Integer({ minimum: 0 }),
    status: blockStatusSchema,
    enabled: Type.Boolean(),
    responsive: Type.Object(
      { desktop: Type.Boolean(), tablet: Type.Boolean(), mobile: Type.Boolean() },
      { additionalProperties: false },
    ),
    // La forma fina de config/content la valida el catálogo por `type`.
    config: Type.Record(Type.String(), Type.Unknown()),
    content: Type.Record(localeCode, Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export const localityInputSchema = Type.Object(
  {
    id,
    name: Type.String({ minLength: 1, maxLength: 160 }),
    slug,
    localityType: Type.Union([
      Type.Literal('city'),
      Type.Literal('town'),
      Type.Literal('locality'),
    ]),
    department: Type.String({ minLength: 1, maxLength: 120 }),
    province: Type.String({ minLength: 1, maxLength: 120 }),
    district: nullable(Type.String({ maxLength: 120 })),
  },
  { additionalProperties: false },
);

export const seoEntrySchema = Type.Object(
  {
    title: Type.String({ maxLength: 200 }),
    description: Type.String({ maxLength: 400 }),
    ogImageSlug: nullable(assetSlug),
  },
  { additionalProperties: false },
);

export const destinationInputSchema = Type.Object(
  {
    id,
    name: Type.String({ minLength: 1, maxLength: 160 }),
    officialName: nullable(Type.String({ maxLength: 160 })),
    slug,
    localityId: id,
    pageType: Type.Union([Type.Literal('full'), Type.Literal('short')]),
    parentId: nullable(id),
    showInMainGrid: Type.Boolean(),
    order: Type.Integer({ minimum: 0 }),
    indexable: Type.Boolean(),
    serviceIds: Type.Array(id, { maxItems: 12 }),
    redirectsFrom: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 20 }),
    editorialNotes: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 20 }),
    seo: Type.Record(localeCode, seoEntrySchema),
    blocks: Type.Array(blockSchema, { maxItems: 60 }),
  },
  { additionalProperties: false },
);

export const boardingPointInputSchema = Type.Object(
  {
    id,
    name: Type.String({ minLength: 1, maxLength: 160 }),
    slug,
    localityId: nullable(id),
    // Invariante estructural del doc 02: no es un booleano editable.
    isDestination: Type.Literal(false),
    capabilities: Type.Array(
      Type.Union([
        Type.Literal('boarding'),
        Type.Literal('disembarking'),
        Type.Literal('ticketing'),
      ]),
      { minItems: 1, maxItems: 3 },
    ),
    address: nullable(Type.String({ maxLength: 300 })),
    addressVerified: Type.Boolean(),
    notes: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 20 }),
  },
  { additionalProperties: false },
);

export const deckConfigurationSchema = Type.Object(
  {
    deck: Type.Integer({ minimum: 1, maximum: 3 }),
    leftSeatCount: Type.Integer({ minimum: 0, maximum: 4 }),
    rightSeatCount: Type.Integer({ minimum: 0, maximum: 4 }),
    hasIndividualSeat: Type.Boolean(),
    reclineDegrees: Type.Integer({ minimum: 90, maximum: 180 }),
  },
  { additionalProperties: false },
);

export const serviceMediaSchema = Type.Object(
  {
    assetSlug,
    credit: nullable(Type.String({ maxLength: 200 })),
    rights: Type.Union(mediaRights.map((r) => Type.Literal(r))),
    alt: Type.Record(localeCode, Type.String({ minLength: 1, maxLength: 300 })),
  },
  { additionalProperties: false },
);

export const serviceInputSchema = Type.Object(
  {
    id,
    name: Type.String({ minLength: 1, maxLength: 160 }),
    slug,
    order: Type.Integer({ minimum: 0 }),
    amenityIds: Type.Array(id, { maxItems: 30 }),
    excludedAmenityIds: Type.Array(id, { maxItems: 30 }),
    deckConfigurations: Type.Array(deckConfigurationSchema, { minItems: 1, maxItems: 3 }),
    heroAssetSlug: nullable(assetSlug),
    gallery: Type.Array(serviceMediaSchema, { maxItems: 40 }),
    content: Type.Record(
      localeCode,
      Type.Object(
        {
          shortDescription: Type.String({ minLength: 1, maxLength: 400 }),
          description: Type.String({ minLength: 1, maxLength: 4000 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const amenityInputSchema = Type.Object(
  {
    id,
    slug,
    order: Type.Integer({ minimum: 0 }),
    iconAssetSlug: nullable(assetSlug),
    content: Type.Record(
      localeCode,
      Type.Object(
        {
          name: Type.String({ minLength: 1, maxLength: 120 }),
          description: nullable(Type.String({ maxLength: 600 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const editorialInputSchemas = {
  localities: localityInputSchema,
  destinations: destinationInputSchema,
  'boarding-points': boardingPointInputSchema,
  services: serviceInputSchema,
  amenities: amenityInputSchema,
} as const satisfies Record<string, TObject>;

export type EditorialSectionName = keyof typeof editorialInputSchemas;

export const editorialSectionNames = Object.keys(
  editorialInputSchemas,
) as readonly EditorialSectionName[];

export function isEditorialSection(value: string): value is EditorialSectionName {
  return (editorialSectionNames as readonly string[]).includes(value);
}
