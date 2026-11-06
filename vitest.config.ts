import { defineConfig } from 'vitest/config';
import 'dotenv/config';
export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 30000,
    env: {
      NODE_ENV: 'development',
      DEV_MOCK_LOGIN: 'true',
      DEMO_MODE: 'true',
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ||
        'postgres://fafa:fafa_dev_only@localhost:5432/fafa_test',
    },
  },
});
