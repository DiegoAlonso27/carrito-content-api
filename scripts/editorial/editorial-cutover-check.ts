/**
 * Informe de gates del corte de Track B (Fase 5). SOLO LECTURA.
 *
 * Uso:
 *   npx tsx scripts/editorial/editorial-cutover-check.ts [--locale es-PE]
 *
 * Ejecuta contra la base configurada (`.env` / `CARRITO_ENV_FILE`) los mismos
 * gates P0 del doc 11 que el ensayo automatizado
 * (`test/integration/editorial-cutover.test.ts`) comprueba sobre
 * `MongoMemoryReplSet`, y emite un informe verde/rojo por gate:
 *
 *   G1 integridad de datos · G2 separación destino/punto ·
 *   G3 publicación correcta · G4 rollback
 *
 * Sale con código 1 si algún gate P0 está en rojo; 0 si todos pasan (los avisos
 * no tumban el corte). No escribe nada: no crea colecciones ni índices, no
 * publica y no toca `editorialVersion` ni `contentVersion`. Reutiliza
 * `validateEditorialGraph`, `EditorialSnapshotRepo` / `listEditorialSnapshots` y
 * `verifySnapshotIntegrity`; aquí no vive ninguna regla de validación propia.
 */
import { parseArgs } from 'node:util';
import type { Db } from 'mongodb';
import { ContentRepo } from '../../src/modules/content/content.repo.js';
import { contentCollections } from '../../src/modules/content/content.collections.js';
import { EditorialRepo } from '../../src/modules/editorial/editorial.repo.js';
import {
  EditorialWriteError,
  validateEditorialGraph,
} from '../../src/modules/editorial/editorial-write.js';
import {
  checksumOf,
  verifySnapshotIntegrity,
} from '../../src/modules/editorial/editorial-snapshot.js';
import type { EditorialSnapshotBody } from '../../src/modules/editorial/editorial-snapshot.js';
import { EditorialSnapshotRepo } from '../../src/modules/editorial/editorial-snapshot.repo.js';
import { listEditorialSnapshots } from '../../src/modules/editorial/editorial-snapshot.service.js';
import { withContentDb } from '../content/cli-helpers.js';

const { values: args } = parseArgs({
  options: { locale: { type: 'string', default: 'es-PE' } },
});
const locale = args.locale ?? 'es-PE';

type Priority = 'P0' | 'aviso';

interface Gate {
  id: string;
  title: string;
  priority: Priority;
  failures: string[];
  facts: string[];
  warnings: string[];
}

function gate(id: string, title: string, priority: Priority = 'P0'): Gate {
  return { id, title, priority, failures: [], facts: [], warnings: [] };
}

interface CutoverFindings {
  database: string;
  gates: Gate[];
}

async function collectFindings(db: Db): Promise<CutoverFindings> {
  const editorialRepo = new EditorialRepo(db);
  const contentRepo = new ContentRepo(db);
  const snapshotRepo = new EditorialSnapshotRepo(db);

  const g1 = gate('G1', 'Integridad de datos');
  const g2 = gate('G2', 'Separación destino/punto');
  const g3 = gate('G3', 'Publicación correcta');
  const g4 = gate('G4', 'Rollback');

  const graph = await editorialRepo.loadGraph();
  const publishedDestinations = graph.destinations.filter((d) => d.status === 'published');
  const publishedServices = graph.services.filter((s) => s.status === 'published');

  // ── G1 · integridad de datos ──────────────────────────────────────────────
  const flatItems = await contentRepo.countDocuments(contentCollections.items);
  const flatAssets = await contentRepo.countDocuments(contentCollections.assets);
  const reviewQueueOpen = (await editorialRepo.listReviewQueue('open')).length;

  g1.facts.push(
    `editorial: ${String(graph.destinations.length)} destinos · ` +
      `${String(graph.localities.length)} localidades · ` +
      `${String(graph.services.length)} servicios · ` +
      `${String(graph.amenities.length)} comodidades · ` +
      `${String(graph.boardingPoints.length)} puntos`,
  );
  g1.facts.push(`origen flat intacto: ${String(flatItems)} items · ${String(flatAssets)} assets`);
  g1.facts.push(`cola de revisión abierta: ${String(reviewQueueOpen)}`);

  if (graph.destinations.length === 0) {
    g1.failures.push('no hay documentos editoriales: la migración no se ha ejecutado en esta base');
  }
  if (flatItems === 0) {
    g1.failures.push(
      'el origen flat (content_items) está vacío: el export del soft-launch no se puede reconstruir',
    );
  }

  const localityIds = new Set(graph.localities.map((l) => l.id));
  for (const d of graph.destinations) {
    if (!localityIds.has(d.localityId)) {
      g1.failures.push(`destino '${d.id}': su localidad '${d.localityId}' no existe`);
    }
  }
  const destinationIds = new Set(graph.destinations.map((d) => d.id));
  for (const d of graph.destinations) {
    if (d.parentId !== null && !destinationIds.has(d.parentId)) {
      g1.failures.push(`destino '${d.id}': su padre '${d.parentId}' no existe`);
    }
  }
  if (reviewQueueOpen > 0) {
    g1.warnings.push(
      `${String(reviewQueueOpen)} entradas abiertas en la cola de revisión: ` +
        'contenido no clasificado que NO entra al snapshot (no bloquea el corte)',
    );
  }

  // ── G2 · separación destino/punto ─────────────────────────────────────────
  g2.facts.push(`${String(graph.boardingPoints.length)} puntos de embarque, ninguno con página`);
  for (const point of graph.boardingPoints) {
    if (point.isDestination !== false) {
      g2.failures.push(`punto '${point.id}' con isDestination distinto de false`);
    }
    if (destinationIds.has(point.id)) {
      g2.failures.push(`'${point.id}' existe a la vez como punto de embarque y como destino`);
    }
  }
  const destinationSlugs = new Set(graph.destinations.map((d) => d.slug));
  for (const point of graph.boardingPoints) {
    if (destinationSlugs.has(point.slug)) {
      g2.failures.push(`el slug '${point.slug}' lo usan un punto de embarque y un destino`);
    }
  }
  const pendingPoints = graph.boardingPoints.filter((p) => p.status !== 'published');
  if (pendingPoints.length > 0) {
    g2.warnings.push(
      `${String(pendingPoints.length)} puntos sin publicar (dirección o localidad sin ` +
        'verificar, P-04/P-13): sus bloques `boarding-points` saldrán vacíos. Es la ' +
        'consecuencia asumida en la Fase 1, no un fallo del corte',
    );
  }

  // ── G3 · publicación correcta ─────────────────────────────────────────────
  const report = await validateEditorialGraph(db);
  const publishedIds = new Set(publishedDestinations.map((d) => d.id));
  const publishedServiceIds = new Set(publishedServices.map((s) => s.id));

  g3.facts.push(
    `publicados: ${String(publishedDestinations.length)}/${String(graph.destinations.length)} destinos · ` +
      `${String(publishedServices.length)}/${String(graph.services.length)} servicios`,
  );

  if (publishedDestinations.length === 0) {
    g3.failures.push('ningún destino está publicado: no hay nada que cortar');
  }
  for (const d of report.destinations) {
    if (d.errors.length === 0) continue;
    const scope = publishedIds.has(d.id) ? g3.failures : g3.warnings;
    const prefix = publishedIds.has(d.id) ? 'destino publicado' : 'destino sin publicar';
    for (const e of d.errors) scope.push(`${prefix} '${d.id}' (${d.canonicalUrl}): ${e}`);
  }
  for (const s of report.services) {
    if (s.errors.length === 0) continue;
    const scope = publishedServiceIds.has(s.id) ? g3.failures : g3.warnings;
    const prefix = publishedServiceIds.has(s.id) ? 'servicio publicado' : 'servicio sin publicar';
    for (const e of s.errors) scope.push(`${prefix} '${s.id}': ${e}`);
  }

  const canonicalSeen = new Map<string, string>();
  for (const d of report.destinations) {
    if (!publishedIds.has(d.id)) continue;
    const previous = canonicalSeen.get(d.canonicalUrl);
    if (previous !== undefined) {
      g3.failures.push(`URL canónica duplicada '${d.canonicalUrl}': '${previous}' y '${d.id}'`);
    }
    canonicalSeen.set(d.canonicalUrl, d.id);
  }

  const totalWarnings = report.destinations.reduce((n, d) => n + d.warnings.length, 0);
  if (totalWarnings > 0) {
    g3.warnings.push(
      `${String(totalWarnings)} avisos de validación (medios sin derechos verificados, ` +
        'referencias no publicadas): ese contenido se excluye del snapshot',
    );
  }

  const active = await snapshotRepo.findActive(locale);
  if (active === null) {
    g3.failures.push(`no hay snapshot activo del locale '${locale}': el front no tendría contenido`);
  } else {
    g3.facts.push(
      `snapshot activo ${active.version} · ${String(active.documentCount)} documentos · ` +
        `sha256=${active.checksum.slice(0, 12)}… · etag=${active.etag}`,
    );
    const body = parseSnapshot(active.body);
    if (body === null) {
      g3.failures.push(`el snapshot activo ${active.version} no es JSON válido`);
    } else {
      for (const problem of verifySnapshotIntegrity(body)) {
        g3.failures.push(`snapshot activo ${active.version}: ${problem}`);
      }
      if (checksumOf(body) !== active.checksum) {
        g3.failures.push(
          `snapshot activo ${active.version}: el checksum almacenado no coincide con el recalculado`,
        );
      }
      if (body.boardingPoints.length > 0) {
        g2.facts.push(
          `${String(body.boardingPoints.length)} puntos publicados presentes en el snapshot`,
        );
      }
      const snapshotDestinationIds = new Set(body.destinations.map((d) => String(d['id'])));
      for (const point of body.boardingPoints) {
        if (snapshotDestinationIds.has(String(point['id']))) {
          g2.failures.push(
            `el snapshot sirve '${String(point['id'])}' como punto y como destino a la vez`,
          );
        }
      }
      if (body.destinations.length !== publishedDestinations.length) {
        g3.warnings.push(
          `el snapshot activo trae ${String(body.destinations.length)} destinos y la base tiene ` +
            `${String(publishedDestinations.length)} publicados: o hay un rollback activo o falta ` +
            'volver a publicar el snapshot',
        );
      }
    }
  }

  // ── G4 · rollback ─────────────────────────────────────────────────────────
  const snapshots = await listEditorialSnapshots(db, locale);
  g4.facts.push(
    snapshots.length === 0
      ? `sin snapshots almacenados para '${locale}'`
      : `versiones almacenadas: ${snapshots.map((s) => s.version).join(', ')}`,
  );

  if (active === null) {
    g4.failures.push('sin snapshot activo no hay artefacto de referencia al que volver');
  }

  for (const summary of snapshots) {
    const stored = await snapshotRepo.findByVersion(locale, summary.version);
    const body = stored === null ? null : parseSnapshot(stored.body);
    if (body === null) {
      g4.failures.push(`${summary.version}: cuerpo ilegible, no se podría activar`);
      continue;
    }
    const problems = verifySnapshotIntegrity(body);
    if (problems.length > 0) {
      g4.failures.push(
        `${summary.version}: no supera la verificación de integridad (${problems[0] ?? ''}): ` +
          'no se puede revertir a esa versión',
      );
    }
  }

  const rollbackTargets = snapshots.filter((s) => s.state !== 'active');
  if (rollbackTargets.length === 0) {
    g4.warnings.push(
      'no hay versión anterior a la activa: en el PRIMER corte el rollback del contenido ' +
        'editorial es desactivar nav-destinos/nav-servicios y volver al build anterior ' +
        '(ver runbook, "Corte de Track B")',
    );
  } else {
    g4.facts.push(
      `versión a la que se puede revertir de inmediato: ${rollbackTargets[0]?.version ?? '—'}`,
    );
  }

  return { database: db.databaseName, gates: [g1, g2, g3, g4] };
}

function parseSnapshot(body: string): EditorialSnapshotBody | null {
  try {
    return JSON.parse(body) as EditorialSnapshotBody;
  } catch {
    return null;
  }
}

function printReport(findings: CutoverFindings): boolean {
  console.log(`Informe de gates · corte de Track B — locale '${locale}'`);
  console.log(`Base: ${findings.database} (solo lectura: este comando no escribe nada)\n`);

  let allGreen = true;
  for (const g of findings.gates) {
    const green = g.failures.length === 0;
    if (!green && g.priority === 'P0') allGreen = false;
    console.log(`${green ? '✓ VERDE' : '✗ ROJO '}  ${g.priority}  ${g.id} · ${g.title}`);
    for (const fact of g.facts) console.log(`         · ${fact}`);
    for (const failure of g.failures) console.log(`         ✗ ${failure}`);
    for (const warning of g.warnings) console.log(`         ⚠ ${warning}`);
    console.log('');
  }

  console.log(
    allGreen
      ? 'RESULTADO: todos los gates P0 en verde. El corte puede proceder según el runbook.'
      : 'RESULTADO: hay gates P0 en rojo. NO ejecutar el corte hasta resolverlos.',
  );
  return allGreen;
}

try {
  const findings = await withContentDb(collectFindings);
  if (!printReport(findings)) process.exit(1);
} catch (err) {
  if (err instanceof EditorialWriteError) {
    console.error(`✗ ROJO  P0  G0 · No se pudo evaluar el grafo editorial: ${err.message}`);
    for (const d of err.details) console.error(`         - ${d}`);
    process.exit(1);
  }
  throw err;
}
