import { describe, expect, it } from 'vitest';
import {
  EXPORT_KEY_MIN_LENGTH,
  parseExportKeys,
} from '../../src/shared/security/export-key.js';

describe('parseExportKeys', () => {
  it('acepta vacío (export deshabilitado)', () => {
    expect(parseExportKeys('')).toEqual([]);
    expect(parseExportKeys('  ,  ')).toEqual([]);
  });

  it('acepta hasta dos claves con longitud mínima', () => {
    const a = 'a'.repeat(EXPORT_KEY_MIN_LENGTH);
    const b = 'b'.repeat(EXPORT_KEY_MIN_LENGTH);
    expect(parseExportKeys(`${a}, ${b}`)).toEqual([a, b]);
  });

  it('rechaza más de dos claves', () => {
    const k = 'k'.repeat(EXPORT_KEY_MIN_LENGTH);
    expect(() => parseExportKeys(`${k},${k},${k}`)).toThrow(/máximo 2/);
  });

  it('rechaza claves demasiado cortas', () => {
    expect(() => parseExportKeys('corta')).toThrow(/al menos 32/);
  });
});
