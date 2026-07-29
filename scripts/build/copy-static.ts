/**
 * Copia a dist/ los archivos estáticos que `tsc` ignora.
 *
 * El editor interno se sirve leyendo `editor.html` con `import.meta.url`, así
 * que sin esta copia el artefacto compilado arranca bien y falla al primer
 * `GET /internal/edit`. Se ejecuta como parte de `npm run build`.
 *
 * Uso:
 *   npx tsx scripts/build/copy-static.ts
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const STATIC_FILES: readonly { from: string; to: string }[] = [
  {
    from: 'src/modules/internal-editor/editor.html',
    to: 'dist/modules/internal-editor/editor.html',
  },
];

// Sin try/catch: un archivo declarado que no existe debe romper el build, no
// producir un dist/ silenciosamente incompleto.
for (const file of STATIC_FILES) {
  const target = join(repoRoot, file.to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(repoRoot, file.from), target);
  console.log(`Copiado ${file.from} → ${file.to}`);
}
