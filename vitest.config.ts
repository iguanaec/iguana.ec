import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            GEMINI_API_KEY: 'test-key',
            META_APP_ID: 'app-123',
            META_APP_SECRET: 'app-secret',
            META_VERIFY_TOKEN: 'verify-me',
            ENCRYPTION_KEY: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
            BOOTSTRAP_TOKEN: 'boot-token',
            BURST_WINDOW_MS: '50',
          },
        },
      }),
    ],
    test: { setupFiles: ['./test/setup.ts'] },
  };
});
