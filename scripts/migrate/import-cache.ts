/**
 * Migración inicial: carga content-cache.json a carrito_content.
 *
 * Uso:
 *   npx tsx scripts/migrate/import-cache.ts [--file ruta] [--dry-run] [--verify|--no-verify] [--force]
 *
 * - Idempotente: una segunda corrida sin cambios en el archivo no modifica nada.
 * - Preflight único (forma + semántica + sanitización) para dry-run e importación.
 * - Gate de sanitización: si sanitizar el HTML embebido cambia algo, aborta
 *   (con --force importa la versión sanitizada y lo reporta).
 * - --dry-run: ejecuta el mismo preflight y reporta sin escribir.
 * - --verify (default): tras importar, compara MongoDB contra el archivo.
 *   Usa --no-verify solo en escenarios operativos excepcionales.
 *
 * Rollback documentado (plan F1): drop de carrito_content + re-import.
 */
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import { loadConfig } from '../../src/shared/config/env.js';
import {
  importCache,
  preflightCache,
  verifyCache,
} from '../../src/modules/content/content-import.js';
import { htmlDataFields } from '../../src/modules/content/content.schemas.js';
import type { ContentCache } from '../../src/modules/content/content.types.js';

const { values: args } = parseArgs({
  allowNegative: true,
  options: {
    file: { type: 'string', default: 'content-cache.json' },
    'dry-run': { type: 'boolean', default: false },
    verify: { type: 'boolean', default: true },
    force: { type: 'boolean', default: false },
  },
});

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

const raw: unknown = JSON.parse(await readFile(args.file, 'utf8'));
const { cache, errors, sanitizationChanges: changes } = preflightCache(raw);
if (cache === null) {
  console.error(`El archivo ${args.file} no cumple el contrato (forma/semántica):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

if (changes.length > 0) {
  console.error(`La sanitización modificaría ${String(changes.length)} campo(s):`);
  for (const ch of changes) console.error(`  - ${ch.itemKey}.${ch.field}`);
  if (!args.force) {
    fail(
      'se aborta para no alterar contenido en silencio (usa --force para importar la versión sanitizada)',
    );
  }
  console.error('--force: se importará la versión SANITIZADA de esos campos.');
  applySanitized(cache);
}

function applySanitized(target: ContentCache): void {
  const bySanitized = new Map(changes.map((ch) => [`${ch.itemKey}.${ch.field}`, ch.sanitized]));
  for (const item of target.items) {
    for (const field of htmlDataFields[item.collectionSlug] ?? []) {
      const key = `${item.collectionSlug}/${item.localeCode}/${item.slug}.${field}`;
      const sanitized = bySanitized.get(key);
      if (sanitized !== undefined) item.data[field] = sanitized;
    }
  }
}

const counts = {
  locales: cache.locales.length,
  settings: cache.settings.length,
  pages: cache.pages.length,
  texts: cache.texts.length,
  assets: cache.assets.length,
  collections: cache.collections.length,
  items: cache.items.length,
  versionTokens: cache.versionTokens.length,
};
console.log(`Archivo válido (${args.file}):`, JSON.stringify(counts));

if (args['dry-run']) {
  console.log('--dry-run: preflight OK, no se escribió nada.');
  process.exit(0);
}

const config = loadConfig();
const client = new MongoClient(config.MONGO_URI);
try {
  const db = client.db(config.MONGO_DB_CONTENT);

  const summary = await importCache(db, cache);
  console.log(`Importación a ${config.MONGO_DB_CONTENT}:`);
  for (const [section, s] of Object.entries(summary)) {
    console.log(
      `  ${section}: ${String(s.total)} (nuevos ${String(s.inserted)}, actualizados ${String(s.updated)}, sin cambios ${String(s.unchanged)})`,
    );
  }

  if (args.verify) {
    const result = await verifyCache(db, cache);
    if (!result.ok) {
      console.error('VERIFICACIÓN FALLIDA:');
      for (const d of result.diffs) console.error(`  - ${d}`);
      process.exit(1);
    }
    console.log('Verificación OK: MongoDB reproduce el archivo fuente registro a registro.');
  } else {
    console.warn('--no-verify: se omite la verificación post-importación.');
  }
} finally {
  await client.close();
}
