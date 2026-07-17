import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { AppError, ErrorCodes } from '../../shared/errors/app-error.js';
import type {
  ConsumerInput,
  DetailInput,
  GuardianInput,
  ProviderSnapshot,
  ServiceInput,
} from './complaints.types.js';

/**
 * Firma del consumidor (§5.8): validación del PNG del trazo, hash de su
 * contenido y hash de la serialización canónica de la hoja firmada.
 *
 * La firma mágica sola NO demuestra que el PNG sea una imagen válida ni
 * detecta un canvas vacío; por eso se decodifica con `pngjs` (dependencia
 * autorizada, equivalente Node de la lib aprobada en P5) y se exige presencia
 * de trazo. Nunca se acepta SVG ni otro formato interpretable.
 *
 * El PNG es dato personal altamente sensible: este módulo solo lo valida y
 * lo hashea; nunca lo escribe en logs, DTOs ni correo (AGENTS.md, §5.4).
 */

/** Versión de la especificación de serialización canónica de la hoja. */
export const DOCUMENT_VERSION = '1';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_DIMENSION = 4000;
/** Píxeles con tinta mínimos para considerar el trazo no vacío. */
const MIN_INK_PIXELS = 16;

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Valida el PNG del trazo: firma mágica, decodificación válida, dimensiones
 * razonables y trazo no vacío. Lanza 400 (envolvente estándar) ante cualquier
 * fallo; el 413 por tamaño se aplica antes, en el parseo multipart.
 */
export function validateSignaturePng(buffer: Buffer): void {
  if (buffer.length < PNG_MAGIC.length || !buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new AppError(ErrorCodes.validation, 'Datos inválidos.', 400, {
      consumerSignaturePng: ['no es un PNG válido (firma mágica incorrecta)'],
    });
  }

  let decoded: PNG;
  try {
    decoded = PNG.sync.read(buffer);
  } catch {
    throw new AppError(ErrorCodes.validation, 'Datos inválidos.', 400, {
      consumerSignaturePng: ['el PNG no se pudo decodificar'],
    });
  }

  if (
    decoded.width < 1 ||
    decoded.height < 1 ||
    decoded.width > MAX_DIMENSION ||
    decoded.height > MAX_DIMENSION
  ) {
    throw new AppError(ErrorCodes.validation, 'Datos inválidos.', 400, {
      consumerSignaturePng: ['dimensiones del PNG fuera de rango'],
    });
  }

  if (!hasInk(decoded)) {
    throw new AppError(ErrorCodes.validation, 'Datos inválidos.', 400, {
      consumerSignaturePng: ['el trazo de la firma está vacío'],
    });
  }
}

/**
 * Detecta trazo comparando cada píxel con el fondo (esquina superior
 * izquierda): funciona tanto con fondo transparente (alpha 0) como con fondo
 * blanco opaco. Un canvas homogéneo (vacío) no supera el umbral.
 */
function hasInk(png: PNG): boolean {
  const { data } = png;
  if (data.length < 4) return false;
  const bg = { r: data[0] ?? 0, g: data[1] ?? 0, b: data[2] ?? 0, a: data[3] ?? 0 };
  let ink = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const dr = Math.abs((data[i] ?? 0) - bg.r);
    const dg = Math.abs((data[i + 1] ?? 0) - bg.g);
    const db = Math.abs((data[i + 2] ?? 0) - bg.b);
    const da = Math.abs((data[i + 3] ?? 0) - bg.a);
    if (dr + dg + db + da > 24) {
      ink += 1;
      if (ink >= MIN_INK_PIXELS) return true;
    }
  }
  return false;
}

interface CanonicalSheetInput {
  complaintCode: string;
  createdAtUtc: Date;
  provider: ProviderSnapshot;
  consumer: ConsumerInput;
  guardian: GuardianInput | null;
  service: ServiceInput;
  detail: DetailInput;
  confirmation: { textVersion: string; confirmedAtUtc: Date };
  /** Adjuntos ordenados; el canónico sella la lista (nombre normalizado, sha256). */
  attachments: { uploadOrder: number; originalFileName: string; sha256: string }[];
}

/**
 * Serialización canónica de la hoja firmada (§5.8). Reglas de forma: claves en
 * orden fijo documentado, UTF-8 con normalización NFC, `null` literal para
 * ausentes (nunca se omite la clave), fechas ISO-8601 UTC, decimales con escala
 * fija (2), adjuntos como pares (nombre, sha256) ordenados por `uploadOrder`.
 * Excluye ciclo de vida, plazos y dispatch. El hash resultante liga la firma
 * al contenido exacto: recomputarlo detecta manipulación posterior.
 */
export function buildCanonicalSheet(input: CanonicalSheetInput): {
  canonical: string;
  documentVersion: string;
  signedDocumentHash: string;
} {
  const canonicalObject = {
    documentVersion: DOCUMENT_VERSION,
    complaintCode: input.complaintCode,
    createdAtUtc: input.createdAtUtc.toISOString(),
    provider: {
      legalName: nfc(input.provider.legalName),
      ruc: nfc(input.provider.ruc),
      address: nfc(input.provider.address),
    },
    consumer: {
      documentType: input.consumer.documentType,
      documentNumber: nfc(input.consumer.documentNumber),
      firstName: nfc(input.consumer.firstName),
      lastNamePaternal: nfc(input.consumer.lastNamePaternal),
      lastNameMaternal: nfcOrNull(input.consumer.lastNameMaternal),
      address: nfc(input.consumer.address),
      phone: nfc(input.consumer.phone),
      email: nfc(input.consumer.email),
      birthDate: input.consumer.birthDate,
      gender: input.consumer.gender,
    },
    guardian:
      input.guardian === null
        ? null
        : {
            documentType: input.guardian.documentType,
            documentNumber: nfc(input.guardian.documentNumber),
            firstName: nfc(input.guardian.firstName),
            lastName: nfc(input.guardian.lastName),
          },
    service: {
      type: input.service.type,
      claimedAmount:
        input.service.claimedAmount === null ? null : input.service.claimedAmount.toFixed(2),
      description: nfc(input.service.description),
    },
    detail: {
      type: input.detail.type,
      voucherType: nfcOrNull(input.detail.voucherType),
      voucherSeries: nfcOrNull(input.detail.voucherSeries),
      voucherNumber: nfcOrNull(input.detail.voucherNumber),
      reason: nfc(input.detail.reason),
      province: nfc(input.detail.province),
      terminal: nfc(input.detail.terminal),
      incidentDate: input.detail.incidentDate,
      detail: nfc(input.detail.detail),
      consumerRequest: nfc(input.detail.consumerRequest),
    },
    confirmation: {
      textVersion: nfc(input.confirmation.textVersion),
      confirmedAtUtc: input.confirmation.confirmedAtUtc.toISOString(),
    },
    attachments: [...input.attachments]
      .sort((a, b) => a.uploadOrder - b.uploadOrder)
      .map((a) => [nfc(a.originalFileName), a.sha256] as const),
  };

  const canonical = JSON.stringify(canonicalObject);
  return {
    canonical,
    documentVersion: DOCUMENT_VERSION,
    signedDocumentHash: sha256Hex(Buffer.from(canonical, 'utf8')),
  };
}

function nfc(value: string): string {
  return value.normalize('NFC');
}

function nfcOrNull(value: string | null): string | null {
  return value === null ? null : value.normalize('NFC');
}
