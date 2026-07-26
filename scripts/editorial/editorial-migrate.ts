/**
 * Migra el contenido flat al modelo editorial por bloques.
 *
 * Uso:
 *   npx tsx scripts/editorial/editorial-migrate.ts --catalog <catalogo-localidades.anotado.json> [--dry-run]
 *
 * - `--catalog` es el catálogo ANOTADO de la Fase 1 (el catálogo entregado no
 *   se usa como insumo directo: no lleva las decisiones aprobadas).
 * - `--dry-run` imprime el reporte sin escribir nada.
 * - No borra el origen: `content_items` queda intacto.
 * - No publica: todo entra en `review`/`draft`.
 */
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { parseAnnotatedCatalog } from '../../src/modules/editorial/editorial.catalog.js';
import {
  applyMigrationPlan,
  buildMigrationPlan,
  loadMigrationInput,
} from '../../src/modules/editorial/editorial-migrate.js';
import { withContentDb } from '../content/cli-helpers.js';

const { values: args } = parseArgs({
  options: {
    catalog: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

if (args.catalog === undefined) {
  console.error('ERROR: falta --catalog <ruta al catalogo-localidades.anotado.json>');
  process.exit(2);
}

const raw: unknown = JSON.parse(await readFile(args.catalog, 'utf8'));
const { catalog, errors } = parseAnnotatedCatalog(raw);
if (catalog === null) {
  console.error('ERROR: el catálogo anotado no es válido');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const dryRun = args['dry-run'];

await withContentDb(async (db) => {
  const input = await loadMigrationInput(db, catalog);
  const plan = buildMigrationPlan(input);
  const r = plan.report;

  console.log('— Origen —');
  for (const [k, v] of Object.entries(r.sourceCounts)) console.log(`  ${k}: ${String(v)}`);

  console.log('\n— Destinos —');
  console.log(`  con guía editorial (${String(r.destinationsFromGuide.length)}): ${r.destinationsFromGuide.join(', ')}`);
  console.log(`  contenido mínimo del catálogo (${String(r.destinationsGenerated.length)}): ${r.destinationsGenerated.join(', ')}`);

  console.log('\n— Servicios —');
  console.log(`  creados: ${r.servicesCreated.join(', ')}`);

  console.log('\n— No clasificable (cola de revisión) —');
  for (const u of r.unclassified) console.log(`  ${u.sourceKey}: ${u.reason}`);

  console.log('\n— Deriva catálogo ⇄ base —');
  console.log(`  solo en catálogo: ${r.drift.onlyInCatalog.length === 0 ? '(ninguno)' : r.drift.onlyInCatalog.join(', ')}`);
  console.log(`  solo en base: ${r.drift.onlyInDatabase.length === 0 ? '(ninguno)' : r.drift.onlyInDatabase.join(', ')}`);

  if (dryRun) {
    console.log('\n--dry-run: no se escribió nada.');
    return;
  }

  const outcome = await applyMigrationPlan(db, plan);
  console.log('\n— Escrito —');
  for (const [k, v] of Object.entries(outcome.written)) console.log(`  ${k}: ${String(v)}`);
  console.log(`  cola de revisión abierta: ${String(outcome.reviewQueueOpen)}`);
  console.log(
    outcome.editorialVersion === null
      ? '  editorialVersion sin cambios.'
      : `  editorialVersion → ${String(outcome.editorialVersion)}.`,
  );
  console.log('\nNada se publicó: usa content:publish por documento tras revisar.');
});
