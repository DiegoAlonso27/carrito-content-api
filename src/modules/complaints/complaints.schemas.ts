import { Type, FormatRegistry } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

/**
 * El payload es multipart, así que se valida con `Value` de TypeBox (no con el
 * Ajv de Fastify). `Value` no trae formatos: se registra `email` una vez para
 * que la validación del correo funcione igual que en el resto de la API.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
if (!FormatRegistry.Has('email')) {
  FormatRegistry.Set('email', (value) => EMAIL_RE.test(value));
}

/**
 * Esquemas TypeBox del Libro de Reclamaciones (F6). Campos y rangos heredados
 * de `formularios-backend-csharp.md` (§4 POST /api/reclamos).
 *
 * El body del alta es `multipart/form-data` (parte `payload` JSON + `files[]`
 * + `consumerSignaturePng`), así que TypeBox NO valida el request vía el
 * `schema.body` de Fastify: `complaintPayloadSchema` se compila con Ajv y se
 * valida manualmente en la ruta sobre la parte `payload` ya parseada, con el
 * MISMO contrato de error del proyecto. El `schema.response` sí es de Fastify
 * y es la barrera anti-fuga: nunca serializa binarios, `_id` ni internos.
 *
 * Las reglas condicionales (monto obligatorio en reclamo, comprobante solo en
 * reclamo, apoderado obligatorio para menores, fechas pasada/no-futura) NO son
 * expresables de forma legible como JSON Schema: viven en complaints.validation.ts.
 *
 * Los patrones asumen que la ruta recorta (`trim`) los strings antes de medir
 * longitudes (igual que contact): validar el valor crudo dejaría pasar
 * `"   a   "` por encima de `minLength`.
 */

const uuidV4Pattern =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
const phoneInputPattern = '^[0-9+()\\-\\s]{6,25}$';
const docNumberPattern = '^[A-Za-z0-9]{8,12}$';
const noControlChars = '^[^\\u0000-\\u001F\\u007F]*$';
const noControlCharsMultiline = '^[^\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]*$';
const isoDatePattern = '^\\d{4}-\\d{2}-\\d{2}$';
const isoDateTimePattern = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z$';

function NullableString(pattern: string, min: number, max: number) {
  return Type.Union([Type.String({ pattern, minLength: min, maxLength: max }), Type.Null()]);
}

const consumerSchema = Type.Object(
  {
    documentType: Type.Union([Type.Literal('DNI'), Type.Literal('Pasaporte')]),
    documentNumber: Type.String({ pattern: docNumberPattern }),
    firstName: Type.String({ minLength: 2, maxLength: 100, pattern: noControlChars }),
    lastNamePaternal: Type.String({ minLength: 2, maxLength: 100, pattern: noControlChars }),
    lastNameMaternal: NullableString(noControlChars, 1, 100),
    address: Type.String({ minLength: 5, maxLength: 300, pattern: noControlChars }),
    phone: Type.String({ pattern: phoneInputPattern }),
    email: Type.String({ format: 'email', maxLength: 254 }),
    birthDate: Type.Union([Type.String({ pattern: isoDatePattern }), Type.Null()]),
    gender: Type.Union([Type.Literal('M'), Type.Literal('F'), Type.Null()]),
  },
  { additionalProperties: false },
);

const guardianSchema = Type.Union([
  Type.Object(
    {
      documentType: Type.Union([Type.Literal('DNI'), Type.Literal('Pasaporte')]),
      documentNumber: Type.String({ pattern: docNumberPattern }),
      firstName: Type.String({ minLength: 2, maxLength: 100, pattern: noControlChars }),
      lastName: Type.String({ minLength: 2, maxLength: 100, pattern: noControlChars }),
    },
    { additionalProperties: false },
  ),
  Type.Null(),
]);

const serviceSchema = Type.Object(
  {
    type: Type.Union([Type.Literal('producto'), Type.Literal('servicio')]),
    // Obligatoriedad según detail.type se valida en complaints.validation.ts.
    claimedAmount: Type.Union([Type.Number({ minimum: 0, maximum: 9_999_999.99 }), Type.Null()]),
    description: Type.String({ minLength: 3, maxLength: 500, pattern: noControlCharsMultiline }),
  },
  { additionalProperties: false },
);

const detailSchema = Type.Object(
  {
    type: Type.Union([Type.Literal('reclamo'), Type.Literal('queja')]),
    voucherType: NullableString(noControlChars, 1, 20),
    voucherSeries: NullableString(noControlChars, 1, 20),
    voucherNumber: NullableString(noControlChars, 1, 30),
    reason: Type.String({ minLength: 1, maxLength: 100, pattern: noControlChars }),
    province: Type.String({ minLength: 1, maxLength: 100, pattern: noControlChars }),
    terminal: Type.String({ minLength: 1, maxLength: 100, pattern: noControlChars }),
    incidentDate: Type.Union([Type.String({ pattern: isoDatePattern }), Type.Null()]),
    detail: Type.String({ minLength: 10, maxLength: 4000, pattern: noControlCharsMultiline }),
    consumerRequest: Type.String({
      minLength: 10,
      maxLength: 4000,
      pattern: noControlCharsMultiline,
    }),
  },
  { additionalProperties: false },
);

export const complaintPayloadSchema = Type.Object(
  {
    submissionId: Type.String({ pattern: uuidV4Pattern }),
    consumer: consumerSchema,
    guardian: guardianSchema,
    service: serviceSchema,
    detail: detailSchema,
    confirmation: Type.Literal(true),
  },
  { additionalProperties: false },
);

export type ComplaintPayloadStatic = Static<typeof complaintPayloadSchema>;

// --- Response (constancia) — barrera anti-fuga de Fastify ---

const providerSchema = Type.Object(
  {
    legalName: Type.String(),
    ruc: Type.String(),
    address: Type.String(),
  },
  { additionalProperties: false },
);

export const complaintReceiptSchema = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    receivedAtUtc: Type.String({ pattern: isoDateTimePattern }),
    status: Type.Literal('PENDIENTE'),
    responseDueAtUtc: Type.String({ pattern: isoDateTimePattern }),
    provider: providerSchema,
    sheet: Type.Object(
      {
        consumer: consumerSchema,
        guardian: guardianSchema,
        service: serviceSchema,
        detail: detailSchema,
        confirmedAtUtc: Type.String({ pattern: isoDateTimePattern }),
        confirmationTextVersion: Type.String(),
      },
      { additionalProperties: false },
    ),
    signature: Type.Object(
      {
        type: Type.Literal('CONSUMIDOR'),
        method: Type.Literal('TRAZO_MANUSCRITO'),
        signedAtUtc: Type.String({ pattern: isoDateTimePattern }),
        signedDocumentHash: Type.String(),
        contentHash: Type.String(),
        documentVersion: Type.String(),
      },
      { additionalProperties: false },
    ),
    attachments: Type.Array(
      Type.Object(
        {
          uploadOrder: Type.Integer(),
          fileName: Type.String(),
          sizeBytes: Type.Integer(),
          sha256: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    emailReceipt: Type.Object(
      {
        recipient: Type.String(),
        status: Type.Union([
          Type.Literal('pendiente'),
          Type.Literal('enviado'),
          Type.Literal('fallido'),
        ]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
