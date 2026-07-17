import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { exportOutPathError } from '../../scripts/content/cli-helpers.js';

describe('protección del CLI de export (M5)', () => {
  const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

  it('rechaza el golden canónico y la copia contractual', () => {
    expect(exportOutPathError('content-cache.json', root, root)).toMatch(/no puede sobrescribir/);
    expect(
      exportOutPathError(path.join('test', 'contract', 'golden', 'content-cache.json'), root, root),
    ).toMatch(/no puede sobrescribir/);
  });

  it('acepta una ruta generada distinta', () => {
    expect(exportOutPathError('content-cache.generated.json', root, root)).toBeNull();
  });
});
