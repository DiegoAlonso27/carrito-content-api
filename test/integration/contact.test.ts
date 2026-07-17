import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { contactCollections, ensureContactSetup } from '../../src/modules/contact/contact.repo.js';
import type { ContactMessageDoc, ContactMessageDto } from '../../src/modules/contact/contact.types.js';
import { makeTestConfig } from '../helpers/test-config.js';

let mongod: MongoMemoryServer;
let app: FastifyInstance;

/** Payload válido completo; cada test cambia solo lo que necesita probar. */
function validPayload(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    submissionId: randomUUID(),
    nombreApellidos: 'Ana Pérez Díaz',
    correo: 'ana.perez@example.test',
    telefono: '987654321',
    dni: '12345678',
    mensaje: 'Quisiera información sobre encomiendas a Chiclayo, por favor.',
    aceptaTerminos: true,
    website: '',
    ...overrides,
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  // Presupuesto de rate limit alto: esta app se comparte entre ~20 casos de
  // prueba de validación/idempotencia/honeypot, que no son lo que se quiere
  // ejercitar aquí. El rate limit real (5/10min por defecto) se prueba
  // aparte, con apps dedicadas de límite bajo (describe "rate limiting").
  app = buildApp(
    makeTestConfig({
      MONGO_URI: mongod.getUri(),
      FEATURE_CONTACT_ENABLED: 'true',
      RATE_LIMIT_CONTACT_MAX: '1000',
    }),
  );
  await app.ready();
  // La colección se aprovisiona una única vez, de forma explícita — como lo
  // haría scripts/forms/setup-contact.ts en un entorno real (contact.repo.ts
  // nunca ejecuta DDL desde el camino de escritura pública).
  await ensureContactSetup(app.mongo.formsDb);
});

afterAll(async () => {
  await app.close();
  await mongod.stop();
});

describe('POST /v1/contact — alta válida', () => {
  it('201 con el DTO explícito (id, receivedAtUtc, isViewed), sin datos personales en la respuesta', async () => {
    const payload = validPayload();
    const res = await app.inject({ method: 'POST', url: '/v1/contact', payload });

    expect(res.statusCode).toBe(201);
    const body = res.json<ContactMessageDto>();
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);
    expect(new Date(body.receivedAtUtc).toString()).not.toBe('Invalid Date');
    expect(body.isViewed).toBe(false);
    expect(Object.keys(body).sort()).toEqual(['id', 'isViewed', 'receivedAtUtc']);

    // La respuesta jamás debe filtrar datos personales ni el _id de Mongo.
    expect(res.body).not.toContain(payload['nombreApellidos'] as string);
    expect(res.body).not.toContain(payload['correo'] as string);
    expect(res.body).not.toContain(payload['dni'] as string);
    expect(res.body).not.toContain(payload['mensaje'] as string);
    expect(res.body).not.toContain('_id');
  });

  it('persiste exclusivamente en carrito_forms (contact_messages), nunca en carrito_content', async () => {
    const payload = validPayload();
    await app.inject({ method: 'POST', url: '/v1/contact', payload });

    const contentCollectionNames = (await app.mongo.contentDb.listCollections().toArray()).map(
      (c) => c.name,
    );
    expect(contentCollectionNames).not.toContain(contactCollections.messages);

    const stored = await app.mongo.formsDb
      .collection<ContactMessageDoc>(contactCollections.messages)
      .findOne({ submissionId: payload['submissionId'] as string });

    expect(stored).not.toBeNull();
    expect(stored?.nombreApellidos).toBe(payload['nombreApellidos']);
    expect(stored?.correo).toBe(payload['correo']);
    expect(stored?.telefono).toBe('987654321');
    expect(stored?.dni).toBe(payload['dni']);
    expect(stored?.mensaje).toBe(payload['mensaje']);
    expect(stored?.aceptaTerminos).toBe(true);
    expect(stored?.isViewed).toBe(false);
    expect(stored?.viewedAtUtc).toBeNull();
    expect(stored?.viewedBy).toBeNull();
    expect(stored?.createdAtUtc).toBeInstanceOf(Date);

    // Regla dura: nunca se persiste IP ni User-Agent.
    expect(stored).not.toHaveProperty('ip');
    expect(stored).not.toHaveProperty('userAgent');
    expect(Object.keys(stored ?? {}).sort()).toEqual(
      [
        '_id',
        'aceptaTerminos',
        'correo',
        'createdAtUtc',
        'dni',
        'isViewed',
        'mensaje',
        'nombreApellidos',
        'submissionId',
        'telefono',
        'viewedAtUtc',
        'viewedBy',
      ].sort(),
    );
  });

  it('normaliza el teléfono a solo dígitos (se admiten +, espacios, guiones y paréntesis en la entrada)', async () => {
    const payload = validPayload({ telefono: '+51 (987) 654-321' });
    await app.inject({ method: 'POST', url: '/v1/contact', payload });

    const stored = await app.mongo.formsDb
      .collection<ContactMessageDoc>(contactCollections.messages)
      .findOne({ submissionId: payload['submissionId'] as string });
    expect(stored?.telefono).toBe('51987654321');
  });

  it('recorta espacios en los campos de texto antes de guardar', async () => {
    const payload = validPayload({ nombreApellidos: '  Ana Pérez Díaz  ' });
    await app.inject({ method: 'POST', url: '/v1/contact', payload });

    const stored = await app.mongo.formsDb
      .collection<ContactMessageDoc>(contactCollections.messages)
      .findOne({ submissionId: payload['submissionId'] as string });
    expect(stored?.nombreApellidos).toBe('Ana Pérez Díaz');
  });

  it('un mensaje con saltos de línea (multilínea legítima) se acepta', async () => {
    const payload = validPayload({ mensaje: 'Primera línea.\nSegunda línea con más detalle.' });
    const res = await app.inject({ method: 'POST', url: '/v1/contact', payload });
    expect(res.statusCode).toBe(201);
  });
});

describe('POST /v1/contact — idempotencia por submissionId', () => {
  it('reintentar el mismo submissionId devuelve 200 con el MISMO id, sin duplicar el registro', async () => {
    const payload = validPayload();

    const first = await app.inject({ method: 'POST', url: '/v1/contact', payload });
    expect(first.statusCode).toBe(201);
    const firstId = first.json<ContactMessageDto>().id;

    const retry = await app.inject({ method: 'POST', url: '/v1/contact', payload });
    expect(retry.statusCode).toBe(200);
    expect(retry.json<ContactMessageDto>().id).toBe(firstId);

    const count = await app.mongo.formsDb
      .collection(contactCollections.messages)
      .countDocuments({ submissionId: payload['submissionId'] as string });
    expect(count).toBe(1);
  });

  it('dos envíos concurrentes con el mismo submissionId crean un único registro', async () => {
    const payload = validPayload();

    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/contact', payload }),
      app.inject({ method: 'POST', url: '/v1/contact', payload }),
    ]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json<ContactMessageDto>().id).toBe(b.json<ContactMessageDto>().id);

    const count = await app.mongo.formsDb
      .collection(contactCollections.messages)
      .countDocuments({ submissionId: payload['submissionId'] as string });
    expect(count).toBe(1);
  });
});

describe('POST /v1/contact — honeypot', () => {
  it('website con contenido responde éxito falso (201) y no persiste nada', async () => {
    const payload = validPayload({ website: 'http://spam.example.test', correo: 'bot@example.test' });
    const res = await app.inject({ method: 'POST', url: '/v1/contact', payload });

    expect(res.statusCode).toBe(201);
    const body = res.json<ContactMessageDto>();
    expect(typeof body.id).toBe('string');
    expect(body.isViewed).toBe(false);

    const stored = await app.mongo.formsDb
      .collection(contactCollections.messages)
      .findOne({ correo: 'bot@example.test' });
    expect(stored).toBeNull();
  });

  it('el honeypot no aparece en los logs de éxito', async () => {
    const infoSpy = vi.spyOn(app.log, 'info');
    const payload = validPayload({ website: 'contenido-de-bot', correo: 'otro-bot@example.test' });
    await app.inject({ method: 'POST', url: '/v1/contact', payload });

    for (const call of infoSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('contenido-de-bot');
      expect(JSON.stringify(call)).not.toContain('otro-bot@example.test');
    }
    infoSpy.mockRestore();
  });
});

describe('POST /v1/contact — validación inválida', () => {
  it('400 con envolvente estándar cuando falta un campo requerido', async () => {
    const { correo, ...withoutCorreo } = validPayload();
    void correo;
    const res = await app.inject({ method: 'POST', url: '/v1/contact', payload: withoutCorreo });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string; requestId: string; details: Record<string, string[]> } }>();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.requestId).toBeTruthy();
    expect(body.error.details['correo']).toBeDefined();
  });

  it('400 cuando el submissionId no es un UUID v4 válido', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contact',
      payload: validPayload({ submissionId: 'no-es-un-uuid' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
  });

  it('400 cuando el correo no tiene formato válido', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contact',
      payload: validPayload({ correo: 'no-es-un-email' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 cuando el DNI no tiene 8–12 alfanuméricos', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contact',
      payload: validPayload({ dni: '123' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 cuando aceptaTerminos es false', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contact',
      payload: validPayload({ aceptaTerminos: false }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
  });

  it('400 cuando aceptaTerminos falta', async () => {
    const { aceptaTerminos, ...withoutAccept } = validPayload();
    void aceptaTerminos;
    const res = await app.inject({ method: 'POST', url: '/v1/contact', payload: withoutAccept });
    expect(res.statusCode).toBe(400);
  });

  it('400 cuando el mensaje es demasiado corto', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contact',
      payload: validPayload({ mensaje: 'muy corto' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 cuando el nombre queda vacío tras recortar espacios (bypass de minLength con espacios)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contact',
      payload: validPayload({ nombreApellidos: '   ' }),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string; details: Record<string, string[]> } }>();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details['nombreApellidos']).toBeDefined();
  });

  it('400 cuando el nombre contiene caracteres de control', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contact',
      payload: validPayload({ nombreApellidos: 'Ana\u0007Pérez' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 cuando el teléfono no tiene entre 6 y 15 dígitos (p. ej. solo separadores)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contact',
      payload: validPayload({ telefono: '++++++' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 cuando el teléfono tiene menos de 6 dígitos', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contact',
      payload: validPayload({ telefono: '12345' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 cuando el teléfono tiene más de 15 dígitos', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contact',
      payload: validPayload({ telefono: '1234567890123456' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('los campos no declarados se descartan y nunca se persisten (additionalProperties: false)', async () => {
    // Config de Ajv del proyecto (removeAdditional:true): un campo no
    // declarado no rompe la petición, pero tampoco llega a almacenarse.
    const payload = validPayload({ ip: '203.0.113.10', correo: 'sin-campos-extra@example.test' });
    const res = await app.inject({ method: 'POST', url: '/v1/contact', payload });
    expect(res.statusCode).toBe(201);

    const stored = await app.mongo.formsDb
      .collection(contactCollections.messages)
      .findOne({ correo: 'sin-campos-extra@example.test' });
    expect(stored).not.toBeNull();
    expect(stored).not.toHaveProperty('ip');
  });

  it('no persiste nada cuando la validación falla', async () => {
    const submissionId = randomUUID();
    await app.inject({
      method: 'POST',
      url: '/v1/contact',
      payload: { submissionId, correo: 'x@x.com' },
    });
    const stored = await app.mongo.formsDb
      .collection(contactCollections.messages)
      .findOne({ submissionId });
    expect(stored).toBeNull();
  });

  it('413 en envolvente estándar cuando el body supera el límite (32 KB)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contact',
      payload: validPayload({ mensaje: 'x'.repeat(40 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json<{ error: { code: string; requestId: string } }>().error.requestId).toBeTruthy();
  });
});

describe('POST /v1/contact — fallo de MongoDB (5xx seguro)', () => {
  it('500 genérico sin datos internos y sin datos personales en los logs', async () => {
    const broken = buildApp(
      makeTestConfig({ MONGO_URI: 'mongodb://127.0.0.1:1', FEATURE_CONTACT_ENABLED: 'true' }),
    );
    try {
      await broken.ready();
      const errorSpy = vi.spyOn(broken.log, 'error');
      const payload = validPayload({ nombreApellidos: 'Nombre Secreto Para Logs' });

      const res = await broken.inject({ method: 'POST', url: '/v1/contact', payload });

      expect(res.statusCode).toBe(500);
      const body = res.json<{ error: { code: string; message: string; requestId: string } }>();
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(res.body).not.toContain('Nombre Secreto Para Logs');
      expect(res.body).not.toContain('at ');

      for (const call of errorSpy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain('Nombre Secreto Para Logs');
        expect(JSON.stringify(call)).not.toContain(payload['correo'] as string);
      }
      errorSpy.mockRestore();
    } finally {
      await broken.close();
    }
  }, 15_000);
});

describe('POST /v1/contact — rate limiting', () => {
  it('supera el límite → 429 con envolvente estándar y Retry-After', async () => {
    const limited = buildApp(
      makeTestConfig({
        MONGO_URI: mongod.getUri(),
        FEATURE_CONTACT_ENABLED: 'true',
        RATE_LIMIT_CONTACT_MAX: '2',
        RATE_LIMIT_CONTACT_WINDOW_MINUTES: '10',
      }),
    );
    try {
      await limited.ready();
      await ensureContactSetup(limited.mongo.formsDb);

      for (let i = 0; i < 2; i++) {
        const ok = await limited.inject({ method: 'POST', url: '/v1/contact', payload: validPayload() });
        expect(ok.statusCode).toBe(201);
      }
      const blocked = await limited.inject({
        method: 'POST',
        url: '/v1/contact',
        payload: validPayload(),
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBeDefined();
      expect(blocked.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
    } finally {
      await limited.close();
    }
  });

  it('IPs distintas (X-Forwarded-For, confiado solo tras el loopback) tienen presupuestos independientes', async () => {
    const limited = buildApp(
      makeTestConfig({
        MONGO_URI: mongod.getUri(),
        FEATURE_CONTACT_ENABLED: 'true',
        RATE_LIMIT_CONTACT_MAX: '1',
        RATE_LIMIT_CONTACT_WINDOW_MINUTES: '10',
      }),
    );
    try {
      await limited.ready();
      await ensureContactSetup(limited.mongo.formsDb);

      const first = await limited.inject({
        method: 'POST',
        url: '/v1/contact',
        payload: validPayload(),
        headers: { 'x-forwarded-for': '203.0.113.10' },
      });
      expect(first.statusCode).toBe(201);

      const sameIpBlocked = await limited.inject({
        method: 'POST',
        url: '/v1/contact',
        payload: validPayload(),
        headers: { 'x-forwarded-for': '203.0.113.10' },
      });
      expect(sameIpBlocked.statusCode).toBe(429);

      const otherIpOk = await limited.inject({
        method: 'POST',
        url: '/v1/contact',
        payload: validPayload(),
        headers: { 'x-forwarded-for': '198.51.100.20' },
      });
      expect(otherIpOk.statusCode).toBe(201);
    } finally {
      await limited.close();
    }
  });
});
