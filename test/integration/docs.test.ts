import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeTestConfig } from '../helpers/test-config.js';

/**
 * Documentación OpenAPI (`/docs`). No necesita MongoDB: los clientes no
 * conectan al construir la app y ninguna de estas rutas toca la base.
 *
 * Cubre las dos mitades del contrato operativo: con las docs habilitadas la UI
 * y el JSON responden, y con las docs apagadas (default fuera de development)
 * no existe ninguna ruta que las exponga.
 */

interface JsonSchemaNode {
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  required?: string[];
}

interface OpenApiOperation {
  tags?: string[];
  operationId?: string;
  summary?: string;
  description?: string;
  security?: Record<string, string[]>[];
  parameters?: { name: string; in: string }[];
  requestBody?: { content: Record<string, unknown> };
  responses: Record<
    string,
    {
      description: string;
      headers?: Record<string, unknown>;
      content?: Record<string, unknown>;
    }
  >;
}

interface OpenApiSpec {
  openapi: string;
  info: { title: string };
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: {
    securitySchemes?: Record<string, { type: string; name: string; in: string }>;
    schemas?: Record<string, unknown>;
  };
  tags?: { name: string }[];
}

/** Extrae el JSON Schema del cuerpo de una respuesta del spec. */
function jsonSchemaOf(response?: {
  content?: Record<string, unknown>;
}): JsonSchemaNode | undefined {
  const media = response?.content?.['application/json'] as { schema?: JsonSchemaNode } | undefined;
  return media?.schema;
}

let app: FastifyInstance;
let spec: OpenApiSpec;

beforeAll(async () => {
  app = buildApp(makeTestConfig({ DOCS_ENABLED: 'true' }));
  await app.ready();
  const res = await app.inject({ method: 'GET', url: '/docs/json' });
  spec = res.json<OpenApiSpec>();
});

afterAll(async () => {
  await app.close();
});

describe('documentación OpenAPI habilitada', () => {
  it('sirve la UI de Swagger en /docs', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('sirve el JSON OpenAPI 3.1 en /docs/json', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    expect(res.json<OpenApiSpec>().openapi).toBe('3.1.0');
  });

  it('sirve también el YAML en /docs/yaml', async () => {
    // Ruta propia de @fastify/swagger-ui: forma parte de la superficie que el
    // flag abre, así que se documenta y se prueba en vez de quedar implícita.
    const res = await app.inject({ method: 'GET', url: '/docs/yaml' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('openapi: 3.1.0');
  });

  it('sirve su propia CSP en la UI, sobrescribiendo la de helmet', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs' });
    // `validator.swagger.io` solo aparece en la CSP de swagger-ui: prueba que su
    // hook onSend ganó sobre la de helmet en estas rutas (y solo en estas).
    expect(String(res.headers['content-security-policy'])).toContain('validator.swagger.io');
  });

  it('deja intacta la CSP de helmet en el resto de la API', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(String(res.headers['content-security-policy'])).not.toContain('validator.swagger.io');
  });

  it('sirve los assets que la UI necesita para arrancar', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/static/swagger-ui-bundle.js' });
    expect(res.statusCode).toBe(200);
  });

  /** Matriz método+ruta: una ruta documentada bajo otro verbo es un fallo. */
  const OPERATIONS: [path: string, method: string, tag: string][] = [
    ['/health/live', 'get', 'health'],
    ['/health/ready', 'get', 'health'],
    ['/v1/locales', 'get', 'content'],
    ['/v1/content/{locale}', 'get', 'content'],
    ['/v1/content/{locale}/collections/{slug}/items', 'get', 'content'],
    ['/v1/export/content-cache', 'get', 'export'],
    ['/v1/contact', 'post', 'contact'],
    ['/v1/complaints', 'post', 'complaints'],
  ];

  it('documenta TODAS las rutas HTTP de la API', () => {
    expect(Object.keys(spec.paths).sort()).toEqual(
      OPERATIONS.map(([path]) => path).sort((a, b) => a.localeCompare(b)),
    );
  });

  it('documenta cada ruta bajo su método exacto y sin verbos extra', () => {
    for (const [path, method] of OPERATIONS) {
      expect(Object.keys(spec.paths[path] ?? {}), path).toEqual([method]);
    }
  });

  it('etiqueta y describe cada operación', () => {
    for (const [path, method, tag] of OPERATIONS) {
      const operation = spec.paths[path]?.[method];
      expect(operation, path).toBeDefined();
      expect(operation?.tags, path).toEqual([tag]);
      expect(operation?.operationId, path).toBeTruthy();
      expect(operation?.summary, path).toBeTruthy();
    }
  });

  it('declara x-request-id como header en cada respuesta documentada', () => {
    for (const [path, method] of OPERATIONS) {
      const responses = spec.paths[path]?.[method]?.responses ?? {};
      for (const [code, response] of Object.entries(responses)) {
        expect(response.headers, `${path} ${code}`).toHaveProperty('x-request-id');
      }
    }
  });

  it('da a cada respuesta una descripción propia, no «Default Response»', () => {
    for (const [path, method] of OPERATIONS) {
      const responses = spec.paths[path]?.[method]?.responses ?? {};
      expect(Object.keys(responses).length, path).toBeGreaterThan(0);
      for (const [code, response] of Object.entries(responses)) {
        expect(response.description, `${path} ${code}`).not.toBe('Default Response');
        expect(response.description, `${path} ${code}`).toBeTruthy();
      }
    }
  });

  it('distingue el 201 de alta nueva del 200 idempotente en contacto', () => {
    const responses = spec.paths['/v1/contact']?.['post']?.responses ?? {};
    expect(responses['201']?.description).toContain('alta nueva');
    expect(responses['200']?.description).toContain('submissionId');
  });

  it('documenta la envolvente de error real en cada respuesta default', () => {
    for (const [path, method] of OPERATIONS) {
      const schema = jsonSchemaOf(spec.paths[path]?.[method]?.responses['default']);
      const error = schema?.properties?.['error'];
      expect(Object.keys(error?.properties ?? {}), path).toEqual([
        'code',
        'message',
        'requestId',
        'details',
      ]);
      expect(error?.required, path).toEqual(['code', 'message', 'requestId']);
    }
  });

  describe('export servidor-a-servidor', () => {
    it('exige el security scheme apiKey X-Export-Key', () => {
      const operation = spec.paths['/v1/export/content-cache']?.['get'];
      expect(operation?.security).toEqual([{ exportKey: [] }]);

      const scheme = spec.components.securitySchemes?.['exportKey'];
      expect(scheme).toMatchObject({ type: 'apiKey', name: 'x-export-key', in: 'header' });
    });

    it('no duplica la credencial como parámetro suelto', () => {
      const parameters = spec.paths['/v1/export/content-cache']?.['get']?.parameters ?? [];
      const names = parameters.map((parameter) => parameter.name);
      expect(names).not.toContain('x-export-key');
      // El resto de headers documentados sí debe seguir presente.
      expect(names).toContain('if-none-match');
    });

    it('marca la autenticación como servidor-a-servidor', () => {
      const description = spec.paths['/v1/export/content-cache']?.['get']?.description ?? '';
      expect(description).toContain('servidor-a-servidor');
    });
  });

  describe('Libro de Reclamaciones', () => {
    it('documenta el 503 del gate de fase', () => {
      const operation = spec.paths['/v1/complaints']?.['post'];
      expect(operation?.responses).toHaveProperty('503');
      expect(operation?.description).toContain('COMPLAINTS_DISABLED');
      expect(operation?.summary).toContain('BLOQUEADA');
    });

    it('con el gate cerrado no documenta un cuerpo multipart que la API no acepta', () => {
      expect(spec.paths['/v1/complaints']?.['post']?.requestBody).toBeUndefined();
    });

    it('publica la forma de la hoja como componente reservado', () => {
      expect(spec.components.schemas).toHaveProperty('ComplaintPayload');
    });

    it('declara el honeypot `website` que la API acepta dentro del payload', () => {
      // El schema validable (`complaintPayloadSchema`) tiene additionalProperties:false
      // y NO declara `website`, pero la ruta lo extrae antes de limpiar el objeto.
      // Publicar el validable como contrato de request haría que un cliente
      // generado rechazara u omitiera un campo que la API sí admite.
      const payload = spec.components.schemas?.['ComplaintPayload'] as JsonSchemaNode | undefined;
      expect(Object.keys(payload?.properties ?? {})).toContain('website');
      expect(payload?.required ?? []).not.toContain('website');
    });
  });

  describe('barrera anti-fuga', () => {
    it('no documenta _id ni documentos Mongo crudos', () => {
      expect(JSON.stringify(spec)).not.toContain('"_id"');
    });

    it('no expone rowVersionToken en el bundle público de contenido', () => {
      const bundle = JSON.stringify(spec.paths['/v1/content/{locale}']?.['get']?.responses['200']);
      expect(bundle).not.toContain('rowVersionToken');
    });

    it('no documenta las propias rutas de la documentación', () => {
      expect(Object.keys(spec.paths).some((path) => path.startsWith('/docs'))).toBe(false);
    });

    it('no filtra la extensión x-response-description a los schemas publicados', () => {
      // El plugin la consume como descripción de la respuesta y debe eliminarla
      // del schema; si quedara pegada, ensuciaría los clientes generados.
      expect(JSON.stringify(spec)).not.toContain('x-response-description');
    });
  });
});

/**
 * Config SOLO de prueba, en memoria: no altera ningún flag del repositorio ni
 * habilita el Libro en ningún entorno. Cubre la rama `transform`, que es la
 * única forma de documentar un cuerpo multipart parseado a mano.
 */
describe('documentación del alta de reclamos con el gate abierto', () => {
  let enabled: FastifyInstance;
  let enabledSpec: OpenApiSpec;

  beforeAll(async () => {
    enabled = buildApp(
      makeTestConfig({
        DOCS_ENABLED: 'true',
        FEATURE_COMPLAINTS_ENABLED: 'true',
        COMPLAINTS_LEGAL_GATE_CLEARED: 'true',
        COMPLAINTS_PROVIDER_LEGAL_NAME: 'Empresa Test SAC',
        COMPLAINTS_PROVIDER_RUC: '20123456789',
        COMPLAINTS_PROVIDER_ADDRESS: 'Av. Legal 100, Chiclayo',
        COMPLAINTS_CONFIRMATION_TEXT_VERSION: 'v1',
        COMPLAINTS_RESPONSE_DAYS: '30',
      }),
    );
    await enabled.ready();
    enabledSpec = (await enabled.inject({ method: 'GET', url: '/docs/json' })).json<OpenApiSpec>();
  });

  afterAll(async () => {
    await enabled.close();
  });

  it('describe el cuerpo multipart con sus partes reales', () => {
    const content = enabledSpec.paths['/v1/complaints']?.['post']?.requestBody?.content;
    expect(content).toHaveProperty('multipart/form-data');
    const body = JSON.stringify(content);
    expect(body).toContain('payload');
    expect(body).toContain('consumerSignaturePng');
    expect(body).toContain('files');
  });

  it('no documenta los binarios de firma ni de adjuntos en la constancia', () => {
    const schema = jsonSchemaOf(enabledSpec.paths['/v1/complaints']?.['post']?.responses['201']);

    // La firma sale como hashes, nunca como el PNG.
    const signature = schema?.properties?.['signature']?.properties ?? {};
    expect(Object.keys(signature)).not.toContain('content');
    expect(Object.keys(signature)).toContain('contentHash');

    // Cada adjunto sale como metadatos + sha256, nunca como el binario.
    const attachment = schema?.properties?.['attachments']?.items?.properties ?? {};
    expect(Object.keys(attachment)).not.toContain('content');
    expect(Object.keys(attachment)).toEqual(['uploadOrder', 'fileName', 'sizeBytes', 'sha256']);
  });
});

/**
 * Barrera propia de la app para `DOCS_ENABLED=true` en producción: el flag no
 * debe bastar para publicar la superficie de la API a cualquiera que alcance el
 * puerto. No sustituye la restricción en IIS/ARR (que este repositorio no puede
 * verificar), la respalda.
 */
describe('allowlist de /docs en producción', () => {
  const productionConfig = (overrides: Record<string, string> = {}): Record<string, string> => ({
    NODE_ENV: 'production',
    DOCS_ENABLED: 'true',
    // Exigidos en producción con contacto activo (ADR-003).
    MONGO_URI_FORMS: 'mongodb://forms-user:pass@127.0.0.1:27017',
    ...overrides,
  });

  it('permite loopback por defecto (allowlist vacía)', async () => {
    const prod = buildApp(makeTestConfig(productionConfig()));
    try {
      await prod.ready();
      const res = await prod.inject({
        method: 'GET',
        url: '/docs/json',
        remoteAddress: '127.0.0.1',
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await prod.close();
    }
  });

  it('responde 404 (no 403) a un cliente fuera de la allowlist', async () => {
    const prod = buildApp(makeTestConfig(productionConfig()));
    try {
      await prod.ready();
      for (const url of ['/docs', '/docs/json', '/docs/yaml']) {
        const res = await prod.inject({ method: 'GET', url, remoteAddress: '203.0.113.7' });
        // 404 y no 403: para un cliente no autorizado la documentación no existe.
        expect(res.statusCode, url).toBe(404);
        expect(res.json<{ error: { code: string } }>().error.code, url).toBe('NOT_FOUND');
      }
    } finally {
      await prod.close();
    }
  });

  it('permite las IPs declaradas en DOCS_ALLOWED_IPS', async () => {
    const prod = buildApp(
      makeTestConfig(productionConfig({ DOCS_ALLOWED_IPS: '10.0.0.5, 203.0.113.7' })),
    );
    try {
      await prod.ready();
      const allowed = await prod.inject({
        method: 'GET',
        url: '/docs/json',
        remoteAddress: '203.0.113.7',
      });
      expect(allowed.statusCode).toBe(200);

      // Con allowlist explícita, loopback deja de estar implícitamente permitido.
      const denied = await prod.inject({
        method: 'GET',
        url: '/docs/json',
        remoteAddress: '127.0.0.1',
      });
      expect(denied.statusCode).toBe(404);
    } finally {
      await prod.close();
    }
  });

  it('no aplica la allowlist al resto de la API', async () => {
    const prod = buildApp(makeTestConfig(productionConfig()));
    try {
      await prod.ready();
      const res = await prod.inject({
        method: 'GET',
        url: '/health/live',
        remoteAddress: '203.0.113.7',
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await prod.close();
    }
  });
});

describe('documentación OpenAPI deshabilitada', () => {
  it('con DOCS_ENABLED=auto fuera de development no registra ninguna ruta', async () => {
    const disabled = buildApp(makeTestConfig());
    try {
      await disabled.ready();
      expect(disabled.config.DOCS_UI_ENABLED).toBe(false);

      for (const url of ['/docs', '/docs/json', '/docs/yaml']) {
        const res = await disabled.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(404);
        expect(res.json<{ error: { code: string } }>().error.code, url).toBe('NOT_FOUND');
      }
    } finally {
      await disabled.close();
    }
  });

  it('DOCS_ENABLED=false apaga las docs incluso en development', async () => {
    const disabled = buildApp(makeTestConfig({ NODE_ENV: 'development', DOCS_ENABLED: 'false' }));
    try {
      await disabled.ready();
      expect(disabled.config.DOCS_UI_ENABLED).toBe(false);
      const res = await disabled.inject({ method: 'GET', url: '/docs/json' });
      expect(res.statusCode).toBe(404);
    } finally {
      await disabled.close();
    }
  });

  it('DOCS_ENABLED=auto en development las habilita', async () => {
    const dev = buildApp(makeTestConfig({ NODE_ENV: 'development' }));
    try {
      await dev.ready();
      expect(dev.config.DOCS_UI_ENABLED).toBe(true);
      const res = await dev.inject({ method: 'GET', url: '/docs/json' });
      expect(res.statusCode).toBe(200);
    } finally {
      await dev.close();
    }
  });
});
