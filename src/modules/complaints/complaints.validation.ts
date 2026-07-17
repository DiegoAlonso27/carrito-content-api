import { AppError, ErrorCodes } from '../../shared/errors/app-error.js';
import type { ComplaintPayload } from './complaints.types.js';

/**
 * Reglas de negocio del reclamo NO expresables de forma legible como JSON
 * Schema (heredadas de formularios-backend-csharp.md §4). TypeBox ya validó
 * forma, enums y longitudes; aquí van las condicionales:
 *
 * - monto reclamado obligatorio cuando `detail.type === 'reclamo'`;
 * - comprobante solo cuando `type === 'reclamo'` (nulo en queja);
 * - apoderado obligatorio si el consumidor es menor de edad;
 * - fecha de nacimiento válida y pasada; fecha de incidente válida y no futura.
 *
 * Lanza 400 con la envolvente estándar agrupando errores por campo, igual que
 * la validación de Ajv (contract de error del proyecto).
 */

const MINOR_AGE = 18;

export function validateBusinessRules(payload: ComplaintPayload, now: Date = new Date()): void {
  const errors: Record<string, string[]> = {};

  if (payload.detail.type === 'reclamo') {
    if (payload.service.claimedAmount === null) {
      addError(errors, 'service.claimedAmount', 'el monto reclamado es obligatorio en un reclamo');
    }
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
