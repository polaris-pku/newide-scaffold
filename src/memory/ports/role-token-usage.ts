/**
 * 角色用量取数口（只读）
 *
 * Agent Board 要显示「这个角色累计花了多少 token」，而这个数的**持久真相在用量账本
 * 里**（`token_usage_ledger`），不在 `AgentMetrics` 里：`metrics.token_cost_total` 只有
 * 种子把它初始化成 0，全仓没有任何写入方——`updateMetrics` 的调用点只碰
 * `avg_confidence` / 任务计数 / 退休态（`services/{feedback,metrics,usage-feedback,
 * retirement-detection,memory-writer}.ts`）。账本按 `(run_id, role_id, source, metric)`
 * 记每一条腿，主键前缀就是 `role_id`，所以「按角色求和」本来就是它支持的查询
 * （`TokenUsageLedgerScope` 里的 `role`）。
 *
 * 为什么这里只声明一个取数口，而不是让 memory 直接 import persistence：memory 这一层
 * 至今不依赖 persistence（账本与 SQLite 都在那一层）。装配点（app 层）把账本接上来，
 * 这层只认这个形状，也就没有多出一条跨层依赖。
 *
 * **只读，且刻意不做读-改-写**：`memory_agents.metrics` 是整块 JSONB 覆盖写
 * （`SET metrics = $2::jsonb`），两个角色并发就会静默丢一次自增——账本选「只追加、不维护
 * 可变总数」正是为了绕开它（见 `persistence/token-usage-ledger.ts` 的文件注释）。把累计
 * 值写回档案等于把那个失效模式请回来，所以这里只求和不落库。
 */
export interface RoleTokenUsageReader {
  /**
   * 该角色在账本上的**计费 token 合计**（各腿相加，与 run 的 `token_usage.total_tokens`
   * 同口径）。
   *
   * 返回 `undefined` 表示**取不到**——装配点没接账本，或账本里没有这个角色的行。
   * 与「花了 0」是两件事：调用方据此决定保留原值还是覆盖，绝不把缺席折算成 0。判据同
   * `LedgerRunUsageHistoryReader.readRun` 的「缺 ≠ 0」——那里也是看「到底有没有腿」，
   * 而不是看 `runs_counted`。
   *
   * 这个数是**下界**，不是精确值，两处系统性少计：
   * - `role_id` 为空的未归属行（回填出的 proxy 腿一律如此，因为 summary 里的 proxy 腿
   *   没有角色细分）不属于任何角色；
   * - 失败 run 缺掉的 driver 计费腿——`mergeBilledTokenUsage` 以 `worktree_path` 为前置
   *   门槛，失败 run 的 summary 没有该字段，于是 `driver_billed_merge` 报
   *   `skipped_no_worktree`，那条腿整条不进账本。
   *
   * 精确性条件见 `TokenUsageLedgerAggregate.complete`（`role` scope 下它只能是保守的）。
   */
  totalBilledTokens(roleId: string): number | undefined;
}
