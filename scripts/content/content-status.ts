/**
 * Estado editorial del contenido.
 *
 * Uso:
 *   npx tsx scripts/content/content-status.ts             # resumen global
 *   npx tsx scripts/content/content-status.ts --section items [--status draft]
 */
import { parseArgs } from 'node:util';
import { sections, statusSummary } from '../../src/modules/content/content-write.service.js';
import { formatToken } from '../../src/modules/content/content.mappers.js';
import { parseSection, withContentDb } from './cli-helpers.js';

const { values: args } = parseArgs({
  options: {
    section: { type: 'string' },
    status: { type: 'string' },
  },
});

if (args.section === undefined) {
  const summary = await withContentDb((db) => statusSummary(db));
  console.log(
    `contentVersion=${String(summary.contentVersion)} próximoToken=${formatToken(summary.tokenSeq)}`,
  );
  for (const s of summary.sections) {
    const detail = Object.entries(s.byStatus)
      .map(([status, n]) => `${status}:${String(n)}`)
      .join(' ');
    console.log(`  ${s.section.padEnd(12)} total=${String(s.total).padEnd(4)} ${detail}`);
  }
} else {
  const section = parseSection(args.section);
  const spec = sections[section];
  const docs = await withContentDb((db) =>
    db
      .collection(spec.collection)
      .find(args.status !== undefined ? { status: args.status } : {})
      .toArray(),
  );
  for (const d of docs) {
    const key = spec.keyFields.map((f) => String(d[f])).join('/');
    const updated = d['updatedAt'] instanceof Date ? d['updatedAt'].toISOString() : '?';
    console.log(
      `${String(d['status']).padEnd(10)} ${key.padEnd(60)} token=${formatToken(d['revision'] as number)} updated=${updated}`,
    );
  }
  console.log(`${String(docs.length)} registro(s).`);
}
