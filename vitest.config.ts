import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/unit/**/*.test.ts'],
    // Blocks every outbound connection except loopback, so no test can reach AWS.
    setupFiles: ['tests/setup/no-network.ts'],
    restoreMocks: true
  }
})
