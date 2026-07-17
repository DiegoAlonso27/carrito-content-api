import type { FastifyRequest } from 'fastify';
import { AppError, ErrorCodes } from '../../shared/errors/app-error.js';

/**
 * Parseo y validación del `multipart/form-data` del alta de reclamo:
 * una parte `payload` (JSON), cero o más `files` (adjuntos del consumidor) y
 * una parte obligatoria `consumerSignaturePng` (§4). Aplica la política de
 * archivos (P14, configurable): allowlist por firma mágica (nunca por
 * extensión ni Content-Type declarado), tamaño individual/total y cantidad.
 *
 * El límite de tamaño de parte se aplica también en el registro del plugin
 * (`limits.fileSize`), que aborta con 413 antes de bufferizar de más; aquí se
 * re-verifica por tipo (firma vs adjunto) y se agregan las reglas de conjunto.
 */

export interface ParsedFile {
  buffer: Buffer;
  /** Tipo real detectado por firma mágica (no el Content-Type declarado). */
  contentType: string;
  fileName: string;
}

export interface ParsedComplaintMultipart {
  payloadRaw: string;
  honeypot: string;
  signature: { buffer: Buffer };
  files: ParsedFile[];
}

export interface MultipartLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  signatureMaxBytes: number;
  allowedTypes: string[];
}

const PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE';

export async function parseComplaintMultipart(
  req: FastifyRequest,
  limits: MultipartLimits,
): Promise<ParsedComplaintMultipart> {
  if (!req.isMultipart()) {
    throw new AppError(ErrorCodes.validation, 'Datos inválidos.', 400, {
      _: ['se requiere multipart/form-data'],
    });
  }

  let payloadRaw: string | null = null;
  let honeypot = '';
  let signature: { buffer: Buffer } | null = null;
  const rawFiles: { buffer: Buffer; declaredName: string }[] = [];

  for await (const part of req.parts()) {
    if (part.type === 'file') {
      const buffer = await part.toBuffer();
      if (part.file.truncated) {
        throw new AppError(PAYLOAD_TOO_LARGE, 'Cuerpo demasiado grande.', 413, {
          [part.fieldname]: ['excede el tamaño máximo permitido'],
        });
      }
      if (part.fieldname === 'consumerSignaturePng') {
        if (signature !== null) {
          throw new AppError(ErrorCodes.validation, 'Datos inválidos.', 400, {
            consumerSignaturePng: ['solo se admite una firma'],
          });
        }
        if (buffer.length > limits.signatureMaxBytes) {
          throw new AppError(PAYLOAD_TOO_LARGE, 'Cuerpo demasiado grande.', 413, {
            consumerSignaturePng: ['la firma excede el tamaño máximo'],
          });
        }
        signature = { buffer };
      } else if (part.fieldname === 'files') {
        rawFiles.push({ buffer, declaredName: part.filename });
      } else {
        throw new AppError(ErrorCodes.validation, 'Datos inválidos.', 400, {
          [part.fieldname]: ['campo de archivo no esperado'],
        });
      }
    } else if (part.fieldname === 'payload') {
      payloadRaw = typeof part.value === 'string' ? part.value : String(part.value);
    } else if (part.fieldname === 'website') {
      // Honeypot: se captura para el éxito falso; nunca se persiste ni loguea.
      honeypot = typeof part.value === 'string' ? part.value : '';
    }
    // Otros campos escalares se ignoran.
  }

  if (payloadRaw === null) {
    throw new AppError(ErrorCodes.validation, 'Datos inválidos.', 400, {
      payload: ['falta la parte payload'],
    });
  }
  if (signature === null) {
    throw new AppError(ErrorCodes.validation, 'Datos inválidos.', 400, {
      consumerSignaturePng: ['la firma del consumidor es obligatoria'],
    });
  }
  if (rawFiles.length > limits.maxFiles) {
    throw new AppError(ErrorCodes.validation, 'Datos inválidos.', 400, {
      files: [`se admiten como máximo ${String(limits.maxFiles)} archivos`],
    });
  }

  let total = 0;
  const files: ParsedFile[] = [];
  for (const raw of rawFiles) {
    if (raw.buffer.length > limits.maxFileBytes) {
      throw new AppError(PAYLOAD_TOO_LARGE, 'Cuerpo demasiado grande.', 413, {
        files: ['un archivo excede el tamaño máximo'],
      });
    }
    const contentType = sniffAttachmentType(raw.buffer);
    if (contentType === null || !limits.allowedTypes.includes(contentType)) {
      throw new AppError(ErrorCodes.validation, 'Datos inválidos.', 400, {
        files: ['tipo de archivo no permitido (validado por firma mágica)'],
      });
    }
    total += raw.buffer.length;
    files.push({ buffer: raw.buffer, contentType, fileName: normalizeFileName(raw.declaredName) });
  }
  if (total > limits.maxTotalBytes) {
    throw new AppError(PAYLOAD_TOO_LARGE, 'Cuerpo demasiado grande.', 413, {
      files: ['el tamaño total de los adjuntos excede el máximo'],
    });
  }

  return { payloadRaw, honeypot, signature, files };
}

/** Detecta el tipo real por firma mágica. Solo PDF, JPEG y PNG; null si otro. */
function sniffAttachmentType(buffer: Buffer): string | null {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
    return 'application/pdf';
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
}

/** Nombre seguro: solo basename, sin caracteres de control ni rutas. */
function normalizeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const cleaned = stripControlChars(base).replace(/\s+/g, ' ').trim().slice(0, 255);
  return cleaned.length > 0 ? cleaned : 'archivo';
}

function stripControlChars(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out;
}
