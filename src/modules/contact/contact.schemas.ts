import { Type } from '@sinclair/typebox';

/**
 * Esquemas TypeBox del formulario de contacto: validan la entrada en el
 * borde y definen el DTO de respuesta. Campos y rangos heredados de
 * `formularios-backend-csharp.md` (§ POST /api/contactos).
 *
 * `additionalProperties: false` en ambos: con la config de Ajv del
 * proyecto (removeAdditional: true, global) un campo no declarado se
 * descarta en silencio antes de guardar o serializar — misma barrera
 * anti-fuga que los response schemas (AGENTS.md), aplicada también a la
 * entrada.
 *
 * Los patrones aquí asumen que `contact.routes.ts` recorta (`trim`) los
 * campos de texto en `preValidation`, ANTES de que Ajv mida longitudes:
 * si se validara sobre el valor crudo, `"   a   "` pasaría `minLength` de
 * sobra y se guardaría con contenido inválido.
 */

/** UUID v4 estricto (versión y variante), no cualquier UUID. */
const uuidV4Pattern =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';

/**
 * Charset admitido en la ENTRADA de teléfono (antes de normalizar): dígitos
 * y los separadores decorativos que el contrato tolera. El conteo real de
 * 6–15 dígitos se valida en contact.routes.ts tras extraer solo los
 * dígitos — no es expresable de forma legible como patrón JSON Schema.
 */
const phoneInputPattern = '^[0-9+()\\-\\s]{6,25}$';

const dniPattern = '^[A-Za-z0-9]{8,12}$';

/** Ningún carácter de control (incluye tab/CR/LF): un nombre no los necesita. */
const noControlCharsPattern = '^[^\\u0000-\\u001F\\u007F]*$';

/** Igual que arriba pero permite tab/CR/LF: un mensaje puede tener saltos de línea. */
const noControlCharsExceptNewlinesPattern = '^[^\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]*$';

export const contactBodySchema = Type.Object(
  {
    submissionId: Type.String({ pattern: uuidV4Pattern }),
    nombreApellidos: Type.String({
      minLength: 3,
      maxLength: 200,
      pattern: noControlCharsPattern,
    }),
    correo: Type.String({ format: 'email', maxLength: 254 }),
    telefono: Type.String({ pattern: phoneInputPattern }),
    dni: Type.String({ pattern: dniPattern }),
    mensaje: Type.String({
      minLength: 10,
      maxLength: 2000,
      pattern: noControlCharsExceptNewlinesPattern,
    }),
    aceptaTerminos: Type.Literal(true),
    // Honeypot: input oculto del formulario real; un bot que lo rellena
    // activa un éxito falso sin persistir (contact.routes.ts). No se
    // valida su forma a propósito — cualquier contenido lo activa.
    website: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: false },
);

export const contactResponseSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    receivedAtUtc: Type.String({
      pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z$',
    }),
    isViewed: Type.Boolean(),
  },
  { additionalProperties: false },
);
