# Third-Party Notices — skills/ 第三方技能来源与授权

本目录是 `spec/skills/`（语料主源）在 newide-scaffold 内的**同步副本**，随仓库提交，
供 role agent 种子导入使用。目录内所有技能文件版权归其原作者/仓库所有；newide-scaffold
仅作只读资产携带与运行时导入，不修改其内容。

## 权威溯源位置（三处一致，以此为准）

1. **顶层 `README.md`**（同步自语料主源）：`授权说明` 段 + 「角色与数量」表 + 下载/蒸馏说明。
2. **各角色 `README.md` 的来源映射表**：目录 ↔ 来源仓库 ↔ 源路径 ↔ 状态（活动/指针/宿主）↔ LICENSE 说明。
3. **各 `SKILL.md` 文件内**：`## Provenance` 段或 `> Provenance:` 行（Source repo / Original path / License / 并入说明）。

## License 概况（2026-09-07 终态）

- 多数技能来自 MIT / Apache-2.0 许可仓库（如 jeremylongshore/claude-code-plugins-plus-skills、codexstar69/bug-hunter、trailofbits/skills、skydoves/compose-performance-skills、Tencent/AI-Infra-Guard、Cosmian/kms、mukul975/Anthropic-Cybersecurity-Skills 等）；
- 部分仓库未随附 LICENSE，按各文件 Provenance 标注 `unknown — see repo`；
- 使用时请核对**各技能文件内 Provenance 的原始仓库 LICENSE**；本副本不随附各仓库 LICENSE 全文。

## 本目录内的本地文件

- `THIRD-PARTY-NOTICES.md`（本文件）：**仅存在于 scaffold 侧**，sync-skills 镜像同步时保留、不覆盖不删除。
- `skill-manifest.baseline.json`：导入快照基线（66 个活动技能 slug/id/sha256），由 `pnpm seed:roles:baseline` 重写——内容哈希与语料副本联动，非第三方内容。
