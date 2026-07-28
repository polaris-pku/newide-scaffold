import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      '**/.claude/worktrees/**',
      // Merged from feat/mailbox-collaboration, not yet integrated. These tests
      // exercise a parallel mailbox stack that does not compile against current
      // mainline APIs. See src/mailbox-collab/INTEGRATION.md.
      'test/mailbox-collab/**',
    ],
  },
});
