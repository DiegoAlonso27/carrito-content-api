/**
 * Genera content-cache.json localmente desde MongoDB (mismo builder que el
 * endpoint /v1/export/content-cache), en el formato pretty del pipeline
 * original (2 espacios + newline final) para diffs limpios.
 *
 * Uso:
 *   npx tsx scripts/content/content-export.ts [--out content-cache.generated.json]
 */
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { ExportService } from '../../src/modules/export/export.service.js';
import { withContentDb } from './cli-helpers.js';

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: 'content-cache.generated.json' },
  },
});

const snapshot = await withContentDb((db) => new ExportService(db).get());
const pretty = JSON.stringify(JSON.parse(snapshot.body), null, 2) + '\n';
await writeFile(args.out, pretty, 'utf8');
console.log(
  `Export escrito en ${args.out} (${String(pretty.length)} bytes, etag=${snapshot.etag}, generatedAtUtc=${snapshot.generatedAtUtc}).`,
);
