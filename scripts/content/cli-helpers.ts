import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/shared/config/env.js';
import { sections } from '../../src/modules/content/content-write.js';
import type { SectionName } from '../../src/modules/content/content-write.js';

/** Conexión de los CLIs editoriales (usa la config/.env local). */
export async function withContentDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const config = loadConfig();
  const client = new MongoClient(config.MONGO_URI);
  try {
    return await fn(client.db(config.MONGO_DB_CONTENT));
  } finally {
    await client.close();
  }
}

export function parseSection(value: string | undefined): SectionName {
  if (value !== undefined && value in sections) return value as SectionName;
  console.error(
    `ERROR: --section debe ser uno de: ${Object.keys(sections).join(', ')} (recibido: ${value ?? '(vacío)'})`,
  );
  process.exit(2);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Rutas del golden canónico y su copia contractual (inmutables vía CLI). */
export function forbiddenExportOutPaths(root = repoRoot): string[] {
  return [
    path.normalize(path.join(root, 'content-cache.json')),
    path.normalize(path.join(root, 'test', 'contract', 'golden', 'content-cache.json')),
  ];
}

/**
 * Rechaza destinos que sobrescribirían el golden (AGENTS.md / ADR-004).
 * @returns mensaje de error o null si la ruta es segura.
 */
export function exportOutPathError(
  out: string,
  cwd = process.cwd(),
  root = repoRoot,
): string | null {
  const resolved = path.normalize(path.resolve(cwd, out));
  if (forbiddenExportOutPaths(root).includes(resolved)) {
    const rel = path.relative(root, resolved) || 'content-cache.json';
    return (
      `--out no puede sobrescribir el golden canónico (${rel}). ` +
      'Usa otra ruta (p. ej. content-cache.generated.json).'
    );
  }
  return null;
}
