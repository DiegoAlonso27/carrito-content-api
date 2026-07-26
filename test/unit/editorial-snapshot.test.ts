import { describe, expect, it } from 'vitest';
import {
  buildSnapshotBody,
  canonicalJson,
  checksumOf,
  sha256Hex,
  verifySnapshotIntegrity,
} from '../../src/modules/editorial/editorial-snapshot.js';
import type { EditorialSnapshotBody } from '../../src/modules/editorial/editorial-snapshot.js';
import type { ValidationContext } from '../../src/modules/editorial/editorial.validate.js';
import type { EditorialGraph } from '../../src/modules/editorial/editorial.repo.js';
import type { AssetDoc } from '../../src/modules/content/content.types.js';
import type {
  AmenityDoc,
  BoardingPointDoc,
  DestinationDoc,
  EditorialBlock,
  LocalityDoc,
  ServiceDoc,
} from '../../src/modules/editorial/editorial.types.js';

const LOCALE = 'es-PE';
const now = new Date('2026-07-26T00:00:00.000Z');
const envelope = { status: 'published' as const, revision: 1, createdAt: now, updatedAt: now };

const buildOpts = {
  locale: LOCALE,
  version: 'v1',
  generatedAtUtc: '2026-07-26T00:00:00.000Z',
};

function asset(slug: string, overrides: Partial<AssetDoc> = {}): AssetDoc {
  return {
    slug,
    path: `/cms/img/${slug}.png`,
    altText: null,
    mimeType: 'image/png',
    width: 100,
    height: 100,
    isActive: true,
    sortOrder: 10,
    ...envelope,
    ...overrides,
  };
}

function block(overrides: Partial<EditorialBlock> & Pick<EditorialBlock, 'type'>): EditorialBlock {
  return {
    id: `${overrides.type}-1`,
    order: 10,
    status: 'published',
    enabled: true,
    responsive: { desktop: true, tablet: true, mobile: true },
    config: {},
    content: {},
    ...overrides,
  };
}

const hero = block({
  type: 'destination-hero',
  order: 10,
  config: { imageAssetSlug: 'hero-img', overlay: true },
  content: { [LOCALE]: { kicker: null, title: 'Chiclayo', subtitle: null } },
});

const overview = block({
  type: 'destination-overview',
  order: 20,
  content: { [LOCALE]: { summary: 'Resumen.', highlights: [] } },
});

const locality: LocalityDoc = {
  ...envelope,
  id: 'chiclayo',
  name: 'Chiclayo',
  slug: 'chiclayo',
  localityType: 'city',
  department: 'Lambayeque',
  province: 'Chiclayo',
  district: 'Chiclayo',
};

function destination(overrides: Partial<DestinationDoc> = {}): DestinationDoc {
  return {
    ...envelope,
    id: 'chiclayo',
    name: 'Chiclayo',
    officialName: null,
    slug: 'chiclayo',
    localityId: 'chiclayo',
    pageType: 'full',
    parentId: null,
    showInMainGrid: true,
    order: 10,
    indexable: true,
    serviceIds: [],
    redirectsFrom: ['/destino/chiclayo'],
    editorialNotes: [],
    seo: { [LOCALE]: { title: 'Chiclayo', description: 'Desc.', ogImageSlug: null } },
    blocks: [hero, overview],
    ...overrides,
  };
}

function context(graph: Partial<EditorialGraph> = {}, assets: string[] = ['hero-img']): {
  ctx: ValidationContext;
  assets: AssetDoc[];
} {
  const assetDocs = assets.map((s) => asset(s));
  return {
    ctx: {
      graph: {
        localities: [locality],
        destinations: [destination()],
        boardingPoints: [],
        services: [],
        amenities: [],
        ...graph,
      },
      defaultLocale: LOCALE,
      assetSlugs: new Set(assets),
      publishedAssetSlugs: new Set(assets),
    },
    assets: assetDocs,
  };
}

describe('canonicalJson y hashing', () => {
  it('ordena claves: el mismo contenido produce el mismo hash', () => {
    const a = { b: 1, a: { d: [1, 2], c: 'x' } };
    const b = { a: { c: 'x', d: [1, 2] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(sha256Hex(canonicalJson(a))).toBe(sha256Hex(canonicalJson(b)));
  });

  it('respeta el orden de los arrays (no los ordena)', () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it('el hash es SHA-256 hexadecimal', () => {
    expect(sha256Hex('x')).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('construcción del snapshot', () => {
  it('produce manifest y checksum verificables', () => {
    const { ctx, assets } = context();
    const { body, errors } = buildSnapshotBody(ctx, assets, buildOpts);
    expect(errors).toEqual([]);
    expect(body).not.toBeNull();

    const snapshot = body as EditorialSnapshotBody;
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.manifest).toHaveLength(2); // 1 localidad + 1 destino
    expect(snapshot.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(verifySnapshotIntegrity(snapshot)).toEqual([]);
  });

  it('es determinista: dos construcciones iguales dan el mismo checksum', () => {
    const first = buildSnapshotBody(context().ctx, context().assets, buildOpts);
    const second = buildSnapshotBody(context().ctx, context().assets, buildOpts);
    expect(first.body?.checksum).toBe(second.body?.checksum);
  });

  it('registra la redirección de la URL legada hacia la canónica', () => {
    const { ctx, assets } = context();
    const { body } = buildSnapshotBody(ctx, assets, buildOpts);
    expect(body?.redirects).toEqual([{ from: '/destino/chiclayo', to: '/destinos/chiclayo' }]);
  });

  it('solo exporta documentos publicados', () => {
    const draft = destination({ id: 'oculto', slug: 'oculto', status: 'draft' });
    const { ctx, assets } = context({ destinations: [destination(), draft] });
    const { body } = buildSnapshotBody(ctx, assets, buildOpts);
    expect(body?.destinations.map((d) => d['id'])).toEqual(['chiclayo']);
  });

  it('rechaza la publicación si hay identidad duplicada', () => {
    const clone = { ...destination(), id: 'otro' };
    const { ctx, assets } = context({ destinations: [destination(), clone] });
    const { body, errors } = buildSnapshotBody(ctx, assets, buildOpts);
    expect(body).toBeNull();
    expect(errors.some((e) => e.includes('identidad duplicada'))).toBe(true);
  });

  it('rechaza la publicación si un destino publicado dejó de ser válido', () => {
    const roto = destination({ blocks: [hero] }); // sin overview obligatorio
    const { ctx, assets } = context({ destinations: [roto] });
    const { body, errors } = buildSnapshotBody(ctx, assets, buildOpts);
    expect(body).toBeNull();
    expect(errors.some((e) => e.includes('block-required-missing'))).toBe(true);
  });

  it('rechaza si un servicio publicado referencia una comodidad no publicada', () => {
    const service: ServiceDoc = {
      ...envelope,
      id: 'bus-cama',
      name: 'Bus Cama',
      slug: 'bus-cama',
      order: 10,
      amenityIds: ['usb'],
      excludedAmenityIds: [],
      deckConfigurations: [
        { deck: 1, leftSeatCount: 2, rightSeatCount: 1, hasIndividualSeat: true, reclineDegrees: 160 },
      ],
      heroAssetSlug: null,
      gallery: [],
      content: { [LOCALE]: { shortDescription: 'corto', description: 'largo' } },
    };
    const usbDraft: AmenityDoc = {
      ...envelope,
      status: 'review',
      id: 'usb',
      slug: 'usb',
      order: 10,
      iconAssetSlug: null,
      content: { [LOCALE]: { name: 'USB', description: null } },
    };
    const { ctx, assets } = context({ services: [service], amenities: [usbDraft] });
    const { body, errors } = buildSnapshotBody(ctx, assets, buildOpts);
    expect(body).toBeNull();
    expect(errors.some((e) => e.includes("comodidad 'usb'"))).toBe(true);
  });
});

describe('proyección de bloques', () => {
  it('excluye bloques deshabilitados, en draft o archivados', () => {
    const doc = destination({
      blocks: [
        hero,
        overview,
        block({
          type: 'cta',
          order: 30,
          enabled: false,
          config: { href: '/x' },
          content: { [LOCALE]: { title: null, label: 'Ir', description: null } },
        }),
        block({
          type: 'cta',
          id: 'cta-draft',
          order: 40,
          status: 'draft',
          config: { href: '/y' },
          content: { [LOCALE]: { title: null, label: 'Ir', description: null } },
        }),
      ],
    });
    const { ctx, assets } = context({ destinations: [doc] });
    const { body } = buildSnapshotBody(ctx, assets, buildOpts);
    const blocks = (body?.destinations[0] as { blocks: { type: string }[] }).blocks;
    expect(blocks.map((b) => b.type)).toEqual(['destination-hero', 'destination-overview']);
  });

  it('descarta de la galería los medios sin derechos y su gemelo de texto', () => {
    const gallery = block({
      type: 'destination-gallery',
      order: 30,
      config: {
        items: [
          { assetSlug: 'hero-img', credit: null, rights: 'own' },
          { assetSlug: 'hero-img', credit: null, rights: 'unverified' },
        ],
      },
      content: {
        [LOCALE]: {
          title: 'Galería',
          items: [
            { alt: 'con derechos', caption: null },
            { alt: 'sin derechos', caption: null },
          ],
        },
      },
    });
    const doc = destination({ blocks: [hero, overview, gallery] });
    const { ctx, assets } = context({ destinations: [doc] });
    const { body } = buildSnapshotBody(ctx, assets, buildOpts);
    const blocks = (
      body?.destinations[0] as {
        blocks: { type: string; config: { items: unknown[] }; content: { items: { alt: string }[] } }[];
      }
    ).blocks;
    const exported = blocks.find((b) => b.type === 'destination-gallery');
    expect(exported?.config.items).toHaveLength(1);
    expect(exported?.content.items).toHaveLength(1);
    expect(exported?.content.items[0]?.alt).toBe('con derechos');
  });

  it('mantiene la galería aunque quede vacía (el front tiene estado vacío)', () => {
    const gallery = block({
      type: 'destination-gallery',
      order: 30,
      config: { items: [{ assetSlug: 'hero-img', credit: null, rights: 'unverified' }] },
      content: { [LOCALE]: { title: 'Galería', items: [{ alt: 'x', caption: null }] } },
    });
    const doc = destination({ blocks: [hero, overview, gallery] });
    const { ctx, assets } = context({ destinations: [doc] });
    const { body } = buildSnapshotBody(ctx, assets, buildOpts);
    const blocks = (body?.destinations[0] as { blocks: { type: string; config: { items: unknown[] } }[] })
      .blocks;
    const exported = blocks.find((b) => b.type === 'destination-gallery');
    expect(exported).toBeDefined();
    expect(exported?.config.items).toEqual([]);
  });

  it('omite un bloque de referencias que queda sin referencias publicadas', () => {
    const doc = destination({
      blocks: [
        hero,
        overview,
        block({
          type: 'transport-services',
          order: 30,
          config: { serviceIds: ['bus-fantasma'] },
          content: { [LOCALE]: { title: null, note: null } },
        }),
        block({
          type: 'alert',
          order: 40,
          config: { style: 'info' },
          content: { [LOCALE]: { title: null, body: 'Aviso.' } },
        }),
      ],
    });
    const { ctx, assets } = context({ destinations: [doc] });
    // La referencia rota se detecta en validación: el snapshot no sale.
    const { errors } = buildSnapshotBody(ctx, assets, buildOpts);
    expect(errors.some((e) => e.includes('ref-service-missing'))).toBe(true);
  });

  it('anula la imagen de un bloque cuando el asset no está publicado', () => {
    const { ctx, assets } = context({}, []);
    const withUnpublishedAsset = {
      ...ctx,
      assetSlugs: new Set(['hero-img']),
      publishedAssetSlugs: new Set<string>(),
    };
    const { body, errors } = buildSnapshotBody(withUnpublishedAsset, assets, buildOpts);
    expect(errors).toEqual([]);
    const blocks = (
      body?.destinations[0] as { blocks: { type: string; config: { imageAssetSlug: unknown } }[] }
    ).blocks;
    expect(blocks[0]?.config.imageAssetSlug).toBeNull();
  });

  it('marca isFallback cuando el bloque no tiene el locale pedido', () => {
    const { ctx, assets } = context();
    const { body } = buildSnapshotBody(ctx, assets, { ...buildOpts, locale: 'en' });
    const blocks = (body?.destinations[0] as { blocks: { isFallback: boolean }[] }).blocks;
    expect(blocks.every((b) => b.isFallback)).toBe(true);
    expect(body?.locale).toBe('en');
    expect(body?.defaultLocale).toBe(LOCALE);
  });
});

describe('verificación de integridad', () => {
  function validBody(): EditorialSnapshotBody {
    const { ctx, assets } = context();
    return buildSnapshotBody(ctx, assets, buildOpts).body as EditorialSnapshotBody;
  }

  it('detecta un documento manipulado (hash inconsistente)', () => {
    const body = validBody();
    (body.destinations[0] as Record<string, unknown>)['name'] = 'Otro nombre';
    const problems = verifySnapshotIntegrity(body);
    expect(problems.some((p) => p.startsWith('hash inconsistente'))).toBe(true);
  });

  it('detecta un checksum global alterado', () => {
    const body = validBody();
    body.checksum = sha256Hex('otra cosa');
    expect(verifySnapshotIntegrity(body)).toContain('checksum global inconsistente');
  });

  it('detecta una referencia del manifest que no existe en el snapshot', () => {
    const body = validBody();
    const entry = body.manifest.find((m) => m.type === 'destination');
    entry?.refs.push('servicio-fantasma');
    body.checksum = checksumOf(body);
    const problems = verifySnapshotIntegrity(body);
    expect(problems.some((p) => p.startsWith('referencia faltante'))).toBe(true);
  });

  it('detecta un manifest incompleto', () => {
    const body = validBody();
    body.manifest.pop();
    body.checksum = checksumOf(body);
    const problems = verifySnapshotIntegrity(body);
    expect(problems.some((p) => p.startsWith('manifest incompleto'))).toBe(true);
  });

  it('rechaza una versión de schema desconocida', () => {
    const body = validBody();
    (body as unknown as { schemaVersion: number }).schemaVersion = 99;
    expect(verifySnapshotIntegrity(body)[0]).toContain('schema incompatible');
  });
});

describe('puntos de embarque en el snapshot', () => {
  it('exporta solo los publicados y nunca como destino', () => {
    const point: BoardingPointDoc = {
      ...envelope,
      id: 'plaza-norte',
      name: 'Terminal Plaza Norte',
      slug: 'plaza-norte',
      localityId: 'chiclayo',
      isDestination: false,
      capabilities: ['boarding'],
      address: 'Dirección verificada',
      addressVerified: true,
      notes: [],
    };
    const oculto: BoardingPointDoc = { ...point, id: 'oculto', slug: 'oculto', status: 'draft' };
    const { ctx, assets } = context({ boardingPoints: [point, oculto] });
    const { body } = buildSnapshotBody(ctx, assets, buildOpts);
    expect(body?.boardingPoints.map((p) => p['id'])).toEqual(['plaza-norte']);
    expect(body?.boardingPoints.every((p) => p['isDestination'] === false)).toBe(true);
    expect(body?.destinations.map((d) => d['id'])).not.toContain('plaza-norte');
  });
});
