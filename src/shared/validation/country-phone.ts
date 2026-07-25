import { AppError, ErrorCodes } from '../errors/app-error.js';
import { PHONE_PREFIX_COUNTRIES } from './phone-prefixes.js';

/**
 * Validación y normalización del teléfono POR PAÍS (ADR-010, §3 de
 * `docs/validation-parity.md`). Helper única de la API: la usan el formulario
 * de contacto (`telefono` / `telefonoPais`) y el Libro de Reclamaciones
 * (`consumer.phone` / `consumer.phoneCountry`).
 *
 * Por qué vive aquí y no en un patrón JSON Schema: la regla depende del país
 * elegido (dos campos cruzados) y en Perú es estructural, no de longitud. El
 * borde TypeBox solo valida la FORMA (`^[A-Z]{2}$` para el país, charset sin
 * `+` para el número); la regla de negocio es esta función.
 *
 * Dos capas de longitud, porque el catálogo vendorizado no trae longitudes:
 * 1. `PE`: regla estructural (celular / fijo). No se enumeran los códigos de
 *    área de OSIPTEL: son frágiles ante reasignaciones.
 * 2. Overlay curado (heredado del checkout del front) para los países con
 *    longitud nacional fija conocida.
 * 3. Fallback E.164 genérico para el resto del catálogo.
 *
 * Devuelve el prefijo resuelto para persistirlo como SNAPSHOT: si el catálogo
 * cambiara, el registro histórico no se reinterpreta (ADR-010 §4). Nunca se
 * persiste el número crudo con separadores.
 */

export interface ResolvedCountryPhone {
  /** ISO2 del país, tal como está en el catálogo. */
  iso2: string;
  /** Prefijo internacional con `+` (snapshot del catálogo, p. ej. `"+51"`). */
  dialCode: string;
  /** Número nacional, solo dígitos. */
  nationalNumber: string;
}

/**
 * Claves de error a usar en `details` de la envolvente estándar. Se inyectan
 * porque cada formulario nombra los campos a su manera (`telefono` /
 * `telefonoPais` en contacto, `consumer.phone` / `consumer.phoneCountry` en
 * reclamos) y el 400 debe caer en el campo real del cliente.
 */
export interface CountryPhoneErrorKeys {
  phone: string;
  country: string;
}

const DIAL_DIGITS_BY_ISO2: ReadonlyMap<string, string> = new Map(
  PHONE_PREFIX_COUNTRIES.map((country) => [country.iso2, country.dialDigits]),
);

/** Perú (estructural): celular de 9 dígitos que empieza en 9. */
const PE_MOBILE = /^9\d{8}$/;
/** Perú (estructural): fijo de 8 dígitos; 1 = Lima, 4–8 = provincias. */
const PE_LANDLINE = /^(1\d{7}|[4-8]\d{7})$/;

/** Overlay curado de longitud nacional [mín, máx] heredado del checkout. */
const NATIONAL_LENGTH_OVERLAY: ReadonlyMap<string, readonly [number, number]> = new Map([
  ['VE', [10, 10]],
  ['AR', [10, 10]],
  ['CL', [9, 9]],
  ['CO', [10, 10]],
  ['EC', [9, 9]],
  ['MX', [10, 10]],
  ['BO', [8, 8]],
  ['BR', [10, 11]],
  ['US', [10, 10]],
  ['CN', [11, 11]],
]);

const FALLBACK_MIN_DIGITS = 4;
const FALLBACK_MAX_DIGITS = 14;
/** Máximo de dígitos de un número E.164 completo (prefijo + nacional). */
const E164_MAX_DIGITS = 15;

/**
 * Valida el par (país, número) y devuelve el teléfono normalizado.
 *
 * @param iso2 ISO2 ya validado por forma (`^[A-Z]{2}$`) en el borde.
 * @param rawPhone Número crudo ya recortado; admite separadores decorativos.
 * @throws AppError 400 `VALIDATION_ERROR` con la envolvente estándar del
 * proyecto y el error en la clave del campo que falla.
 */
export function resolveCountryPhone(
  iso2: string,
  rawPhone: string,
  keys: CountryPhoneErrorKeys,
): ResolvedCountryPhone {
  const dialDigits = DIAL_DIGITS_BY_ISO2.get(iso2);
  if (dialDigits === undefined) {
    throw invalid(keys.country, 'el país del teléfono no está en el catálogo');
  }

  const nationalNumber = rawPhone.replace(/\D/g, '');
  const problem = checkNationalNumber(iso2, dialDigits, nationalNumber);
  if (problem !== null) {
    throw invalid(keys.phone, problem);
  }

  return { iso2, dialCode: `+${dialDigits}`, nationalNumber };
}

/** Devuelve el mensaje de error, o null si el número es válido para el país. */
function checkNationalNumber(iso2: string, dialDigits: string, digits: string): string | null {
  if (iso2 === 'PE') {
    if (PE_MOBILE.test(digits) || PE_LANDLINE.test(digits)) return null;
    return 'debe ser un celular de 9 dígitos que empiece en 9 o un fijo de 8 dígitos';
  }

  const overlay = NATIONAL_LENGTH_OVERLAY.get(iso2);
  if (overlay !== undefined) {
    const [min, max] = overlay;
    if (digits.length >= min && digits.length <= max) return null;
    return min === max
      ? `debe tener ${String(min)} dígitos para el país seleccionado`
      : `debe tener entre ${String(min)} y ${String(max)} dígitos para el país seleccionado`;
  }

  if (digits.length < FALLBACK_MIN_DIGITS || digits.length > FALLBACK_MAX_DIGITS) {
    return `debe tener entre ${String(FALLBACK_MIN_DIGITS)} y ${String(FALLBACK_MAX_DIGITS)} dígitos`;
  }
  if (dialDigits.length + digits.length > E164_MAX_DIGITS) {
    return `junto al prefijo del país no puede superar ${String(E164_MAX_DIGITS)} dígitos`;
  }
  return null;
}

function invalid(field: string, message: string): AppError {
  return new AppError(ErrorCodes.validation, 'Datos inválidos.', 400, { [field]: [message] });
}
