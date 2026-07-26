import { describe, expect, it } from 'vitest';
import {
  canonicalUrlOf,
  validateBoardingPoint,
  validateDestination,
  validateService,
} from '../../src/modules/editorial/editorial.validate.js';
import type { ValidationContext } from '../../src/modules/editorial/editorial.validate.js';
import type { EditorialGraph } from '../../src/modules/editorial/editorial.repo.js';
import type {
  AmenityDoc,
  BoardingPointDoc,
  DestinationDoc,
  EditorialBlock,
  LocalityDoc,
  ServiceDoc,
} from '../../src/modules/editorial/editorial.types.js';

const LOCALE = 'es-PE';

const envelope = {
  status: 'published' as const,
  revision: 1,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

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

const heroBlock = block({
  type: 'destination-hero',
  config: { imageAssetSlug: null, overlay: true },
  content: { [LOCALE]: { kicker: null, title: 'Chiclayo', subtitle: null } },
});

const overviewBlock = block({
  type: 'destination-overview',
  order: 20,
  content: { [LOCALE]: { summary: 'Resumen de la ciudad.', highlights: [] } },
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
    redirectsFrom: [],
    editorialNotes: [],
    seo: { [LOCALE]: { title: 'Chiclayo', description: 'Descripción.', ogImageSlug: null } },
    blocks: [heroBlock, overviewBlock],
    ...overrides,
  };
}

function context(graph: Partial<EditorialGraph> = {}, assets: string[] = []): ValidationContext {
  return {
    graph: {
      localities: [locality],
      destinations: [],
      boardingPoints: [],
      services: [],
      amenities: [],
      ...graph,
    },
    defaultLocale: LOCALE,
    assetSlugs: new Set(assets),
    publishedAssetSlugs: new Set(assets),
  };
}

const codes = (issues: { code: string }[]): string[] => issues.map((i) => i.code);

describe('URL canónica (decisión P-09)', () => {
  it('un full con padre usa URL plana', () => {
    expect(
      canonicalUrlOf({ slug: 'moyobamba', pageType: 'full', parentId: 'tarapoto' }, 'tarapoto'),
    ).toBe('/destinos/moyobamba');
  });

  it('un short con padre usa URL jerárquica', () => {
    expect(
      canonicalUrlOf({ slug: 'naranjos', pageType: 'short', parentId: 'tarapoto' }, 'tarapoto'),
    ).toBe('/destinos/tarapoto/naranjos');
  });

  it('un short sin padre usa URL plana', () => {
    expect(canonicalUrlOf({ slug: 'suelto', pageType: 'short', parentId: null }, null)).toBe(
      '/destinos/suelto',
    );
  });
});

describe('validación de destino', () => {
  it('un destino mínimo con hero y overview es publicable', () => {
    const result = validateDestination(destination(), context());
    expect(result.errors).toEqual([]);
    expect(result.publishable).toBe(true);
    expect(result.canonicalUrl).toBe('/destinos/chiclayo');
  });

  it('un tipo de bloque desconocido impide publicar', () => {
    const doc = destination({
      blocks: [heroBlock, overviewBlock, block({ type: 'video', order: 30 })],
    });
    expect(codes(validateDestination(doc, context()).errors)).toContain('block-type-unknown');
  });

  it('un bloque no permitido en short impide publicar', () => {
    const doc = destination({
      pageType: 'short',
      blocks: [
        heroBlock,
        overviewBlock,
        block({
          type: 'destination-rich-text',
          order: 30,
          content: { [LOCALE]: { title: null, bodyHtml: '<p>Texto</p>' } },
        }),
      ],
    });
    expect(codes(validateDestination(doc, context()).errors)).toContain('block-page-type');
  });

  it('falta un bloque obligatorio si el hero está deshabilitado', () => {
    const doc = destination({ blocks: [{ ...heroBlock, enabled: false }, overviewBlock] });
    expect(codes(validateDestination(doc, context()).errors)).toContain('block-required-missing');
  });

  it('transport-services sin alert impide publicar (D-G)', () => {
    const doc = destination({
      blocks: [
        heroBlock,
        overviewBlock,
        block({
          type: 'transport-services',
          order: 30,
          config: { serviceIds: [] },
          content: { [LOCALE]: { title: null, note: null } },
        }),
      ],
    });
    expect(codes(validateDestination(doc, context()).errors)).toContain(
      'block-conditional-missing',
    );
  });

  it('transport-services con alert sí publica', () => {
    const doc = destination({
      blocks: [
        heroBlock,
        overviewBlock,
        block({
          type: 'transport-services',
          order: 30,
          config: { serviceIds: [] },
          content: { [LOCALE]: { title: null, note: null } },
        }),
        block({
          type: 'alert',
          order: 40,
          config: { style: 'info' },
          content: { [LOCALE]: { title: null, body: 'Los servicios pueden variar.' } },
        }),
      ],
    });
    expect(validateDestination(doc, context()).errors).toEqual([]);
  });

  it('config.items y content.items desalineados impiden publicar', () => {
    const doc = destination({
      blocks: [
        heroBlock,
        overviewBlock,
        block({
          type: 'destination-gallery',
          order: 30,
          config: { items: [{ assetSlug: 'foto-1', credit: null, rights: 'own' }] },
          content: { [LOCALE]: { title: null, items: [] } },
        }),
      ],
    });
    expect(codes(validateDestination(doc, context({}, ['foto-1'])).errors)).toContain(
      'block-items-unpaired',
    );
  });

  it('un bloque sin contenido en el locale por defecto impide publicar', () => {
    const doc = destination({
      blocks: [{ ...heroBlock, content: { en: { kicker: null, title: 'X', subtitle: null } } }, overviewBlock],
    });
    const errors = codes(validateDestination(doc, context()).errors);
    expect(errors).toContain('block-default-locale-missing');
  });

  it('una referencia inexistente es error y una no publicada es aviso', () => {
    const service: ServiceDoc = {
      ...envelope,
      status: 'review',
      id: 'bus-cama',
      name: 'Bus Cama',
      slug: 'bus-cama',
      order: 10,
      amenityIds: [],
      excludedAmenityIds: [],
      deckConfigurations: [
        { deck: 1, leftSeatCount: 2, rightSeatCount: 1, hasIndividualSeat: true, reclineDegrees: 160 },
      ],
      heroAssetSlug: null,
      gallery: [],
      content: { [LOCALE]: { shortDescription: 'x', description: 'y' } },
    };
    const doc = destination({
      blocks: [
        heroBlock,
        overviewBlock,
        block({
          type: 'transport-services',
          order: 30,
          config: { serviceIds: ['bus-cama', 'bus-fantasma'] },
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
    const result = validateDestination(doc, context({ services: [service] }));
    expect(codes(result.errors)).toContain('ref-service-missing');
    expect(codes(result.warnings)).toContain('ref-service-unpublished');
  });

  it('una galería sin alt es error y con derechos sin verificar es aviso', () => {
    const doc = destination({
      blocks: [
        heroBlock,
        overviewBlock,
        block({
          type: 'destination-gallery',
          order: 30,
          config: { items: [{ assetSlug: 'foto-1', credit: null, rights: 'unverified' }] },
          content: { [LOCALE]: { title: null, items: [{ alt: '   ', caption: null }] } },
        }),
      ],
    });
    const result = validateDestination(doc, context({}, ['foto-1']));
    expect(codes(result.errors)).toContain('media-alt-missing');
    expect(codes(result.warnings)).toContain('media-rights-unverified');
  });

  it('una localidad sin publicar impide publicar el destino', () => {
    const draftLocality: LocalityDoc = { ...locality, status: 'review' };
    const result = validateDestination(destination(), context({ localities: [draftLocality] }));
    expect(codes(result.errors)).toContain('locality-unpublished');
    expect(result.publishable).toBe(false);
  });

  it('un padre sin publicar impide publicar el hijo', () => {
    const padre = destination({ id: 'tarapoto', slug: 'tarapoto', status: 'review' });
    const hijo = destination({
      id: 'naranjos',
      slug: 'naranjos',
      pageType: 'short',
      parentId: 'tarapoto',
    });
    const result = validateDestination(
      hijo,
      context({ destinations: [padre, hijo], localities: [locality] }),
    );
    expect(codes(result.errors)).toContain('parent-unpublished');
    expect(result.publishable).toBe(false);
  });

  it('la profundidad editorial 3 impide publicar (invariante doc 02)', () => {
    const abuelo = destination({ id: 'tarapoto', slug: 'tarapoto' });
    const padre = destination({ id: 'moyobamba', slug: 'moyobamba', parentId: 'tarapoto' });
    const hijo = destination({
      id: 'nieto',
      slug: 'nieto',
      pageType: 'short',
      parentId: 'moyobamba',
    });
    const result = validateDestination(hijo, context({ destinations: [abuelo, padre, hijo] }));
    expect(codes(result.errors)).toContain('depth-exceeded');
  });

  it('un slug repetido impide publicar', () => {
    const otro = destination({ id: 'otro', slug: 'chiclayo' });
    const result = validateDestination(destination(), context({ destinations: [otro] }));
    expect(codes(result.errors)).toContain('slug-duplicated');
  });

  it('un indexable sin descripción SEO impide publicar', () => {
    const doc = destination({
      seo: { [LOCALE]: { title: 'Chiclayo', description: '', ogImageSlug: null } },
    });
    expect(codes(validateDestination(doc, context()).errors)).toContain('seo-description-empty');
  });

  it('un no indexable sin descripción SEO sí publica', () => {
    const doc = destination({
      indexable: false,
      seo: { [LOCALE]: { title: 'Chiclayo', description: '', ogImageSlug: null } },
    });
    expect(validateDestination(doc, context()).errors).toEqual([]);
  });
});

describe('validación de servicios y puntos de embarque', () => {
  const amenity = (id: string): AmenityDoc => ({
    ...envelope,
    id,
    slug: id,
    order: 10,
    iconAssetSlug: null,
    content: { [LOCALE]: { name: id, description: null } },
  });

  const service = (overrides: Partial<ServiceDoc> = {}): ServiceDoc => ({
    ...envelope,
    id: 'bus-cama-vip',
    name: 'Bus Cama VIP',
    slug: 'bus-cama-vip',
    order: 30,
    amenityIds: ['cortinas'],
    excludedAmenityIds: ['wifi'],
    deckConfigurations: [
      { deck: 1, leftSeatCount: 2, rightSeatCount: 1, hasIndividualSeat: true, reclineDegrees: 170 },
      { deck: 2, leftSeatCount: 2, rightSeatCount: 1, hasIndividualSeat: true, reclineDegrees: 170 },
    ],
    heroAssetSlug: null,
    gallery: [],
    content: { [LOCALE]: { shortDescription: 'corto', description: 'largo' } },
    ...overrides,
  });

  it('un servicio con comodidades registradas es publicable', () => {
    const ctx = context({ amenities: [amenity('cortinas'), amenity('wifi')] });
    expect(validateService(service(), ctx).errors).toEqual([]);
  });

  it('una comodidad incluida y excluida a la vez es contradicción', () => {
    const ctx = context({ amenities: [amenity('wifi')] });
    const result = validateService(
      service({ amenityIds: ['wifi'], excludedAmenityIds: ['wifi'] }),
      ctx,
    );
    expect(codes(result.errors)).toContain('amenity-contradiction');
  });

  it('pisos repetidos son error', () => {
    const ctx = context({ amenities: [amenity('cortinas'), amenity('wifi')] });
    const result = validateService(
      service({
        deckConfigurations: [
          { deck: 1, leftSeatCount: 2, rightSeatCount: 1, hasIndividualSeat: true, reclineDegrees: 170 },
          { deck: 1, leftSeatCount: 2, rightSeatCount: 1, hasIndividualSeat: true, reclineDegrees: 170 },
        ],
      }),
      ctx,
    );
    expect(codes(result.errors)).toContain('deck-duplicated');
  });

  it('un punto de embarque sin localidad o sin dirección verificada no se publica', () => {
    const point: BoardingPointDoc = {
      ...envelope,
      id: 'terminal-nor-oriente',
      name: 'Terminal Nor Oriente',
      slug: 'terminal-nor-oriente',
      localityId: null,
      isDestination: false,
      capabilities: ['boarding'],
      address: null,
      addressVerified: false,
      notes: [],
    };
    expect(codes(validateBoardingPoint(point))).toEqual([
      'boarding-point-locality-missing',
      'boarding-point-address-unverified',
    ]);
  });

  it('un punto con localidad y dirección verificada sí se publica', () => {
    expect(
      validateBoardingPoint({
        id: 'plaza-norte',
        localityId: 'lima',
        addressVerified: true,
        isDestination: false,
      }),
    ).toEqual([]);
  });
});
