/**
 * Crea o actualiza contenido editorial.
 *
 * Uso:
 *   npx tsx scripts/content/content-set.ts --section <sección> --file cambios.json [--publish]
 *
 * - <sección> flat: locales | settings | pages | texts | assets | collections | items
 * - <sección> por bloques: localities | destinations | boarding-points | services | amenities
 * - cambios.json: un registro o un array de registros con la MISMA forma del
 *   contrato (para items: sin rowVersionToken; se deriva de la revisión).
 * - Los registros nuevos nacen en `draft`; publicar es explícito (--publish
 *   o content-publish.ts). En el modelo por bloques, `--publish` valida el
 *   DOCUMENTO COMPLETO y falla si algún bloque es inválido.
 * - Valida esquema por colección, sanitiza HTML (reporta si lo modifica),
 *   asigna token nuevo e incrementa la versión solo si hubo cambios.
 */
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { ContentWriteError, setRecords } from '../../src/modules/content/content-write.js';
import {
  EditorialWriteError,
  setEditorialRecords,
} from '../../src/modules/editorial/editorial-write.js';
import { parseAnySection, withContentDb } from './cli-helpers.js';

const { values: args } = parseArgs({
  options: {
    section: { type: 'string' },
    file: { type: 'string' },
    publish: { type: 'boolean', default: false },
  },
});

const section = parseAnySection(args.section);
if (args.file === undefined) {
  console.error('ERROR: falta --file <ruta.json>');
  process.exit(2);
}

const parsed: unknown = JSON.parse(await readFile(args.file, 'utf8'));
const records = Array.isArray(parsed) ? (parsed as unknown[]) : [parsed];

function reportFailure(message: string, details: string[]): never {
  console.error(`ERROR: ${message}`);
  for (const d of details) console.error(`  - ${d}`);
  process.exit(1);
}

try {
  if (section.kind === 'flat') {
    const { results, contentVersion } = await withContentDb((db) =>
      setRecords(db, section.name, records, { publish: args.publish }),
    );
    for (const r of results) {
      const sanitized =
        r.sanitizedFields.length > 0
          ? `  ⚠ HTML sanitizado en: ${r.sanitizedFields.join(', ')}`
          : '';
      console.log(`${r.action.padEnd(9)} ${r.key} [${r.status}] token=${r.token}${sanitized}`);
    }
    console.log(
      contentVersion === null
        ? 'Sin cambios: contentVersion no se modificó.'
        : `contentVersion → ${String(contentVersion)} (cachés y ETag invalidados).`,
    );
  } else {
    const { results, editorialVersion } = await withContentDb((db) =>
      setEditorialRecords(db, section.name, records, { publish: args.publish }),
    );
    for (const r of results) {
      const sanitized =
        r.sanitizedFields.length > 0
          ? `  ⚠ HTML sanitizado en: ${r.sanitizedFields.join(', ')}`
          : '';
      console.log(`${r.action.padEnd(9)} ${r.id} [${r.status}]${sanitized}`);
      for (const w of r.warnings) console.log(`           ⚠ ${w}`);
    }
    console.log(
      editorialVersion === null
        ? 'Sin cambios: editorialVersion no se modificó.'
        : `editorialVersion → ${String(editorialVersion)}.`,
    );
  }
} catch (err) {
  if (err instanceof ContentWriteError || err instanceof EditorialWriteError) {
    reportFailure(err.message, err.details);
  }
  throw err;
}
