import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError, ErrorCodes } from '../errors/app-error.js';

/**
 * Autenticación servidor-a-servidor del export: API key en el header
 * X-Export-Key (nunca llega al navegador; la usa el build de carrito-front).
 *
 * - Comparación timing-safe sobre digests SHA-256 (longitudes iguales, sin
 *   fuga por tiempo de respuesta).
 * - Se aceptan hasta dos claves simultáneas para rotar sin corte: se agrega
 *   la nueva, se actualiza el consumidor y se retira la vieja.
 * - Sin claves configuradas el endpoint queda deshabilitado (401 siempre):
 *   es el kill-switch operativo del export.
 * - Cada clave configurada debe tener al menos 32 caracteres (entropía mínima
 *   operativa; generar con `randomBytes(32).toString('hex')` → 64 chars).
 */

/** Longitud mínima por clave configurada (no aplica al header vacío → 401). */
export const EXPORT_KEY_MIN_LENGTH = 32;
export const EXPORT_KEY_MAX_COUNT = 2;

export function parseExportKeys(raw: string): string[] {
  const keys = raw
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

  if (keys.length > EXPORT_KEY_MAX_COUNT) {
    throw new Error(
      `EXPORT_API_KEYS admite como máximo ${String(EXPORT_KEY_MAX_COUNT)} claves ` +
        `(rotación); se recibieron ${String(keys.length)}.`,
    );
  }
  for (const key of keys) {
    if (key.length < EXPORT_KEY_MIN_LENGTH) {
      throw new Error(
        `cada clave de EXPORT_API_KEYS debe tener al menos ${String(EXPORT_KEY_MIN_LENGTH)} ` +
          `caracteres (recibida una de longitud ${String(key.length)}).`,
      );
    }
  }
  return keys;
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

export function isValidExportKey(provided: string | undefined, configuredKeys: string[]): boolean {
  if (provided === undefined || provided.length === 0 || configuredKeys.length === 0) {
    return false;
  }
  const providedDigest = sha256(provided);
  // Se evalúan TODAS las claves (sin cortocircuito) para tiempo constante.
  let valid = false;
  for (const key of configuredKeys) {
    if (timingSafeEqual(providedDigest, sha256(key))) valid = true;
  }
  return valid;
}

export function requireExportKey(provided: string | undefined, configuredKeys: string[]): void {
  if (!isValidExportKey(provided, configuredKeys)) {
    throw new AppError(ErrorCodes.unauthorized, 'Credencial de export inválida o ausente.', 401);
  }
}
