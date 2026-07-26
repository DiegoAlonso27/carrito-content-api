import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PNG } from 'pngjs';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import {
  ComplaintRepo,
  complaintsCollections,
  ensureComplaintsSetup,
} from '../../src/modules/complaints/complaints.repo.js';
import type {
  ComplaintDoc,
  ComplaintReceiptDto,
} from '../../src/modules/complaints/complaints.types.js';
import { makeTestConfig } from '../helpers/test-config.js';

let mongod: MongoMemoryServer;
let app: FastifyInstance;

const enabledConfig = (overrides: Record<string, string> = {}): Record<string, string> => ({
  FEATURE_COMPLAINTS_ENABLED: 'true',
  COMPLAINTS_LEGAL_GATE_CLEARED: 'true',
  COMPLAINTS_PROVIDER_LEGAL_NAME: 'Empresa Test SAC',
  COMPLAINTS_PROVIDER_RUC: '20123456789',
  COMPLAINTS_PROVIDER_ADDRESS: 'Av. Legal 100, Chiclayo',
  COMPLAINTS_CONFIRMATION_TEXT_VERSION: 'v1',
  COMPLAINTS_RESPONSE_DAYS: '30',
  RATE_LIMIT_COMPLAINTS_MAX: '1000',
  ...overrides,
});

// --- Helpers de multipart y binarios (sin dependencias) ---

interface Part {
  name: string;
  value?: string;
  filename?: string;
  contentType?: string;
  buffer?: Buffer;
}

function multipart(parts: Part[]): { body: Buffer; headers: Record<string, string> } {
  const boundary = `----test${randomUUID()}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) head += `; filename="${p.filename}"`;
    head += '\r\n';
    if (p.contentType !== undefined) head += `Content-Type: ${p.contentType}\r\n`;
    head += '\r\n';
    chunks.push(Buffer.from(head, 'utf8'));
    chunks.push(p.buffer ?? Buffer.from(p.value ?? '', 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    body: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** PNG 8×8; con trazo (píxeles opacos) o vacío (todo transparente). */
function makePng(withInk: boolean): Buffer {
  const png = new PNG({ width: 8, height: 8 });
  png.data.fill(0); // transparente
  if (withInk) {
    for (let p = 0; p < 40; p++) {
      const idx = p * 4;
      png.data[idx] = 0;
      png.data[idx + 1] = 0;
      png.data[idx + 2] = 0;
      png.data[idx + 3] = 255; // negro opaco
    }
  }
  return PNG.sync.write(png);
}

function makePdf(): Buffer {
  return Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n', 'utf8');
}

interface PayloadOverrides {
  submissionId?: string;
  consumer?: Record<string, unknown>;
  guardian?: Record<string, unknown> | null;
  service?: Record<string, unknown>;
  detail?: Record<string, unknown>;
  confirmation?: unknown;
}

function validPayload(overrides: PayloadOverrides = {}): Record<string, unknown> {
  return {
    submissionId: overrides.submissionId ?? randomUUID(),
    consumer: {
      documentType: 'DNI',
      documentNumber: '12345678',
      firstName: 'Ana',
      lastNamePaternal: 'Pérez',
      lastNameMaternal: 'Díaz',
      address: 'Av. Principal 123, Chiclayo',
      phone: '987654321',
      phoneCountry: 'PE',
      email: 'ana.perez@example.test',
      birthDate: '1990-05-20',
      gender: 'F',
      ...overrides.consumer,
    },
    guardian: overrides.guardian === undefined ? null : overrides.guardian,
    service: {
      type: 'servicio',
      claimedAmount: 55.0,
      description: 'Pasaje Lima-Chiclayo del 10/07',
      ...overrides.service,
    },
    detail: {
      type: 'reclamo',
      voucherType: 'Boleta',
      voucherSeries: 'B001',
      voucherNumber: '0012345',
      reason: 'Cobro indebido',
      terminal: 'Terminal Norte',
      incidentDate: '2026-07-10',
      detail: 'Descripción detallada del incidente ocurrido en el terminal.',
      consumerRequest: 'Solicito la devolución del cobro indebido realizado.',
      ...overrides.detail,
    },
    confirmation: overrides.confirmation === undefined ? true : overrides.confirmation,
  };
}

/** Request multipart completa (payload + firma con trazo + adjuntos opcionales). */
function complaintRequest(
  payload: Record<string, unknown>,
  opts: { signature?: Buffer; files?: Buffer[]; website?: string } = {},
): { body: Buffer; headers: Record<string, string> } {
  const parts: Part[] = [{ name: 'payload', value: JSON.stringify(payload) }];
  if (opts.website !== undefined) parts.push({ name: 'website', value: opts.website });
  for (const [i, f] of (opts.files ?? []).entries()) {
    parts.push({
      name: 'files',
      filename: `adjunto${String(i)}.pdf`,
      contentType: 'application/pdf',
      buffer: f,
    });
  }
  const sig = opts.signature ?? makePng(true);
  parts.push({
    name: 'consumerSignaturePng',
    filename: 'firma.png',
    contentType: 'image/png',
    buffer: sig,
  });
  return multipart(parts);
}

function post(instance: FastifyInstance, req: { body: Buffer; headers: Record<string, string> }) {
  return instance.inject({
    method: 'POST',
    url: '/v1/complaints',
    payload: req.body,
    headers: req.headers,
  });
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  app = buildApp(makeTestConfig(enabledConfig({ MONGO_URI: mongod.getUri() })));
  await app.ready();
  await ensureComplaintsSetup(app.mongo.formsDb);
});

afterAll(async () => {
  await app.close();
  await mongod.stop();
});

describe('POST /v1/complaints — alta válida y constancia', () => {
  it('201 con la constancia; sin _id ni binario de firma/adjuntos en la respuesta', async () => {
    const payload = validPayload();
    const signature = makePng(true);
    const res = await post(app, complaintRequest(payload, { signature, files: [makePdf()] }));

    expect(res.statusCode).toBe(201);
    const body = res.json<ComplaintReceiptDto>();

    expect(body.code).toMatch(/^LR-\d{4}-[0-9A-HJKMNP-TV-Z]{12}$/);
    expect(new Date(body.receivedAtUtc).toString()).not.toBe('Invalid Date');
    expect(body.status).toBe('PENDIENTE');
    expect(body.provider.legalName).toBe('Empresa Test SAC');
    expect(body.signature.type).toBe('CONSUMIDOR');
    expect(body.signature.method).toBe('TRAZO_MANUSCRITO');
    expect(body.signature.signedDocumentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.signature.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.emailReceipt.status).toBe('pendiente'); // sin SMTP configurado

    // Barrera anti-fuga: nunca el _id, ni el PNG, ni la clave `content`.
    expect(res.body).not.toContain('_id');
    expect(res.body).not.toContain('"content"');
    expect(res.body).not.toContain(signature.toString('base64'));
    expect(Object.keys(body.signature).sort()).toEqual(
      [
        'type',
        'method',
        'signedAtUtc',
        'signedDocumentHash',
        'contentHash',
        'documentVersion',
      ].sort(),
    );
  });

  it('el código es no predecible: dos altas distintas generan códigos distintos', async () => {
    const a = await post(app, complaintRequest(validPayload()));
    const b = await post(app, complaintRequest(validPayload()));
    expect(a.json<ComplaintReceiptDto>().code).not.toBe(b.json<ComplaintReceiptDto>().code);
  });

  it('persiste solo en carrito_forms.complaints (nunca en carrito_content); firma y adjuntos como binario, sin IP/UA', async () => {
    const payload = validPayload();
    await post(app, complaintRequest(payload, { files: [makePdf()] }));

    const contentNames = (await app.mongo.contentDb.listCollections().toArray()).map((c) => c.name);
    expect(contentNames).not.toContain(complaintsCollections.complaints);

    const stored = await app.mongo.formsDb
      .collection<ComplaintDoc>(complaintsCollections.complaints)
      .findOne({ submissionId: payload['submissionId'] as string });

    expect(stored).not.toBeNull();
    expect(stored?.status).toBe('PENDIENTE');
    expect(stored?.statusUpdatedBy).toBeNull();
    expect(stored?.consumer.phone).toBe('987654321');
    expect(stored?.signature.contentType).toBe('image/png');
    expect(stored?.attachments).toHaveLength(1);
    expect(stored?.attachments[0]?.scanStatus).toBe('PENDIENTE');
    // Regla dura: nunca IP ni User-Agent.
    expect(stored).not.toHaveProperty('ip');
    expect(stored).not.toHaveProperty('userAgent');
  });

  it('normaliza el teléfono a solo dígitos y persiste país + snapshot del prefijo', async () => {
    const payload = validPayload({ consumer: { phone: ' (987) 654-321 ' } });
    await post(app, complaintRequest(payload));
    const stored = await app.mongo.formsDb
      .collection<ComplaintDoc>(complaintsCollections.complaints)
      .findOne({ submissionId: payload['submissionId'] as string });
    expect(stored?.consumer.phone).toBe('987654321');
    expect(stored?.consumer.phoneCountry).toBe('PE');
    expect(stored?.consumer.phoneDialCode).toBe('+51');
  });

  it('la constancia expone phoneCountry pero NUNCA phoneDialCode (barrera anti-fuga)', async () => {
    const res = await post(app, complaintRequest(validPayload()));
    expect(res.statusCode).toBe(201);
    const body = res.json<ComplaintReceiptDto>();
    expect(body.sheet.consumer.phoneCountry).toBe('PE');
    expect(res.body).not.toContain('phoneDialCode');
    expect(res.body).not.toContain('+51');
  });
});

describe('POST /v1/complaints — idempotencia y honeypot', () => {
  it('reintentar el mismo submissionId devuelve 200 con el mismo código, sin duplicar', async () => {
    const payload = validPayload();
    const first = await post(app, complaintRequest(payload));
    expect(first.statusCode).toBe(201);
    const code = first.json<ComplaintReceiptDto>().code;

    const retry = await post(app, complaintRequest(payload));
    expect(retry.statusCode).toBe(200);
    expect(retry.json<ComplaintReceiptDto>().code).toBe(code);

    const count = await app.mongo.formsDb
      .collection(complaintsCollections.complaints)
      .countDocuments({ submissionId: payload['submissionId'] as string });
    expect(count).toBe(1);
  });

  it('dos envíos concurrentes con el mismo submissionId crean un único registro', async () => {
    const payload = validPayload();
    const [a, b] = await Promise.all([
      post(app, complaintRequest(payload)),
      post(app, complaintRequest(payload)),
    ]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json<ComplaintReceiptDto>().code).toBe(b.json<ComplaintReceiptDto>().code);

    const count = await app.mongo.formsDb
      .collection(complaintsCollections.complaints)
      .countDocuments({ submissionId: payload['submissionId'] as string });
    expect(count).toBe(1);
  });

  it('honeypot (website con contenido) responde 201 pero no persiste nada', async () => {
    const payload = validPayload({ consumer: { email: 'bot@example.test' } });
    const res = await post(app, complaintRequest(payload, { website: 'http://spam.example.test' }));
    expect(res.statusCode).toBe(201);

    const stored = await app.mongo.formsDb
      .collection(complaintsCollections.complaints)
      .findOne({ submissionId: payload['submissionId'] });
    expect(stored).toBeNull();
  });
});

describe('POST /v1/complaints — validación de entrada', () => {
  it('400 cuando falta la parte de firma', async () => {
    const req = multipart([{ name: 'payload', value: JSON.stringify(validPayload()) }]);
    const res = await post(app, req);
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
  });

  it('400 cuando el PNG de firma tiene el canvas vacío (sin trazo)', async () => {
    const res = await post(app, complaintRequest(validPayload(), { signature: makePng(false) }));
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string; details: Record<string, string[]> } }>();
    expect(body.error.details['consumerSignaturePng']).toBeDefined();
  });

  it('400 cuando la firma no es un PNG (firma mágica inválida)', async () => {
    const notPng = Buffer.from('<svg></svg>', 'utf8');
    const res = await post(app, complaintRequest(validPayload(), { signature: notPng }));
    expect(res.statusCode).toBe(400);
  });

  it('400 cuando el submissionId no es UUID v4', async () => {
    const res = await post(app, complaintRequest(validPayload({ submissionId: 'no-uuid' })));
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
  });

  it('400 cuando confirmation no es true', async () => {
    const res = await post(app, complaintRequest(validPayload({ confirmation: false })));
    expect(res.statusCode).toBe(400);
  });

  it('400 cuando el monto es null en un reclamo', async () => {
    const res = await post(
      app,
      complaintRequest(validPayload({ service: { claimedAmount: null } })),
    );
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { details: Record<string, string[]> } }>();
    expect(body.error.details['service.claimedAmount']).toBeDefined();
  });

  it('400 cuando una queja trae datos de comprobante', async () => {
    const res = await post(
      app,
      complaintRequest(
        validPayload({
          service: { claimedAmount: null },
          detail: { type: 'queja', voucherType: 'Boleta' },
        }),
      ),
    );
    expect(res.statusCode).toBe(400);
    expect(
      res.json<{ error: { details: Record<string, string[]> } }>().error.details['detail.voucher'],
    ).toBeDefined();
  });

  it('400 cuando el consumidor es menor de edad y falta el apoderado', async () => {
    const res = await post(
      app,
      complaintRequest(validPayload({ consumer: { birthDate: '2015-01-01' } })),
    );
    expect(res.statusCode).toBe(400);
    expect(
      res.json<{ error: { details: Record<string, string[]> } }>().error.details['guardian'],
    ).toBeDefined();
  });

  it('400 cuando un adjunto tiene un tipo no permitido (validado por firma mágica)', async () => {
    const fakeText = Buffer.from('esto no es un pdf ni imagen', 'utf8');
    const req = multipart([
      { name: 'payload', value: JSON.stringify(validPayload()) },
      { name: 'files', filename: 'malo.pdf', contentType: 'application/pdf', buffer: fakeText },
      {
        name: 'consumerSignaturePng',
        filename: 'f.png',
        contentType: 'image/png',
        buffer: makePng(true),
      },
    ]);
    const res = await post(app, req);
    expect(res.statusCode).toBe(400);
  });

  it('no persiste nada cuando la validación falla', async () => {
    const submissionId = randomUUID();
    await post(app, complaintRequest(validPayload({ submissionId, confirmation: false })));
    const stored = await app.mongo.formsDb
      .collection(complaintsCollections.complaints)
      .findOne({ submissionId });
    expect(stored).toBeNull();
  });
});

/** Envía y devuelve estado + `details` del 400 (vacío si no hubo error). */
async function submit(
  payload: Record<string, unknown>,
): Promise<{
  status: number;
  details: Record<string, string[]>;
  body: ComplaintReceiptDto | null;
}> {
  const res = await post(app, complaintRequest(payload));
  if (res.statusCode === 400) {
    return {
      status: 400,
      details: res.json<{ error: { details: Record<string, string[]> } }>().error.details,
      body: null,
    };
  }
  return { status: res.statusCode, details: {}, body: res.json<ComplaintReceiptDto>() };
}

describe('POST /v1/complaints — G1 escala del monto reclamado', () => {
  it('400 cuando el monto trae más de 2 decimales (la hoja canónica firma toFixed(2))', async () => {
    const { status, details } = await submit(validPayload({ service: { claimedAmount: 55.999 } }));
    expect(status).toBe(400);
    expect(details['service.claimedAmount']).toBeDefined();
  });

  it('acepta 0, 1 y 2 decimales (55, 55.9, 55.99)', async () => {
    for (const claimedAmount of [55, 55.9, 55.99]) {
      const { status } = await submit(validPayload({ service: { claimedAmount } }));
      expect(status).toBe(201);
    }
  });
});

describe('POST /v1/complaints — G2 comprobante obligatorio en reclamo', () => {
  it('400 por campo cuando voucherType es null', async () => {
    const { status, details } = await submit(validPayload({ detail: { voucherType: null } }));
    expect(status).toBe(400);
    expect(details['detail.voucherType']).toBeDefined();
  });

  it('400 por campo cuando voucherSeries es null', async () => {
    const { status, details } = await submit(validPayload({ detail: { voucherSeries: null } }));
    expect(status).toBe(400);
    expect(details['detail.voucherSeries']).toBeDefined();
  });

  it('400 por campo cuando voucherNumber es null', async () => {
    const { status, details } = await submit(validPayload({ detail: { voucherNumber: null } }));
    expect(status).toBe(400);
    expect(details['detail.voucherNumber']).toBeDefined();
  });
});

describe('POST /v1/complaints — G3 formato SUNAT del comprobante', () => {
  it('400 cuando la serie no empieza por F, B, C o E', async () => {
    const { status, details } = await submit(validPayload({ detail: { voucherSeries: 'X001' } }));
    expect(status).toBe(400);
    expect(details['detail.voucherSeries']).toBeDefined();
  });

  it('400 cuando la serie no tiene 4 caracteres', async () => {
    const { status, details } = await submit(validPayload({ detail: { voucherSeries: 'B01' } }));
    expect(status).toBe(400);
    expect(details['detail.voucherSeries']).toBeDefined();
  });

  it('acepta la serie en minúsculas y la normaliza a MAYÚSCULAS en la constancia', async () => {
    const payload = validPayload({ detail: { voucherSeries: 'b001' } });
    const { status, body } = await submit(payload);
    expect(status).toBe(201);
    expect(body?.sheet.detail.voucherSeries).toBe('B001');

    const stored = await app.mongo.formsDb
      .collection<ComplaintDoc>(complaintsCollections.complaints)
      .findOne({ submissionId: payload['submissionId'] as string });
    expect(stored?.detail.voucherSeries).toBe('B001');
  });

  it('400 cuando el correlativo no es numérico', async () => {
    const { status, details } = await submit(validPayload({ detail: { voucherNumber: 'ABC' } }));
    expect(status).toBe(400);
    expect(details['detail.voucherNumber']).toBeDefined();
  });

  it('400 cuando el correlativo supera 8 dígitos', async () => {
    const { status, details } = await submit(
      validPayload({ detail: { voucherNumber: '123456789' } }),
    );
    expect(status).toBe(400);
    expect(details['detail.voucherNumber']).toBeDefined();
  });
});

describe('POST /v1/complaints — G4 género obligatorio (M o F)', () => {
  it('400 cuando gender es null', async () => {
    const { status, details } = await submit(validPayload({ consumer: { gender: null } }));
    expect(status).toBe(400);
    expect(details['consumer.gender']).toBeDefined();
  });

  it('400 cuando gender falta', async () => {
    const { status, details } = await submit(validPayload({ consumer: { gender: undefined } }));
    expect(status).toBe(400);
    expect(details['consumer.gender']).toBeDefined();
  });
});

describe('POST /v1/complaints — R1 teléfono por país (ADR-010)', () => {
  it('PE con celular de 9 dígitos: 201', async () => {
    const { status } = await submit(validPayload({ consumer: { phone: '987654321' } }));
    expect(status).toBe(201);
  });

  it('PE con 10 dígitos: 400 en consumer.phone', async () => {
    const { status, details } = await submit(validPayload({ consumer: { phone: '9876543210' } }));
    expect(status).toBe(400);
    expect(details['consumer.phone']).toBeDefined();
  });

  it('PE con fijo de Lima (17654321) y de provincia (74123456): 201', async () => {
    for (const phone of ['17654321', '74123456']) {
      const { status } = await submit(validPayload({ consumer: { phone } }));
      expect(status).toBe(201);
    }
  });

  it('VE con 10 dígitos: 201 y prefijo +58 persistido', async () => {
    const payload = validPayload({ consumer: { phone: '4121234567', phoneCountry: 'VE' } });
    const { status } = await submit(payload);
    expect(status).toBe(201);
    const stored = await app.mongo.formsDb
      .collection<ComplaintDoc>(complaintsCollections.complaints)
      .findOne({ submissionId: payload['submissionId'] as string });
    expect(stored?.consumer.phoneDialCode).toBe('+58');
  });

  it('VE con 9 dígitos: 400', async () => {
    const { status, details } = await submit(
      validPayload({ consumer: { phone: '412123456', phoneCountry: 'VE' } }),
    );
    expect(status).toBe(400);
    expect(details['consumer.phone']).toBeDefined();
  });

  it('US con 10 dígitos: 201 (número extranjero admitido, p. ej. con Pasaporte)', async () => {
    const { status } = await submit(
      validPayload({ consumer: { phone: '(212) 555-0147', phoneCountry: 'US' } }),
    );
    expect(status).toBe(201);
  });

  it('400 cuando falta consumer.phoneCountry', async () => {
    const { status, details } = await submit(
      validPayload({ consumer: { phoneCountry: undefined } }),
    );
    expect(status).toBe(400);
    expect(details['consumer.phoneCountry']).toBeDefined();
  });

  it('400 cuando phoneCountry no está en el catálogo (XX)', async () => {
    const { status, details } = await submit(validPayload({ consumer: { phoneCountry: 'XX' } }));
    expect(status).toBe(400);
    expect(details['consumer.phoneCountry']).toBeDefined();
  });

  it('400 cuando phoneCountry viene en minúsculas', async () => {
    const { status, details } = await submit(validPayload({ consumer: { phoneCountry: 'pe' } }));
    expect(status).toBe(400);
    expect(details['consumer.phoneCountry']).toBeDefined();
  });

  it('400 cuando el teléfono trae el prefijo con + (el país viaja aparte)', async () => {
    const { status, details } = await submit(validPayload({ consumer: { phone: '+51987654321' } }));
    expect(status).toBe(400);
    expect(details['consumer.phone']).toBeDefined();
  });
});

describe('POST /v1/complaints — regresión: la queja sigue admitiendo monto', () => {
  it('201 con claimedAmount numérico en una queja (§4: opcional, no prohibido)', async () => {
    const { status, body } = await submit(
      validPayload({
        service: { claimedAmount: 55.5 },
        detail: { type: 'queja', voucherType: null, voucherSeries: null, voucherNumber: null },
      }),
    );
    expect(status).toBe(201);
    expect(body?.sheet.service.claimedAmount).toBe(55.5);
  });
});

describe('POST /v1/complaints — rate limiting', () => {
  it('supera el límite → 429 con envolvente y Retry-After', async () => {
    const limited = buildApp(
      makeTestConfig(enabledConfig({ MONGO_URI: mongod.getUri(), RATE_LIMIT_COMPLAINTS_MAX: '2' })),
    );
    try {
      await limited.ready();
      await ensureComplaintsSetup(limited.mongo.formsDb);

      for (let i = 0; i < 2; i++) {
        const ok = await post(limited, complaintRequest(validPayload()));
        expect(ok.statusCode).toBe(201);
      }
      const blocked = await post(limited, complaintRequest(validPayload()));
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBeDefined();
      expect(blocked.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
    } finally {
      await limited.close();
    }
  });
});

describe('POST /v1/complaints — fallo de MongoDB (5xx seguro)', () => {
  it('500 genérico sin datos internos ni personales', async () => {
    const broken = buildApp(makeTestConfig(enabledConfig({ MONGO_URI: 'mongodb://127.0.0.1:1' })));
    try {
      await broken.ready();
      const errorSpy = vi.spyOn(broken.log, 'error');
      const payload = validPayload({ consumer: { firstName: 'NombreSecretoParaLogs' } });

      const res = await post(broken, complaintRequest(payload));

      expect(res.statusCode).toBe(500);
      const body = res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(res.body).not.toContain('NombreSecretoParaLogs');
      expect(res.body).not.toContain('at ');

      for (const call of errorSpy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain('NombreSecretoParaLogs');
      }
      errorSpy.mockRestore();
    } finally {
      await broken.close();
    }
  }, 15_000);
});

describe('POST /v1/complaints — honeypot en el payload (contrato heredado)', () => {
  it('website dentro del JSON payload responde 201 pero no persiste nada', async () => {
    const submissionId = randomUUID();
    const payload = { ...validPayload({ submissionId }), website: 'http://spam.example.test' };
    const res = await post(app, complaintRequest(payload));
    expect(res.statusCode).toBe(201);

    const stored = await app.mongo.formsDb
      .collection(complaintsCollections.complaints)
      .findOne({ submissionId });
    expect(stored).toBeNull();
  });
});

describe('POST /v1/complaints — el correo no puede invalidar el alta', () => {
  it('SMTP inalcanzable → el reclamo se persiste igual (201) con dispatch fallido', async () => {
    const withSmtp = buildApp(
      makeTestConfig(
        enabledConfig({
          MONGO_URI: mongod.getUri(),
          // Puerto cerrado → ECONNREFUSED inmediato: el envío falla, el alta no.
          COMPLAINTS_SMTP_HOST: '127.0.0.1',
          COMPLAINTS_SMTP_PORT: '1',
          COMPLAINTS_SMTP_FROM: 'constancia@example.test',
        }),
      ),
    );
    try {
      await withSmtp.ready();
      await ensureComplaintsSetup(withSmtp.mongo.formsDb);

      const payload = validPayload();
      const res = await post(withSmtp, complaintRequest(payload));

      expect(res.statusCode).toBe(201);
      expect(res.json<ComplaintReceiptDto>().emailReceipt.status).toBe('fallido');

      const stored = await withSmtp.mongo.formsDb
        .collection<ComplaintDoc>(complaintsCollections.complaints)
        .findOne({ submissionId: payload['submissionId'] as string });
      expect(stored).not.toBeNull();
      expect(stored?.emailDispatch.status).toBe('fallido');
      expect(stored?.emailDispatch.lastErrorCode).toBeTruthy();
    } finally {
      await withSmtp.close();
    }
  }, 15_000);
});

describe('POST /v1/complaints — fallo al persistir el estado del dispatch', () => {
  it('updateDispatch() que falla NO invalida el alta: responde 201 y el reclamo queda persistido', async () => {
    const spy = vi
      .spyOn(ComplaintRepo.prototype, 'updateDispatch')
      .mockRejectedValue(new Error('fallo de persistencia del dispatch'));
    try {
      const payload = validPayload();
      const res = await post(app, complaintRequest(payload));

      // El correo/dispatch es accesorio: el reclamo ya está persistido.
      expect(res.statusCode).toBe(201);
      expect(spy).toHaveBeenCalled();

      const stored = await app.mongo.formsDb
        .collection<ComplaintDoc>(complaintsCollections.complaints)
        .findOne({ submissionId: payload['submissionId'] as string });
      expect(stored).not.toBeNull();
      expect(stored?.complaintCode).toBe(res.json<ComplaintReceiptDto>().code);
      // El estado no pudo persistirse: queda como nació (reproceso operativo).
      expect(stored?.emailDispatch.status).toBe('pendiente');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('POST /v1/complaints — límites de adjuntos', () => {
  async function withConfig(
    overrides: Record<string, string>,
    run: (instance: FastifyInstance) => Promise<void>,
  ): Promise<void> {
    const instance = buildApp(
      makeTestConfig(enabledConfig({ MONGO_URI: mongod.getUri(), ...overrides })),
    );
    try {
      await instance.ready();
      await ensureComplaintsSetup(instance.mongo.formsDb);
      await run(instance);
    } finally {
      await instance.close();
    }
  }

  it('413 cuando un adjunto individual excede el máximo por archivo', async () => {
    await withConfig({ COMPLAINTS_ATTACHMENTS_MAX_FILE_BYTES: '10' }, async (instance) => {
      const res = await post(instance, complaintRequest(validPayload(), { files: [makePdf()] }));
      expect(res.statusCode).toBe(413);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  it('413 cuando la suma de adjuntos excede el máximo total', async () => {
    const pdf = makePdf();
    // Cada PDF alcanza el límite individual; juntos superan el total por 1 byte.
    await withConfig(
      {
        COMPLAINTS_ATTACHMENTS_MAX_FILE_BYTES: String(pdf.length),
        COMPLAINTS_ATTACHMENTS_MAX_TOTAL_BYTES: String(pdf.length * 2 - 1),
      },
      async (instance) => {
        const res = await post(instance, complaintRequest(validPayload(), { files: [pdf, pdf] }));
        expect(res.statusCode).toBe(413);
        expect(res.json<{ error: { code: string } }>().error.code).toBe('PAYLOAD_TOO_LARGE');
      },
    );
  });

  it('400 cuando se supera la cantidad máxima de adjuntos', async () => {
    await withConfig({ COMPLAINTS_ATTACHMENTS_MAX_FILES: '1' }, async (instance) => {
      const res = await post(
        instance,
        complaintRequest(validPayload(), { files: [makePdf(), makePdf()] }),
      );
      expect(res.statusCode).toBe(400);
      const body = res.json<{ error: { code: string; details: Record<string, string[]> } }>();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details['files']).toBeDefined();
    });
  });

  it('acepta el máximo permitido de adjuntos (frontera inferior del límite)', async () => {
    await withConfig({ COMPLAINTS_ATTACHMENTS_MAX_FILES: '2' }, async (instance) => {
      const res = await post(
        instance,
        complaintRequest(validPayload(), { files: [makePdf(), makePdf()] }),
      );
      expect(res.statusCode).toBe(201);
      expect(res.json<ComplaintReceiptDto>().attachments).toHaveLength(2);
    });
  });
});

describe('POST /v1/complaints — límites de tamaño (413)', () => {
  it('413 cuando la firma excede el tamaño máximo configurado', async () => {
    const tight = buildApp(
      makeTestConfig(
        enabledConfig({ MONGO_URI: mongod.getUri(), COMPLAINTS_SIGNATURE_MAX_BYTES: '30' }),
      ),
    );
    try {
      await tight.ready();
      await ensureComplaintsSetup(tight.mongo.formsDb);
      // Un PNG válido (cabecera + IHDR + IDAT + IEND) supera ~60 bytes > 30.
      const res = await post(tight, complaintRequest(validPayload(), { signature: makePng(true) }));
      expect(res.statusCode).toBe(413);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('PAYLOAD_TOO_LARGE');
    } finally {
      await tight.close();
    }
  });
});
