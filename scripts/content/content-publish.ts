/**
 * Cambia el estado editorial de un registro (publicar, despublicar, archivar).
 *
 * Uso:
 *   npx tsx scripts/content/content-publish.ts --section items --key faqs/es-PE/faq-01 [--to published]
 *   npx tsx scripts/content/content-publish.ts --section destinations --key chiclayo --to published
 *
 * --key usa la clave natural con formato de sourceKey:
 *   locales → code · settings → key · assets/collections → slug
 *   pages → locale/slug · texts → locale/key · items → colección/locale/slug
 *   secciones por bloques → id del documento
 * --to flat: published (default) | draft | archived
 * --to por bloques: draft | review | approved | published | archived
 *
 * Publicar un documento por bloques valida el documento COMPLETO: un bloque
 * inválido impide la publicación (doc 02/05).
 */
import { parseArgs } from 'node:util';
import { ContentWriteError, setStatus } from '../../src/modules/content/content-write.js';
import {
  EditorialWriteError,
  setEditorialStatus,
} from '../../src/modules/editorial/editorial-write.js';
import { editorialDocStatuses } from '../../src/modules/editorial/editorial.types.js';
import type { EditorialDocStatus } from '../../src/modules/editorial/editorial.types.js';
import { parseAnySection, withContentDb } from './cli-helpers.js';

const { values: args } = parseArgs({
  options: {
    section: { type: 'string' },
    key: { type: 'string' },
    to: { type: 'string', default: 'published' },
  },
});

const section = parseAnySection(args.section);
if (args.key === undefined) {
  console.error('ERROR: falta --key <clave natural>');
  process.exit(2);
}
const target = args.to;
const key = args.key;

try {
  if (section.kind === 'flat') {
    if (target !== 'published' && target !== 'draft' && target !== 'archived') {
      console.error('ERROR: --to debe ser published | draft | archived');
      process.exit(2);
    }
    const { result, contentVersion } = await withContentDb((db) =>
      setStatus(db, section.name, key, target),
    );
    console.log(`${result.key}: ${result.previous} → ${result.current} token=${result.token}`);
    console.log(
      contentVersion === null
        ? 'Sin cambios (ya estaba en ese estado).'
        : `contentVersion → ${String(contentVersion)}.`,
    );
  } else {
    if (!(editorialDocStatuses as readonly string[]).includes(target)) {
      console.error(`ERROR: --to debe ser uno de: ${editorialDocStatuses.join(' | ')}`);
      process.exit(2);
    }
    const { result, editorialVersion } = await withContentDb((db) =>
      setEditorialStatus(db, section.name, key, target as EditorialDocStatus),
    );
    console.log(`${result.id}: ${result.previous} → ${result.current}`);
    for (const w of result.warnings) console.log(`  ⚠ ${w}`);
    console.log(
      editorialVersion === null
        ? 'Sin cambios (ya estaba en ese estado).'
        : `editorialVersion → ${String(editorialVersion)}.`,
    );
  }
} catch (err) {
  if (err instanceof ContentWriteError || err instanceof EditorialWriteError) {
    console.error(`ERROR: ${err.message}`);
    for (const d of err.details) console.error(`  - ${d}`);
    process.exit(1);
  }
  throw err;
}
