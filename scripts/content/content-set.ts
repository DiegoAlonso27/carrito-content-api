/**
 * Crea o actualiza contenido editorial.
 *
 * Uso:
 *   npx tsx scripts/content/content-set.ts --section <sección> --file cambios.json [--publish]
 *
 * - <sección>: locales | settings | pages | texts | assets | collections | items
 * - cambios.json: un registro o un array de registros con la MISMA forma del
 *   contrato (para items: sin rowVersionToken; se deriva de la revisión).
 * - Los registros nuevos nacen en `draft`; publicar es explícito (--publish
 *   o content-publish.ts).
 * - Valida esquema por colección, sanitiza HTML (reporta si lo modifica),
 *   asigna token nuevo e incrementa contentVersion solo si hubo cambios.
 */
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { ContentWriteError, setRecords } from '../../src/modules/content/content-write.service.js';
import { parseSection, withContentDb } from './cli-helpers.js';

const { values: args } = parseArgs({
  options: {
    section: { type: 'string' },
    file: { type: 'string' },
    publish: { type: 'boolean', default: false },
  },
});

const section = parseSection(args.section);
if (args.file === undefined) {
  console.error('ERROR: falta --file <ruta.json>');
  process.exit(2);
}

const parsed: unknown = JSON.parse(await readFile(args.file, 'utf8'));
const records = Array.isArray(parsed) ? (parsed as unknown[]) : [parsed];

try {
  const { results, contentVersion } = await withContentDb((db) =>
    setRecords(db, section, records, { publish: args.publish }),
  );
  for (const r of results) {
    const sanitized =
      r.sanitizedFields.length > 0 ? `  ⚠ HTML sanitizado en: ${r.sanitizedFields.join(', ')}` : '';
    console.log(`${r.action.padEnd(9)} ${r.key} [${r.status}] token=${r.token}${sanitized}`);
  }
  console.log(
    contentVersion === null
      ? 'Sin cambios: contentVersion no se modificó.'
      : `contentVersion → ${String(contentVersion)} (cachés y ETag invalidados).`,
  );
} catch (err) {
  if (err instanceof ContentWriteError) {
    console.error(`ERROR: ${err.message}`);
    for (const d of err.details) console.error(`  - ${d}`);
    process.exit(1);
  }
  throw err;
}
