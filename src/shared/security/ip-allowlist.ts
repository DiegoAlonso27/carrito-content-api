/**
 * Allowlist de IP compartida por las superficies internas de la API.
 *
 * `/docs` y el editor interno aplican la MISMA regla de admisión (allowlist
 * explícita, o loopback si no hay ninguna configurada). Vive en un solo lugar
 * para que no diverjan: duplicar la comparación haría que endurecer una
 * superficie dejara la otra atrás sin que nada lo delate.
 *
 * Lo que NO decide este módulo: el código de respuesta ante un cliente
 * rechazado. `/docs` responde 404 (para el no autorizado la documentación no
 * existe) y el editor interno responde 403; cada guard elige su semántica.
 */

/**
 * Loopback en todas sus formas, incluida la IPv4 mapeada sobre IPv6 que expone
 * Node cuando el socket escucha en dualstack.
 */
const LOOPBACK_IPS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const IPV4_MAPPED_PREFIX = '::ffff:';

/**
 * Un socket dualstack entrega la IPv4 del cliente como `::ffff:10.0.0.5`. Sin
 * normalizar, una allowlist escrita como `10.0.0.5` no casaría nunca: falla
 * cerrado, pero empuja al operador a ensanchar la lista hasta que «funcione».
 */
function normalizeIp(ip: string): string {
  return ip.startsWith(IPV4_MAPPED_PREFIX) ? ip.slice(IPV4_MAPPED_PREFIX.length) : ip;
}

/** Allowlist vacía = solo loopback (default deliberadamente restrictivo). */
export function isClientIpAllowed(ip: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return LOOPBACK_IPS.has(ip);
  const client = normalizeIp(ip);
  return allowed.some((entry) => normalizeIp(entry) === client);
}
