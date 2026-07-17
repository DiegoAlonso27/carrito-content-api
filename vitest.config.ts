import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // mongodb-memory-server descarga el binario de mongod en la primera
    // ejecución (dev y CI): los hooks necesitan margen amplio.
    hookTimeout: 120_000,
    testTimeout: 15_000,
  },
});
