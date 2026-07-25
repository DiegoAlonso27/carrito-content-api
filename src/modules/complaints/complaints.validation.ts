import { AppError, ErrorCodes } from '../../shared/errors/app-error.js';
import type { ComplaintPayload, DetailInput } from './complaints.types.js';

/**
 * Reglas de negocio del reclamo NO expresables de forma legible como JSON
 * Schema (heredadas de formularios-backend-csharp.md §4). TypeBox ya validó
 * forma, enums y longitudes; aquí van las condicionales:
 *
 * - monto reclamado obligatorio cuando `detail.type === 'reclamo'` y con
 *   escala máxima de 2 decimales (G1);
 * - comprobante obligatorio y con formato SUNAT cuando `type === 'reclamo'`
 *   (G2/G3), y prohibido en queja;
 * - apoderado obligatorio si el consumidor es menor de edad;
 * - fecha de nacimiento válida y pasada; fecha de incidente válida y no futura.
 *
 * Lanza 400 con la envolvente estándar agrupando errores por campo, igual que
 * la validación de Ajv (contract de error del proyecto).
 */

const MINOR_AGE = 18;

/**
 * Escala máxima del monto reclamado: 2 decimales. Se comprueba en céntimos con
 * tolerancia porque `multipleOf: 0.01` en JSON Schema falla por errores de
 * representación de coma flotante (p. ej. 0.29 % 0.01 ≠ 0). Es una regla dura:
 * la hoja canónica firma `toFixed(2)`, así que un tercer decimal produciría un
 * hash que no describe el dato persistido (G1).
 */
const CENTS_TOLERANCE = 1e-9;

/** Serie SUNAT: letra de tipo de comprobante + 3 alfanuméricos (G3). */
const SUNAT_SERIES = /^[FBCE][A-Z0-9]{3}$/i;
/** Correlativo SUNAT: 1–8 dígitos (G3). */
const SUNAT_NUMBER = /^\d{1,8}$/;

export function validateBusinessRules(payload: ComplaintPayload, now: Date = new Date()): void {
  const errors: Record<string, string[]> = {};

  const { claimedAmount } = payload.service;
  if (
    claimedAmount !== null &&
    Math.abs(claimedAmount * 100 - Math.round(claimedAmount * 100)) > CENTS_TOLERANCE
  ) {
    addError(errors, 'service.claimedAmount', 'el monto reclamado admite máximo 2 decimales');
  }

  if (payload.detail.type === 'reclamo') {
    if (claimedAmount === null) {
      addError(errors, 'service.claimedAmount', 'el monto reclamado es obligatorio en un reclamo');
    }
    validateVoucher(payload.detail, errors);
  } else {
    // queja: no lleva comprobante.
    if (
      payload.detail.voucherType !== null ||
      payload.detail.voucherSeries !== null ||
      payload.detail.voucherNumber !== null
    ) {
      addError(errors, 'detail.voucher', 'una queja no admite datos de comprobante');
    }
  }

  const birthDate = parseCalendarDate(payload.consumer.birthDate);
  if (payload.consumer.birthDate !== null) {
    if (birthDate === null) {
      addError(errors, 'consumer.birthDate', 'fecha de nacimiento inválida');
    } else if (birthDate.getTime() >= startOfUtcDay(now)) {
      addError(errors, 'consumer.birthDate', 'la fecha de nacimiento debe estar en el pasado');
    }
  }

  const incidentDate = parseCalendarDate(payload.detail.incidentDate);
  if (payload.detail.incidentDate !== null) {
    if (incidentDate === null) {
      addError(errors, 'detail.incidentDate', 'fecha de incidente inválida');
    } else if (incidentDate.getTime() > startOfUtcDay(now)) {
      addError(errors, 'detail.incidentDate', 'la fecha de incidente no puede ser futura');
    }
  }

  // Menor de edad ⇒ apoderado completo obligatorio (§4). Solo se evalúa si la
  // fecha de nacimiento es válida; si no, ya se reportó el error de fecha.
  if (birthDate !== null && isMinor(birthDate, now) && payload.guardian === null) {
    addError(
      errors,
      'guardian',
      'el apoderado es obligatorio cuando el consumidor es menor de edad',
    );
  }

  if (Object.keys(errors).length > 0) {
    throw new AppError(ErrorCodes.validation, 'Datos inválidos.', 400, errors);
  }
}

/**
 * Comprobante en un reclamo: obligatorio (G2) y con formato SUNAT (G3). El
 * error se reporta POR CAMPO, no agrupado, para que el front lo pinte donde
 * corresponde. La serie se acepta en minúsculas y la ruta la normaliza a
 * MAYÚSCULAS tras validar (espejo de `normalizeSunatSeries` del front).
 */
function validateVoucher(detail: DetailInput, errors: Record<string, string[]>): void {
  if (detail.voucherType === null) {
    addError(errors, 'detail.voucherType', 'el tipo de comprobante es obligatorio en un reclamo');
  }

  if (detail.voucherSeries === null) {
    addError(
      errors,
      'detail.voucherSeries',
      'la serie del comprobante es obligatoria en un reclamo',
    );
  } else if (!SUNAT_SERIES.test(detail.voucherSeries)) {
    addError(
      errors,
      'detail.voucherSeries',
      'la serie debe ser una letra F, B, C o E seguida de 3 caracteres alfanuméricos',
    );
  }

  if (detail.voucherNumber === null) {
    addError(
      errors,
      'detail.voucherNumber',
      'el número del comprobante es obligatorio en un reclamo',
    );
  } else if (!SUNAT_NUMBER.test(detail.voucherNumber)) {
    addError(errors, 'detail.voucherNumber', 'el correlativo debe tener entre 1 y 8 dígitos');
  }
}

function addError(errors: Record<string, string[]>, field: string, message: string): void {
  (errors[field] ??= []).push(message);
}

/** Parsea 'YYYY-MM-DD' estricto en UTC; null si no es una fecha de calendario real. */
function parseCalendarDate(value: string | null): Date | null {
  if (value === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rechaza desbordes (p. ej. 2026-02-31 → marzo).
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function startOfUtcDay(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function isMinor(birthDate: Date, now: Date): boolean {
  let age = now.getUTCFullYear() - birthDate.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - birthDate.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < birthDate.getUTCDate())) {
    age -= 1;
  }
  return age < MINOR_AGE;
}
