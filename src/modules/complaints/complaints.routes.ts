import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import { Value } from '@sinclair/typebox/value';
import multipart from '@fastify/multipart';
import { complaintPayloadSchema, complaintReceiptSchema } from './complaints.schemas.js';
import { ComplaintRepo, toReceiptDto } from './complaints.repo.js';
import { parseComplaintMultipart } from './complaints.multipart.js';
import { validateBusinessRules } from './complaints.validation.js';
import { buildCanonicalSheet, sha256Hex, validateSignaturePng } from './complaints.signature.js';
import { generateComplaintCode } from './complaints.code.js';
import { createNotificationSender } from './complaints.email.js';
import { AppError, ErrorCodes } from '../../shared/errors/app-error.js';
import { errorEnvelopeSchema } from '../../shared/errors/error-schema.js';
import { describeResponse } from '../../shared/docs/openapi-annotations.js';
import type {
  ComplaintAttachment,
  ComplaintDoc,
  ComplaintPayload,
  ComplaintReceiptDto,
  DispatchStatus,
} from './complaints.types.js';

/**
 * Libro de Reclamaciones (F6) — POST /v1/complaints.
 *
 * GATE DE FASE: con `FEATURE_COMPLAINTS_ENABLED=false` (default) el endpoint
 * responde **503 no disponible** sin tocar Mongo, el repo ni el parser
 * multipart. Su activación exige cerrar el gate legal P1–P18 y es una decisión
 * explícita del usuario (AGENTS.md; ADR-007). Este plugin NUNCA cambia el flag.
 *
 * Con el gate habilitado, el alta es `multipart/form-data` (§4): parte
 * `payload` (JSON de la hoja), `files[]` (adjuntos del consumidor) y
 * `consumerSignaturePng` (firma manuscrita obligatoria). Contrato funcional
 * heredado de formularios-backend-csharp.md; transporte/persistencia de esta
 * API. Reglas duras: idempotencia por `submissionId`, honeypot `website`,
 * atomicidad (un único documento), sin IP/UA, sin datos personales en logs, y
 * el response schema como barrera anti-fuga (nunca binarios ni `_id`).
 */

export function complaintsRoutes(app: FastifyInstance): void {
  if (!app.config.FEATURE_COMPLAINTS_ENABLED) {
    registerDisabledGate(app);
    return;
  }
  registerEnabledRoutes(app);
}

/**
 * Responde 503 «no disponible» sin dependencias: prueba de que el gate bloquea.
 * Declara también 415: con el gate cerrado no se registra el parser multipart,
 * así que un cuerpo multipart lo rechaza Fastify por media type antes del
 * handler — esa salida también debe llevar la envolvente estándar.
 */
function registerDisabledGate(app: FastifyInstance): void {
  app.post(
    '/v1/complaints',
    {
      schema: {
        tags: ['complaints'],
        operationId: 'submitComplaint',
        summary: 'Alta de reclamo — BLOQUEADA por gate de fase',
        description:
          '**Actualmente deshabilitado.** Con `FEATURE_COMPLAINTS_ENABLED=false` ' +
          '(valor por defecto) esta ruta responde `503 COMPLAINTS_DISABLED` sin tocar ' +
          'MongoDB. Un request `multipart/form-data` puede ser rechazado antes con ' +
          '`415 UNSUPPORTED_MEDIA_TYPE`, porque el parser multipart no se registra ' +
          'mientras el gate está apagado.\n\n' +
          'La activación exige cerrar el gate legal P1–P18 del contrato heredado y es ' +
          'una decisión explícita y autorizada del usuario, nunca un despliegue. Con ' +
          'el gate cerrado no deben enviarse reclamos ni probarse el contrato desde ' +
          'una UI pública.\n\n' +
          'El contrato reservado para una activación futura (multipart con `payload`, ' +
          '`consumerSignaturePng`, `files` y honeypot `website`) está descrito en ' +
          '`docs/api-contract.md`; el componente `ComplaintPayload` de este documento ' +
          'refleja la forma de la hoja.',
        response: {
          503: describeResponse(
            errorEnvelopeSchema,
            '`COMPLAINTS_DISABLED`: el Libro está cerrado por el gate de fase. ' +
              'No se toca MongoDB.',
          ),
          default: describeResponse(
            errorEnvelopeSchema,
            '`415 UNSUPPORTED_MEDIA_TYPE` si se envía multipart: con el gate cerrado el parser ' +
              'no está registrado.',
          ),
        },
      },
    },
    (req, reply) =>
      reply.code(503).send({
        error: {
          code: 'COMPLAINTS_DISABLED',
          message: 'El Libro de Reclamaciones no está disponible.',
          requestId: req.id,
        },
      }),
  );
}

function registerEnabledRoutes(app: FastifyInstance): void {
  const config = app.config;
  const repo = new ComplaintRepo(app.mongo.formsDb);
  const sender = createNotificationSender(config);

  const limits = {
    maxFiles: config.COMPLAINTS_ATTACHMENTS_MAX_FILES,
    maxFileBytes: config.COMPLAINTS_ATTACHMENTS_MAX_FILE_BYTES,
    maxTotalBytes: config.COMPLAINTS_ATTACHMENTS_MAX_TOTAL_BYTES,
    signatureMaxBytes: config.COMPLAINTS_SIGNATURE_MAX_BYTES,
    allowedTypes: config.COMPLAINTS_ATTACHMENTS_ALLOWED_TYPES.split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
  };

  // Multipart encapsulado en este plugin (no afecta a otras rutas). Se trunca
  // en `fileSize` y se re-verifica por tipo en el parser → 413 controlado.
  void app.register(multipart, {
    throwFileSizeLimit: false,
    limits: {
      fieldSize: 256 * 1024,
      fields: 6,
      fileSize: Math.max(limits.maxFileBytes, limits.signatureMaxBytes),
      files: limits.maxFiles + 5,
      headerPairs: 200,
    },
  });

  const rateLimit = {
    max: config.RATE_LIMIT_COMPLAINTS_MAX,
    timeWindow: `${String(config.RATE_LIMIT_COMPLAINTS_WINDOW_MINUTES)} minutes`,
  };

  app.post(
    '/v1/complaints',
    {
      config: { rateLimit },
      schema: {
        tags: ['complaints'],
        operationId: 'submitComplaint',
        summary: 'Alta de reclamo o queja (Libro de Reclamaciones)',
        description:
          'Registra un reclamo o queja como documento único y atómico.\n\n' +
          'El cuerpo es `multipart/form-data`: parte `payload` (JSON de la hoja), ' +
          '`consumerSignaturePng` (firma manuscrita obligatoria) y `files` (adjuntos ' +
          'del consumidor). El multipart se parsea y valida en la ruta, no con ' +
          '`schema.body`, así que el cuerpo documentado aquí es descriptivo.\n\n' +
          '- `201`: alta nueva.\n' +
          '- `200`: reintento del mismo `submissionId`; devuelve la constancia previa.\n\n' +
          'La constancia **no** contiene `_id`, binarios de firma o adjuntos, ni ' +
          'detalles internos: solo hashes. La firma y los adjuntos jamás aparecen en ' +
          'logs, DTOs ni correo, y no se persiste IP ni User-Agent. Como la constancia ' +
          'refleja datos de la hoja, el consumidor no debe registrarla en consola ni ' +
          'en telemetría cliente.\n\n' +
          'El envío de la constancia por correo es best-effort e inline: un fallo de ' +
          'SMTP no invalida el alta, se refleja en `emailReceipt.status`.',
        // `default` aplica la barrera anti-fuga a cualquier código de error.
        response: {
          200: describeResponse(
            complaintReceiptSchema,
            'Reintento del mismo `submissionId`: devuelve la constancia ya emitida.',
          ),
          201: describeResponse(complaintReceiptSchema, 'Reclamo registrado; constancia emitida.'),
          default: describeResponse(
            errorEnvelopeSchema,
            '`400 VALIDATION_ERROR` (forma o regla de negocio), `413 PAYLOAD_TOO_LARGE` (firma o ' +
              'adjuntos), `429 RATE_LIMITED`.',
          ),
        },
      },
    },
    async (req, reply) => {
      const parsed = await parseComplaintMultipart(req, limits);
      const { payload, honeypot: payloadHoneypot } = parseAndValidatePayload(parsed.payloadRaw);
      validateBusinessRules(payload);

      // Honeypot: el contrato heredado lo ubica dentro del JSON (`website`);
      // esta API además acepta una parte multipart `website`. Se detecta en
      // AMBOS sitios porque el frontend heredado lo envía en el payload y
      // `Value.Clean` lo descartaría en silencio.
      const honeypotTriggered = parsed.honeypot.length > 0 || payloadHoneypot.length > 0;

      // Teléfono: se admiten separadores en la entrada; se normaliza a dígitos
      // (6–15) para persistir y para el hash canónico (regla de negocio).
      const phone = normalizePhone(payload.consumer.phone);
      payload.consumer.phone = phone;

      validateSignaturePng(parsed.signature.buffer);

      const now = new Date();
      const attachments = buildAttachments(parsed.files);
      const complaintCode = generateComplaintCode(now);
      const provider = {
        legalName: config.COMPLAINTS_PROVIDER_LEGAL_NAME,
        ruc: config.COMPLAINTS_PROVIDER_RUC,
        address: config.COMPLAINTS_PROVIDER_ADDRESS,
      };
      const confirmedAtUtc = now;

      const { documentVersion, signedDocumentHash } = buildCanonicalSheet({
        complaintCode,
        createdAtUtc: now,
        provider,
        consumer: payload.consumer,
        guardian: payload.guardian,
        service: payload.service,
        detail: payload.detail,
        confirmation: {
          textVersion: config.COMPLAINTS_CONFIRMATION_TEXT_VERSION,
          confirmedAtUtc,
        },
        attachments,
      });

      const responseDueAtUtc = new Date(
        now.getTime() + config.COMPLAINTS_RESPONSE_DAYS * 24 * 60 * 60 * 1000,
      );

      const doc: ComplaintDoc = {
        submissionId: payload.submissionId,
        complaintCode,
        provider,
        consumer: payload.consumer,
        guardian: payload.guardian,
        service: payload.service,
        detail: payload.detail,
        confirmation: {
          confirmed: true,
          textVersion: config.COMPLAINTS_CONFIRMATION_TEXT_VERSION,
          confirmedAtUtc,
        },
        signature: {
          method: 'TRAZO_MANUSCRITO',
          contentType: 'image/png',
          sizeBytes: parsed.signature.buffer.length,
          content: parsed.signature.buffer,
          contentHash: sha256Hex(parsed.signature.buffer),
          signedDocumentHash,
          documentVersion,
          signedAtUtc: now,
        },
        attachments,
        emailDispatch: {
          recipientEmail: payload.consumer.email,
          status: 'pendiente',
          attemptCount: 0,
          lastAttemptAtUtc: null,
          sentAtUtc: null,
          lastErrorCode: null,
          templateVersion: null,
        },
        status: 'PENDIENTE',
        statusUpdatedAtUtc: now,
        statusUpdatedBy: null,
        createdAtUtc: now,
        responseDueAtUtc,
      };

      if (honeypotTriggered) {
        // Honeypot: éxito falso. No se persiste, no se envía correo, no se
        // loguea el contenido. La constancia se construye pero se descarta.
        return reply.code(201).send(toReceiptDto({ ...doc, _id: new ObjectId() }));
      }

      const { dto, created, insertedId } = await repo.submit(doc);
      req.log.info({ complaintCode: dto.code, created }, 'reclamo recibido');

      if (!created || insertedId === null) {
        // Reintento idempotente: se devuelve el registro previo tal cual.
        return reply.code(200).send(dto);
      }

      // A partir de aquí el reclamo YA está persistido: ni el envío del correo
      // ni la relectura pueden convertir un alta válida en 500. `dispatchReceipt`
      // nunca lanza; la relectura cae al DTO original si falla.
      const receiptStatus = await dispatchReceipt(repo, sender, doc, insertedId, req);
      const dtoWithStatus: ComplaintReceiptDto = {
        ...dto,
        emailReceipt: { ...dto.emailReceipt, status: receiptStatus },
      };
      return reply.code(201).send(dtoWithStatus);
    },
  );
}

/**
 * Envío inline best-effort de la constancia (§5.6): NO hay worker ni cola. El
 * reclamo ya está persistido, así que esta función **nunca lanza**: ni un fallo
 * de SMTP ni un fallo al actualizar el dispatch pueden convertir un alta válida
 * en 500. Devuelve el estado a reflejar en la constancia (`enviado` /
 * `pendiente` / `fallido`); un fallo de persistencia del estado solo significa
 * que el dispatch queda como estaba (reproceso operativo), no que el reclamo
 * se pierda.
 */
async function dispatchReceipt(
  repo: ComplaintRepo,
  sender: ReturnType<typeof createNotificationSender>,
  doc: ComplaintDoc,
  insertedId: ObjectId,
  req: FastifyRequest,
): Promise<DispatchStatus> {
  let status: DispatchStatus = 'pendiente';
  let sentAtUtc: Date | null = null;
  let lastErrorCode: string | null = null;
  let templateVersion: string | null = null;

  try {
    const result = await sender.send(doc);
    status = result.delivered ? 'enviado' : 'pendiente';
    sentAtUtc = result.delivered ? new Date() : null;
    templateVersion = result.templateVersion;
  } catch (err) {
    // Solo la categoría de error, jamás el contenido del correo ni datos personales.
    lastErrorCode = errorCategory(err);
    status = 'fallido';
    req.log.warn(
      { complaintCode: doc.complaintCode, category: lastErrorCode },
      'constancia no enviada',
    );
  }

  try {
    await repo.updateDispatch(insertedId, { status, sentAtUtc, lastErrorCode, templateVersion });
  } catch (err) {
    // El estado no se pudo persistir: el reclamo sigue válido; se reprocesa
    // operativamente. No se propaga (no debe volverse un 500 sobre un alta ok).
    req.log.warn(
      { complaintCode: doc.complaintCode, category: errorCategory(err) },
      'no se pudo actualizar el estado de la constancia',
    );
  }

  return status;
}

function errorCategory(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const { code } = err;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'SEND_FAILED';
}

/**
 * JSON.parse + trim recursivo + validación TypeBox del payload de la hoja.
 * Extrae también el honeypot `website` embebido en el JSON (contrato heredado)
 * ANTES de `Value.Clean`, que lo descartaría por `additionalProperties:false`.
 */
function parseAndValidatePayload(raw: string): { payload: ComplaintPayload; honeypot: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError(ErrorCodes.validation, 'Datos inválidos.', 400, {
      payload: ['JSON inválido'],
    });
  }

  const trimmed = deepTrim(parsed);
  const honeypot = extractHoneypot(trimmed);
  // Elimina propiedades no declaradas (equivalente a removeAdditional de Ajv).
  const cleaned = Value.Clean(complaintPayloadSchema, trimmed);

  if (!Value.Check(complaintPayloadSchema, cleaned)) {
    const details: Record<string, string[]> = {};
    for (const issue of Value.Errors(complaintPayloadSchema, cleaned)) {
      const field = issue.path.replace(/^\//, '').replaceAll('/', '.') || '_';
      (details[field] ??= []).push(issue.message);
    }
    throw new AppError(ErrorCodes.validation, 'Datos inválidos.', 400, details);
  }

  return { payload: cleaned, honeypot };
}

function extractHoneypot(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'website' in value) {
    const { website } = value;
    if (typeof website === 'string') return website;
  }
  return '';
}

function deepTrim(value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(deepTrim);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) out[key] = deepTrim(val);
    return out;
  }
  return value;
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 15) {
    throw new AppError(ErrorCodes.validation, 'Datos inválidos.', 400, {
      'consumer.phone': ['debe tener entre 6 y 15 dígitos'],
    });
  }
  return digits;
}

function buildAttachments(
  files: { buffer: Buffer; contentType: string; fileName: string }[],
): ComplaintAttachment[] {
  return files.map((file, index) => ({
    uploadOrder: index + 1,
    originalFileName: file.fileName,
    contentType: file.contentType,
    sizeBytes: file.buffer.length,
    sha256: sha256Hex(file.buffer),
    content: file.buffer,
    scanStatus: 'PENDIENTE',
  }));
}
