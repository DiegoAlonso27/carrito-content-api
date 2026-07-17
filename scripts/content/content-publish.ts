/**
 * Cambia el estado editorial de un registro (publicar, despublicar, archivar).
 *
 * Uso:
 *   npx tsx scripts/content/content-publish.ts --section items --key faqs/es-PE/faq-01 [--to published]
 *
 * --key usa la clave natural con formato de sourceKey:
 *   locales → code · settings → key · assets/collections → slug
 *   pages → locale/slug · texts → locale/key · items → colección/locale/slug
 * --to: published (default) | draft | archived
 */
import { parseArgs } from 'node:util';
import { ContentWriteError, setStatus } from '../../src/modules/content/content-write.service.js';
import { parseSection, withContentDb } from './cli-helpers.js';

const { values: args } = parseArgs({
  options: {
    section: { type: 'string' },
    key: { type: 'string' },
    to: { type: 'string', default: 'published' },
  },
});

const section = parseSection(args.section);
if (args.key === undefined) {
  console.error('ERROR: falta --key <clave natural>');
  process.exit(2);
}
const target = args.to;
if (target !== 'published' && target !== 'draft' && target !== 'archived') {
  console.error('ERROR: --to debe ser published | draft | archived');
  process.exit(2);
}

try {
  const { result, contentVersion } = await withContentDb((db) =>
    setStatus(db, section, args.key as string, target),
  );
  console.log(`${result.key}: ${result.previous} → ${result.current} token=${result.token}`);
  console.log(
    contentVersion === null
      ? 'Sin cambios (ya estaba en ese estado).'
      : `contentVersion → ${String(contentVersion)}.`,
  );
} catch (err) {
  if (err instanceof ContentWriteError) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
