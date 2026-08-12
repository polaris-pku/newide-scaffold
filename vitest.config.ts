import { configDefaults, defineConfig } from 'vitest/config';

/**
 * vitest 4 projects：
 * - 默认 project 跑全部测试（并行）。
 * - pg-serial project 只跑共享同一个 memory_test PG 库的集成测试，
 *   fileParallelism=false 避免 real-embedding-e2e / pg-file-integration 的
 *   afterAll DROP TABLE 与 real-agent-e2e 等并行时互相清库。
 */
const PG_SERIAL_INCLUDE = [
  'test/app/backend-rpc-postgres.test.ts',
  'src/memory/test/pg-memory-repository.test.ts',
  'src/memory/test/integration/full-e2e.test.ts',
  'src/memory/test/integration/pg-file-integration.test.ts',
  'src/memory/test/integration/real-agent-e2e.test.ts',
  'src/memory/test/integration/real-embedding-e2e.test.ts',
];

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      '**/.claude/worktrees/**',
      '**/.newide/**',
      '**/dist/**',
    ],
    projects: [
      {
        extends: true,
        test: {
          name: 'default',
          include: [
            'test/**/*.test.ts',
            'src/**/*.test.ts',
            'src/**/test/**/*.test.ts',
          ],
          // PG 集成测试独占给 pg-serial project，避免重复执行与并行清库冲突
          exclude: [...PG_SERIAL_INCLUDE],
        },
      },
      {
        extends: true,
        test: {
          name: 'pg-serial',
          include: PG_SERIAL_INCLUDE,
          fileParallelism: false,
        },
      },
    ],
  },
});
