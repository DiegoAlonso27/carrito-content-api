/**
 * Valida todo el grafo editorial sin escribir nada.
 *
 * Uso:
 *   npx tsx scripts/editorial/editorial-validate.ts [--only-errors]
 *
 * Es el insumo del ensayo de migración (Fase 5): responde qué documentos son
 * publicables hoy y qué falta en los que no lo son.
 * Sale con código 1 si hay errores, para poder usarlo como gate.
 */
import { parseArgs } from 'node:util';
import { validateEditorialGraph } from '../../src/modules/editorial/editorial-write.js';
import { editorialStatusSummary } from '../../src/modules/editorial/editorial-write.js';
import { withContentDb } from '../content/cli-helpers.js';

const { values: args } = parseArgs({
  options: { 'only-errors': { type: 'boolean', default: false } },
});

const onlyErrors = args['only-errors'];

const { report, summary } = await withContentDb(async (db) => ({
  report: await validateEditorialGraph(db),
  summary: await editorialStatusSummary(db),
}));

console.log('— Estado por sección —');
for (const s of summary.sections) {
  const detail = Object.entries(s.byStatus)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ');
  console.log(`  ${s.section.padEnd(16)} total=${String(s.total).padEnd(4)} ${detail}`);
}
console.log(`  cola de revisión abierta: ${String(summary.reviewQueueOpen)}`);

console.log('\n— Destinos —');
for (const d of report.destinations) {
  if (onlyErrors && d.errors.length === 0) continue;
  const mark = d.errors.length === 0 ? '✓' : '✗';
  console.log(`  ${mark} ${d.id.padEnd(18)} ${d.canonicalUrl}`);
  for (const e of d.errors) console.log(`      error   ${e}`);
  if (!onlyErrors) for (const w of d.warnings) console.log(`      aviso   ${w}`);
}

console.log('\n— Servicios —');
for (const s of report.services) {
  if (onlyErrors && s.errors.length === 0) continue;
  console.log(`  ${s.errors.length === 0 ? '✓' : '✗'} ${s.id}`);
  for (const e of s.errors) console.log(`      error   ${e}`);
  if (!onlyErrors) for (const w of s.warnings) console.log(`      aviso   ${w}`);
}

console.log('\n— Puntos de embarque —');
for (const p of report.boardingPoints) {
  if (onlyErrors && p.errors.length === 0) continue;
  console.log(`  ${p.errors.length === 0 ? '✓ publicable' : '· en validación'} ${p.id}`);
  for (const e of p.errors) console.log(`      ${e}`);
}

const publishable = report.destinations.filter((d) => d.errors.length === 0).length;
console.log(
  `\nDestinos publicables: ${String(publishable)}/${String(report.destinations.length)} · ` +
    `errores totales: ${String(report.totalErrors)}`,
);

if (report.totalErrors > 0) process.exit(1);
