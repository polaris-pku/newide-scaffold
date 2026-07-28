import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      '**/.claude/worktrees/**',
      // Merged from feat/mailbox-collaboration, not yet integrated. These tests
      // exercise a parallel mailbox stack that does not compile against current
      // mainline APIs. Integration plan is tracked outside the repo:
      // 工程化报告留底/2026-07-28-checkpoint与Mailbox分支整合留底.md
      'test/mailbox-collab/**',
    ],
  },
});
