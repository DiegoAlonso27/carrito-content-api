import { loadConfig } from '../../src/shared/config/env.js';
import type { AppConfig } from '../../src/shared/config/env.js';

/** Config de pruebas: sin .env, valores explícitos y sobreescribibles. */
export function makeTestConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    ...overrides,
  });
}
