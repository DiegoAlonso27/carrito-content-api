/** Extrae nombres desde la salida no tipada de listIndexes del driver Mongo. */
export function listedIndexNames(value: unknown): Set<string> {
  const names = new Set<string>();
  if (!Array.isArray(value)) return names;
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null || !('name' in item)) continue;
    if (typeof item.name === 'string') names.add(item.name);
  }
  return names;
}
