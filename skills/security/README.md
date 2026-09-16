# security 角色 skills

> 状态：2026-09-07 完成维度重构（蓝图：`spec/docs/skills-角色维度重构蓝图.md`），同日另下载并入 13 个新技能（扩展提案：4 个平台/领域专项 + 9 个 Agent 检测家族补全）。**2026-09-11 修正**：移除 `container-security-auditor`（2.4KB 空壳，全文是"provides automated assistance for container security auditor tasks"的自我指涉模板，零容器/镜像/registry 内容）；从 `security-audit-owasp` 剥离 Reliability 渗漏（部署回滚/健康检查/上线编排——发布门禁属 reliability）；修正 `owasp-asi` 的边界说明（原文称上游 10 个 detection 技能"本语料仅收录 1 个"，实际 10 个全部在册）；修正 `threat-model-generator` 的假阳性启发式（原用 `/process\.env\./` 判"硬编码密钥"——读环境变量恰是正确做法）。现 23 个目录，全部为独立技能、无指针。角色内分六个显式子分区：①全量审计与变更门（code-security-audit 内含 anthropic 官方适配件内容；security-audit-owasp 专攻安全变更/部署门/OWASP 清单）②领域专项族（auth / input-validation / secrets / threat-model——各为全量审计清单的领域特化，按触发词单独使用）③方法论（audit-context-building、supply-chain-risk-auditor）④**Agent 安全子分区**（owasp-asi 分类 + 检测家族：direct-injection-detection 原收录，2026-09-07 补全 9 个检测技能——indirect-injection/tool-abuse/authorization-bypass/data-leakage/agentic-supply-chain/unexpected-code-execution/inter-agent-comm-security/cascading-failure/human-agent-trust-exploit）⑤红队（offensive-api-security，仅授权渗透）⑥**平台/领域专项**（密码学/云-IaC/移动；容器已于 2026-09-11 移除）。下表为来源映射（目录 ↔ 来源仓库 ↔ 源路径）；各技能正文自足，不再互指。

| 目录 | 来源仓库 | 源路径 | 状态 | 说明 |
|---|---|---|---|---|
| `code-security-audit` | [LeonMelamud/claude-code-security-review](https://github.com/LeonMelamud/claude-code-security-review) | `.` | **独立技能** | 全量 diff/分支审计唯一入口（三阶段分析 + 误报过滤 + 置信评分 + CI 集成）；文末 Official Lineage 含 anthropic 官方适配件内容 |
| `security-audit-owasp` | [Prismas33/security-audit](https://github.com/Prismas33/security-audit) | `.` | **独立技能（变更门路线）** | 安全变更模式 + 部署**前安全检查** + OWASP Top10 清单 + 攻击模式参考；纯审计走 code-security-audit。发布就绪/回滚/健康检查属 reliability（2026-09-11 已剥离） |
| `auth-security-reviewer` | [patricio0312rev/skills](https://github.com/patricio0312rev/skills) | `security/auth-security-reviewer` | 独立技能（专项族） | 认证授权专项（会话/JWT/CSRF/密码/MFA/授权/限流） |
| `input-validation-sanitization-auditor` | patricio0312rev/skills | `security/input-validation-sanitization-auditor` | 独立技能（专项族） | 注入（XSS/SQLi/命令）修复专项 |
| `secrets-scanner` | patricio0312rev/skills | `security/secrets-scanner` | 独立技能（专项族） | 密钥检测/CI/泄露处置专项 |
| `threat-model-generator` | patricio0312rev/skills | `security/threat-model-generator` | 独立技能（专项族） | 设计阶段 STRIDE 威胁建模（先建模后审计） |
| `supply-chain-risk-auditor` | [trailofbits/skills](https://github.com/trailofbits/skills) | `plugins/supply-chain-risk-auditor/skills/supply-chain-risk-auditor` | **独立技能** | 依赖/锁文件树供应链风险（trailofbits 深方法论） |
| `audit-context-building` | trailofbits/skills | `plugins/audit-context-building/skills/audit-context-building` | **独立技能** | 审计/找 bug 前逐函数上下文构建（可被 correctness bugsweep preflight 复用） |
| `owasp-asi` | [Tencent/AI-Infra-Guard](https://github.com/Tencent/AI-Infra-Guard) | `agent-scan/agent_scan/prompt/skills/owasp-asi` | 独立技能（Agent 安全-分类） | 发现 → ASI（Agentic Top10 2026）归类；上游 10 个 detection 技能**本语料全部收录** |
| `direct-injection-detection` | Tencent/AI-Infra-Guard | `agent-scan/agent_scan/prompt/skills/direct-injection-detection` | 独立技能（Agent 安全-探测） | 直接提示注入/角色覆盖探测；发现后的防护门禁属「Agent 系统运维」维度（2026-09-11 已移出语料，需要时回上游） |
| `offensive-api-security` | [SnailSploit/Claude-Red](https://github.com/SnailSploit/Claude-Red) | `Skills/api/offensive-api-security` | 独立技能（红队） | API 攻击手册（REST/gRPC/WebSocket，OWASP API Top10 2023）；仅授权渗透 |
| `cryptography-reviewer` | [Cosmian/kms](https://github.com/Cosmian/kms) | `.github/skills/cryptography-review` | **独立技能（新增 2026-09-07，领域专项）** | 密码学用法与密钥生命周期审计（FIPS/NIST 对齐：算法/模式/TLS/证书/KMS/轮换）；与 secrets-scanner（找泄露字符串）互补 |
| `cloud-iac-posture-auditor` | [mukul975/Anthropic-Cybersecurity-Skills](https://github.com/mukul975/Anthropic-Cybersecurity-Skills) | `skills/auditing-terraform-infrastructure-for-security` | **独立技能（新增 2026-09-07，领域专项）** | Terraform/IaC 安全态势：IAM/网络/存储/加密/模块配置（资源声明层，区别于 code-security-audit 的代码层） |
| `container-security-auditor` | [jeremylongshore/claude-code-plugins-plus-skills](https://github.com/jeremylongshore/claude-code-plugins-plus-skills) | `skills/04-security-advanced/container-security-auditor` | ~~已移除（2026-09-11）~~ | 空壳（2.4KB，零容器内容，纯自我指涉模板）。内容保留在 git 历史中 |
| `mobile-app-security` | [kalshamsi/claude-security-skills](https://github.com/kalshamsi/claude-security-skills) | `skills/mobile-security` | **独立技能（新增 2026-09-07，领域专项）** | Android/iOS 应用安全审计（本地存储/网络/平台 API/加固）——移动平台层 |
| `indirect-injection-detection` | [Tencent/AI-Infra-Guard](https://github.com/Tencent/AI-Infra-Guard) | `agent-scan/agent_scan/prompt/skills/indirect-injection-detection` | 独立技能（新增，Agent 检测家族） | 间接提示注入（经 RAG/文档/工具注入）探测 |
| `tool-abuse-detection` | Tencent/AI-Infra-Guard | `agent-scan/agent_scan/prompt/skills/tool-abuse-detection` | 独立技能（新增，Agent 检测家族） | 工具滥用/越权工具调用探测（ASI02） |
| `authorization-bypass-detection` | Tencent/AI-Infra-Guard | `agent-scan/agent_scan/prompt/skills/authorization-bypass-detection` | 独立技能（新增，Agent 检测家族） | agent 身份与权限滥用探测（ASI03） |
| `data-leakage-detection` | Tencent/AI-Infra-Guard | `agent-scan/agent_scan/prompt/skills/data-leakage-detection` | 独立技能（新增，Agent 检测家族） | 上下文/Agent 间数据泄漏与记忆污染探测（ASI06/07） |
| `agentic-supply-chain-detection` | Tencent/AI-Infra-Guard | `agent-scan/agent_scan/prompt/skills/agentic-supply-chain-detection` | 独立技能（新增，Agent 检测家族） | Agent 供应链风险探测（ASI04） |
| `unexpected-code-execution-detection` | Tencent/AI-Infra-Guard | `agent-scan/agent_scan/prompt/skills/unexpected-code-execution-detection` | 独立技能（新增，Agent 检测家族） | 意外代码执行探测（ASI05） |
| `inter-agent-comm-security-detection` | Tencent/AI-Infra-Guard | `agent-scan/agent_scan/prompt/skills/inter-agent-comm-security-detection` | 独立技能（新增，Agent 检测家族） | Agent 间通信安全探测（ASI07） |
| `cascading-failure-detection` | Tencent/AI-Infra-Guard | `agent-scan/agent_scan/prompt/skills/cascading-failure-detection` | 独立技能（新增，Agent 检测家族） | Agent 流水线级联失败探测（ASI08） |
| `human-agent-trust-exploit-detection` | Tencent/AI-Infra-Guard | `agent-scan/agent_scan/prompt/skills/human-agent-trust-exploit-detection` | 独立技能（新增，Agent 检测家族） | 人-Agent 信任利用探测（ASI09） |

## 触发路由（选技能前先查这表）

| 用户请求 | 唯一技能 |
|---|---|
| "audit security / 审漏洞 / 审这个 diff"（全量） | code-security-audit |
| 安全**变更**要走查 + 部署前安全检查，或按 OWASP Top10 逐项过 | security-audit-owasp |
| "登录/会话/JWT/CSRF/密码/MFA/权限" 实现要审 | auth-security-reviewer |
| "输入校验 / XSS / SQL 注入 / 命令注入" 修复 | input-validation-sanitization-auditor |
| "扫密钥 / 凭据检测 / 泄露处置" | secrets-scanner |
| "威胁建模 / STRIDE / 安全设计评审" | threat-model-generator |
| 依赖/锁文件供应链审计 | supply-chain-risk-auditor |
| 审计/找 bug 前先理解代码库 | audit-context-building |
| 已确认漏洞后扩散查同源实例 | correctness/variant-analysis |
| agent 安全发现按 ASI 归类 | owasp-asi |
| 测试 agent 是否被直接提示注入劫持 | direct-injection-detection |
| 授权 API 渗透/红队演练 | offensive-api-security |
| "密码学用法 / TLS / KMS / 密钥轮换 审查" | cryptography-reviewer |
| "Terraform / IaC / 云配置安全审查" | cloud-iac-posture-auditor |
| "容器 / 镜像安全审查" | 已随 `container-security-auditor` 移除（2026-09-11）；容器镜像层可走 code-security-audit |
| "审 Android/iOS 应用安全" | mobile-app-security |
| agent 系统做 ASI 分类前的专项探测（间接注入/工具滥用/授权绕过/数据泄漏/供应链/代码执行/通信/级联/信任利用） | 按 ASI 风险类型选对应 `*-detection` 技能 → 发现后用 owasp-asi 归类 |

## 跨角色边界说明

- **全量审计不重复**：code-security-audit（纯审计）与 security-audit-owasp（变更门）分工明确；专项族（auth/input-validation/secrets）只在用户点名领域时单独触发，其余并入全量审计。
- **Agent 安全（本角色内）**：`owasp-asi` 负责发现 → ASI 归类；`direct-injection-detection` 负责直接注入探测。原与 reliability 的 evals-ops-guardrails / production-autopsy（防护门禁与剖析）互引的一对已于 2026-09-11 移出语料（属「Agent 系统运维」维度），需要时回上游仓库。
- **与 correctness 的关系**：确认的漏洞 → variant-analysis 扩散排查（correctness）；"行为对不对"而非"能否被利用" → correctness/bugsweep 或 fp-check。
