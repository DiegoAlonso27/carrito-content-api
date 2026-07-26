import { Type } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';

/**
 * Contrato del catálogo anotado de la Fase 1
 * (`web-tc-docs/plan-editorial-web-tc/catalogo-localidades.anotado.json`).
 *
 * Es entrada externa a la migración: se valida en el borde con TypeBox como
 * cualquier otra. `additionalProperties: true` a propósito — el archivo lleva
 * campos de documentación (`$comment`, `urlPolicy`, `summary`) que no
 * pertenecen al modelo pero tampoco deben invalidarlo.
 */

const nullableString = Type.Union([Type.String(), Type.Null()]);

export const catalogDestinationSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  slug: Type.String({ minLength: 1 }),
  pageType: Type.Union([Type.Literal('full'), Type.Literal('short')]),
  parentSlug: nullableString,
  localityType: Type.Union([
    Type.Literal('city'),
    Type.Literal('town'),
    Type.Literal('locality'),
  ]),
  department: Type.String({ minLength: 1 }),
  province: Type.String({ minLength: 1 }),
  district: nullableString,
  catalogUrl: Type.String({ minLength: 1 }),
  canonicalUrl: Type.String({ minLength: 1 }),
  redirectsFrom: Type.Array(Type.String()),
  disposition: Type.String({ minLength: 1 }),
  initialStatus: Type.String({ minLength: 1 }),
  showInMainGrid: Type.Boolean(),
  order: Type.Integer({ minimum: 0 }),
  blockingValidations: Type.Array(Type.String()),
  advisoryNotes: Type.Array(Type.String()),
});

export const catalogBoardingPointSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  slug: Type.String({ minLength: 1 }),
  localitySlug: nullableString,
  isDestination: Type.Literal(false),
  capabilities: Type.Array(
    Type.Union([
      Type.Literal('boarding'),
      Type.Literal('disembarking'),
      Type.Literal('ticketing'),
    ]),
  ),
  address: Type.Optional(nullableString),
  addressVerified: Type.Boolean(),
  blockingValidations: Type.Array(Type.String()),
});

export const annotatedCatalogSchema = Type.Object({
  destinations: Type.Array(catalogDestinationSchema),
  boardingPoints: Type.Array(catalogBoardingPointSchema),
  derivedBoardingPoints: Type.Array(catalogBoardingPointSchema),
});

export type CatalogDestination = {
  id: string;
  name: string;
  slug: string;
  pageType: 'full' | 'short';
  parentSlug: string | null;
  localityType: 'city' | 'town' | 'locality';
  department: string;
  province: string;
  district: string | null;
  catalogUrl: string;
  canonicalUrl: string;
  redirectsFrom: string[];
  disposition: string;
  initialStatus: string;
  showInMainGrid: boolean;
  order: number;
  blockingValidations: string[];
  advisoryNotes: string[];
};

export type CatalogBoardingPoint = {
  id: string;
  name: string;
  slug: string;
  localitySlug: string | null;
  isDestination: false;
  capabilities: ('boarding' | 'disembarking' | 'ticketing')[];
  address?: string | null;
  addressVerified: boolean;
  blockingValidations: string[];
};

export interface AnnotatedCatalog {
  destinations: CatalogDestination[];
  boardingPoints: CatalogBoardingPoint[];
  derivedBoardingPoints: CatalogBoardingPoint[];
}

const checker = TypeCompiler.Compile(annotatedCatalogSchema);

export function parseAnnotatedCatalog(raw: unknown): {
  catalog: AnnotatedCatalog | null;
  errors: string[];
} {
  const errors = [...checker.Errors(raw)].slice(0, 20).map((e) => `${e.path}: ${e.message}`);
  if (errors.length > 0) return { catalog: null, errors };

  const catalog = raw as AnnotatedCatalog;
  const semantic: string[] = [];

  const slugs = new Set(catalog.destinations.map((d) => d.slug));
  const ids = new Set<string>();
  for (const d of catalog.destinations) {
    if (ids.has(d.id)) semantic.push(`destino duplicado '${d.id}'`);
    ids.add(d.id);
    if (d.parentSlug !== null && !slugs.has(d.parentSlug)) {
      semantic.push(`'${d.id}': parentSlug '${d.parentSlug}' no está en el catálogo`);
    }
  }
  return semantic.length > 0 ? { catalog: null, errors: semantic } : { catalog, errors: [] };
}
