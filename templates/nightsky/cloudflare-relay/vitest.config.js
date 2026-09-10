import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
export default defineConfig({plugins:[cloudflareTest({wrangler:{configPath:'./wrangler.jsonc'},miniflare:{bindings:{RELAY_TOKEN:'test-only-capability-0123456789abcdef',RELAY_AUTH_EPOCH:'test-v1'}}})],test:{testTimeout:10000,hookTimeout:10000}});
