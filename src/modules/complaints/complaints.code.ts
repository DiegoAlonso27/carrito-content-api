import { randomBytes } from 'node:crypto';

/**
 * Código de reclamo seguro y NO predecible.
 *
 * El plan C# proponía un correlativo secuencial (`LR-AAAA-NNNNNN` vía SEQUENCE,
 * §5.3), cuyo formato exacto es P10 (pendiente). Aquí se prioriza el requisito
 * de seguridad explícito: un correlativo secuencial es adivinable y permitiría
 * enumerar reclamos ajenos si en el futuro se expone una consulta por código.
 * Se genera en cambio un sufijo aleatorio con `crypto` (CSPRNG), manteniendo el
 * prefijo humano `LR-<año>-`. El formato final legal se confirma en el MR 1;
 * la no-predictibilidad es innegociable.
 *
 * Alfabeto Crockford Base32 sin caracteres ambiguos (I, L, O, U) para que el
 * código sea legible/dictable sin colisiones visuales. 12 símbolos ⇒ 60 bits
 * de entropía: colisión y adivinación despreciables.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford Base32 (32 símbolos)
const SUFFIX_LENGTH = 12;

export function generateComplaintCode(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  // Rechazo por muestreo: descarta bytes fuera del múltiplo de 32 más alto para
  // no sesgar el alfabeto (256 no es múltiplo de 32… en realidad sí lo es —
  // 256 = 8*32 —, así que un simple % 32 es uniforme; se documenta para claridad).
  const bytes = randomBytes(SUFFIX_LENGTH);
  let suffix = '';
  for (const byte of bytes) {
    suffix += ALPHABET[byte % ALPHABET.length];
  }
  return `LR-${String(year)}-${suffix}`;
}
