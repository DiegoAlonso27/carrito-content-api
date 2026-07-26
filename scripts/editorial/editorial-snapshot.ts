/**
 * Publica, lista o revierte snapshots editoriales (export v2).
 *
 * Uso:
 *   npx tsx scripts/editorial/editorial-snapshot.ts --list [--locale es-PE]
 *   npx tsx scripts/editorial/editorial-snapshot.ts --publish --locale es-PE --operator "nombre" --reason "motivo" [--dry-run]
 *   npx tsx scripts/editorial/editorial-snapshot.ts --rollback v3 --locale es-PE --operator "nombre" --reason "motivo"
 *
 * Publicar construye, valida y firma el snapshot; si algo no cuadra (hash
 * inconsistente, referencia faltante, identidad duplicada, schema incompatible)
 * no se escribe nada. Revertir activa una versión anterior ya validada, tras
 * recalcular sus hashes.
 */
import { parseArgs } from 'node:util';
import {
  SnapshotPublishError,
  listEditorialSnapshots,
  publishEditorialSnapshot,
  rollbackEditorialSnapshot,
} from '../../src/modules/editorial/editorial-snapshot.service.js';
import { withContentDb } from '../content/cli-helpers.js';

const { values: args } = parseArgs({
  options: {
    locale: { type: 'string', default: 'es-PE' },
    publish: { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    rollback: { type: 'string' },
    operator: { type: 'string' },
    reason: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const locale = args.locale ?? 'es-PE';
const actions = [args.publish, args.list, args.rollback !== undefined].filter(Boolean).length;
if (actions !== 1) {
  console.error('ERROR: elige exactamente una acción: --publish | --list | --rollback <versión>');
  process.exit(2);
}

/** Publicar y revertir son actos de operación: exigen responsable y motivo. */
function requireAudit(): { operator: string; reason: string } {
  if (args.operator === undefined || args.operator.trim().length === 0) {
    console.error('ERROR: falta --operator "quién ejecuta la operación"');
    process.exit(2);
  }
  if (args.reason === undefined || args.reason.trim().length === 0) {
    console.error('ERROR: falta --reason "por qué"');
    process.exit(2);
  }
  return { operator: args.operator, reason: args.reason };
}

try {
  if (args.list) {
    const snapshots = await withContentDb((db) => listEditorialSnapshots(db, locale));
    if (snapshots.length === 0) {
      console.log(`Sin snapshots para '${locale}'.`);
    }
    for (const s of snapshots) {
      const mark = s.state === 'active' ? '● activo    ' : '· superseded';
      console.log(
        `${mark} ${s.version.padEnd(6)} ${s.generatedAtUtc}  docs=${String(s.documentCount).padEnd(4)} ` +
          `sha256=${s.checksum.slice(0, 12)}…  por=${s.activatedBy ?? '—'}`,
      );
      if (s.activationReason !== null) console.log(`               motivo: ${s.activationReason}`);
    }
  } else if (args.publish) {
    const audit = requireAudit();
    const result = await withContentDb((db) =>
      publishEditorialSnapshot(db, { locale, ...audit, dryRun: args['dry-run'] }),
    );
    console.log(`${result.dryRun ? '[dry-run] ' : ''}snapshot ${locale} ${result.version}`);
    console.log(`  documentos: ${String(result.documentCount)} (destinos: ${String(result.destinationCount)})`);
    console.log(`  checksum:   sha256:${result.checksum}`);
    console.log(`  etag:       ${result.etag}`);
    for (const w of result.warnings) console.log(`  ⚠ ${w}`);
    if (result.pruned.length > 0) {
      console.log(`  retención: se descartaron ${result.pruned.join(', ')}`);
    }
    if (result.dryRun) console.log('  no se escribió nada.');
  } else if (args.rollback !== undefined) {
    const audit = requireAudit();
    const result = await withContentDb((db) =>
      rollbackEditorialSnapshot(db, { locale, version: args.rollback as string, ...audit }),
    );
    console.log(
      result.previousVersion === null
        ? `${result.version} ya era el snapshot activo de '${locale}'.`
        : `rollback ${locale}: ${result.previousVersion} → ${result.version}`,
    );
    console.log(`  checksum: sha256:${result.checksum}`);
    console.log(`  etag:     ${result.etag}`);
  }
} catch (err) {
  if (err instanceof SnapshotPublishError) {
    console.error(`ERROR: ${err.message}`);
    for (const d of err.details) console.error(`  - ${d}`);
    process.exit(1);
  }
  throw err;
}
