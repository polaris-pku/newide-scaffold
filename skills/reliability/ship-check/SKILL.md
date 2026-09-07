---
name: ship-check
description: Audits a codebase for the 30 most common security, performance, and reliability mistakes in indie/AI-generated projects and reports severity-grouped findings with fixes. Trigger on "ship check", "audit my app", or "is this production ready".
---

# ship-check

> 蒸馏自 Prem95/ship-check（仓库根目录）。原为 3 文件（SKILL.md + README.md + references/checklist.md），README 与 30 项 checklist 已内联合并；条目编号沿用原 checklist（与 README 中按 1–30 顺序编号不同，SKILL.md 的 "先跑 1-5, 8, 10, 13, 16" 即以该编号为准）。
> Distilled from Prem95/ship-check (repo root `.`); originally 3 files (SKILL.md, README.md, references/checklist.md), now merged into one. Item numbers follow the original checklist file.

## When to Use

Use when the user says "ship check", "audit my app", "is this production ready", "security check", "before I launch", "review before deploy", or asks about common mistakes in their codebase. Also trigger when reviewing a project that appears to be pre-launch or early-stage.

Scan the codebase for the 30 critical mistakes that kill indie projects in production. Focus on what actually exists in the code — skip items that don't apply to the stack.

## Workflow

1. **Detect stack** — Read `package.json`, config files, and entry points to identify: framework (Next.js/Express/etc), database (Postgres/Supabase/Prisma/etc), auth method, payment provider, hosting.

2. **Run checklist** — Work through all 30 items in the checklist below. For each item, grep/read the relevant code. Only flag items where you find actual evidence of the problem (or confirmed absence of the protection). Run security-critical items (1-5, 8, 10, 13, 16) first. Stop and report CRITICALs early if found.

3. **Categorize findings** — Group by severity:
   - **CRITICAL** — Exploitable security holes or data loss risks. Fix before launch.
   - **HIGH** — Performance bombs or reliability gaps that will bite at scale.
   - **MEDIUM** — Missing best practices that compound over time.
   - **OK** — Items already handled. List briefly for confidence.

4. **Output report** — Use the report format below.

## Checklist: The 30-Point Audit

Each item has what to grep/check, its severity, and the fix pattern. Only flag items backed by evidence in the code (or confirmed absence of the protection); if the project is too small for an item to matter yet (e.g., no admin routes exist), mark N/A.

### Security (Critical)

#### 1. No rate limiting on API routes
- **Grep**: API route handlers, check for rate-limit middleware (e.g. `express-rate-limit`, `@upstash/ratelimit`, `next-rate-limit`)
- **Check**: Every public API route should have rate limiting. Pay-per-use routes (AI, email, SMS) are highest priority.
- **Fix**: Add rate limiting middleware. For serverless: use Upstash Redis or Vercel KV. For Express: `express-rate-limit`.

#### 2. Auth tokens in localStorage
- **Grep**: `localStorage.setItem`, `localStorage.getItem` with token/auth/session/jwt keywords
- **Check**: Auth tokens should use httpOnly cookies, not localStorage.
- **Fix**: Move to httpOnly secure cookies with SameSite=Strict. Use `Set-Cookie` header server-side.

#### 3. No input sanitization on forms
- **Grep**: Direct use of `req.body`, `req.query`, `req.params` without validation. Look for raw SQL string interpolation.
- **Check**: All user input should be validated/sanitized before use. Parameterized queries for SQL.
- **Fix**: Use zod/joi for validation. Use parameterized queries or ORM. Sanitize HTML output with DOMPurify.

#### 4. Hardcoded API keys in frontend
- **Grep**: API keys, secrets, tokens in `.js`, `.ts`, `.tsx`, `.jsx`, `.html` files. Check for `sk-`, `sk_live`, `AKIA`, `ghp_`, common key prefixes.
- **Check**: No secrets in client-side code. Only public/publishable keys allowed (e.g. `pk_live`, `NEXT_PUBLIC_` with non-secret values).
- **Fix**: Move to server-side environment variables. Proxy through your own API route.

#### 5. Stripe webhooks without signature verification
- **Grep**: Webhook handlers for `stripe`, check for `stripe.webhooks.constructEvent` or equivalent signature verification.
- **Check**: Every Stripe webhook endpoint must verify the signature using the webhook secret.
- **Fix**: Use `stripe.webhooks.constructEvent(body, sig, webhookSecret)`. Use raw body, not parsed JSON.

#### 8. Sessions that never expire
- **Grep**: Session/JWT config, check for `expiresIn`, `maxAge`, token expiry settings.
- **Check**: All sessions and tokens should have finite expiry. JWTs should expire in hours, not days/never.
- **Fix**: Set JWT `expiresIn: '1h'` or similar. Implement refresh token rotation. Add session invalidation.

#### 10. Password reset links that don't expire
- **Grep**: Password reset token generation and verification. Check for expiry timestamp comparison.
- **Check**: Reset tokens must expire (15-60 min). Must be single-use. Must be cryptographically random.
- **Fix**: Store `expires_at` with reset token. Check `expires_at > now()` on verification. Delete after use.

#### 13. No CORS policy
- **Grep**: `cors(`, `Access-Control-Allow-Origin`, CORS middleware config.
- **Check**: API should have explicit CORS configuration. `Access-Control-Allow-Origin: *` on authenticated routes is a red flag.
- **Fix**: Configure CORS to only allow your frontend origin(s). Never wildcard on authenticated endpoints.

#### 16. Admin routes without role checks
- **Grep**: Admin routes/pages, check for role/permission middleware or checks.
- **Check**: Every admin endpoint must verify the user's role, not just authentication.
- **Fix**: Add role-checking middleware. Check `user.role === 'admin'` or equivalent before processing.

#### 21. No request size limits
- **Grep**: Body parser config, `bodyParser.json()`, `express.json()`, Next.js API config `bodyParser`. Check for `limit` or `maxContentLength` settings.
- **Check**: Every endpoint accepting request bodies must cap payload size. Default Express limit is 100KB but many override to unlimited.
- **Fix**: Set `express.json({ limit: '1mb' })` or equivalent. For file uploads, set explicit max file size.

#### 22. Secrets committed to git history
- **Grep**: Run `git log --all -p -- '*.env' '.env*'`. Check `.gitignore` for `.env`. Search git history for `sk-`, `sk_live`, `AKIA`, `password`, `secret`.
- **Check**: `.env` must be in `.gitignore`. No secrets should exist anywhere in git history.
- **Fix**: Add `.env*` to `.gitignore`. If secrets were committed: rotate them immediately, then use `git filter-repo` or BFG to purge history.

#### 23. No idempotency on payment endpoints
- **Grep**: Payment/checkout/subscription creation endpoints. Check for idempotency keys in Stripe calls (`idempotencyKey`, `Idempotency-Key`).
- **Check**: All payment mutation endpoints must be idempotent. Network retries should not double-charge.
- **Fix**: Pass `idempotencyKey` to Stripe API calls. Use unique transaction IDs. Check for existing payment before creating.

#### 24. Missing security headers
- **Grep**: `helmet`, `Content-Security-Policy`, `X-Frame-Options`, `Strict-Transport-Security`, `next.config` headers config.
- **Check**: Responses should include CSP, X-Frame-Options (DENY), HSTS, X-Content-Type-Options (nosniff).
- **Fix**: Use `helmet` middleware for Express. For Next.js, add headers in `next.config.js`. For Vercel, use `vercel.json` headers.

#### 25. No request timeouts on outbound HTTP calls
- **Grep**: `fetch(`, `axios(`, `got(`, HTTP client usage. Check for `timeout`, `signal: AbortSignal.timeout()` options.
- **Check**: Every outbound HTTP call must have a timeout. One hung third-party API should not hang your server.
- **Fix**: Set `signal: AbortSignal.timeout(5000)` on fetch. Set `timeout: 5000` on axios. Add circuit breakers for critical dependencies.

#### 26. No file type/size validation on uploads
- **Grep**: File upload handlers, `multer`, `formidable`, `busboy`, presigned URL generation. Check for `fileFilter`, `limits`, MIME type checks.
- **Check**: All upload endpoints must validate file type (allowlist, not blocklist) and enforce max file size.
- **Fix**: Use `multer({ fileFilter, limits: { fileSize: 5 * 1024 * 1024 } })`. Validate MIME type server-side, not just extension.

#### 27. Weak or no password hashing
- **Grep**: `bcrypt`, `argon2`, `scrypt`, `crypto.createHash`, `md5`, `sha1`, `sha256` in auth/user code. Check password storage logic.
- **Check**: Passwords must use bcrypt (cost 12+) or argon2. MD5/SHA-1/SHA-256 without salt is broken.
- **Fix**: Use `bcrypt.hash(password, 12)` or `argon2.hash(password)`. Never roll your own password hashing.

### Performance (High)

#### 6. No database indexing on queried fields
- **Grep**: Database queries (WHERE clauses, JOINs), cross-reference with index definitions in migrations/schema.
- **Check**: Fields used in WHERE, JOIN, ORDER BY should have indexes. Check for sequential scans on large tables.
- **Fix**: Add indexes on frequently queried columns. Use `EXPLAIN ANALYZE` to find slow queries.

#### 9. No pagination on database queries
- **Grep**: Database queries without `LIMIT`, `offset`, `.take()`, `.limit()`. API endpoints returning lists.
- **Check**: Every list endpoint must paginate. No unbounded `SELECT *` or `.findMany()` without limits.
- **Fix**: Add `limit` and `offset`/`cursor` parameters. Default limit of 20-50. Max limit of 100.

#### 12. Images uploaded directly to server (no CDN)
- **Grep**: File upload handlers, `multer`, `formidable`, local file storage paths.
- **Check**: Images/files should go to object storage (S3, R2, Supabase Storage) with CDN, not local disk.
- **Fix**: Use presigned URLs to upload directly to S3/R2. Serve via CDN (CloudFront, Cloudflare).

#### 14. Emails sent synchronously in request handlers
- **Grep**: Email sending (nodemailer, resend, sendgrid) inside route handlers, check if awaited inline.
- **Check**: Email sends should be async/queued, not blocking the HTTP response.
- **Fix**: Use a job queue (BullMQ, Inngest, QStash). Or at minimum fire-and-forget without awaiting.

#### 15. No database connection pooling
- **Grep**: Database client initialization. Check for `new Pool()`, connection pool config, or singleton patterns.
- **Check**: DB connections should be pooled, not created per-request. Especially critical in serverless.
- **Fix**: Use connection pooling (PgBouncer, Supabase pooler, Prisma connection pool). Singleton pattern for DB client.

### Reliability (Medium-High)

#### 7. No error boundaries in UI
- **Grep**: `ErrorBoundary`, `error.tsx`, `error.js`, `componentDidCatch`, error boundary components.
- **Check**: App should have error boundaries at layout and feature boundaries. No unhandled white screens.
- **Fix**: Add React Error Boundaries at root and key feature boundaries. Add Next.js `error.tsx` files.

#### 11. No environment variable validation at startup
- **Grep**: `process.env.` usage, check for validation at app startup (zod env schema, `envalid`, manual checks).
- **Check**: All required env vars should be validated at startup. App should fail fast with clear error.
- **Fix**: Validate env vars at startup with zod or envalid. Throw descriptive errors for missing vars.

#### 17. No health check endpoint
- **Grep**: `/health`, `/healthz`, `/api/health`, health check routes.
- **Check**: App should expose a health check endpoint that verifies core dependencies (DB, Redis, external services).
- **Fix**: Add `GET /health` that checks DB connectivity and returns status. Wire to monitoring/uptime checker.

#### 18. No logging in production
- **Grep**: Logging setup (winston, pino, console.log usage), structured logging config.
- **Check**: App should have structured logging. Key events (errors, auth, payments) should be logged.
- **Fix**: Add structured logging (pino recommended). Log errors, auth events, payment events. Ship to log aggregator.

#### 19. No backup strategy for database
- **Check**: Database should have automated backups. Check hosting provider backup config (Supabase, PlanetScale, RDS).
- **Note**: This is infrastructure-level, may not be visible in code. Ask user about their backup config.

#### 20. No TypeScript on AI-generated code
- **Grep**: `.js` files that should be `.ts`. Check `tsconfig.json` exists. Check for `any` type abuse.
- **Check**: Project should use TypeScript, especially for AI-assisted codebases. `strict: true` preferred.
- **Fix**: Enable TypeScript with strict mode. Add types to all function signatures and API boundaries.

#### 28. No graceful shutdown handling
- **Grep**: `SIGTERM`, `SIGINT`, `process.on('SIGTERM'`, graceful shutdown handlers. Check for `server.close()` logic.
- **Check**: App should handle SIGTERM to finish in-flight requests before exiting. Critical for deploys.
- **Fix**: Add `process.on('SIGTERM', () => server.close())`. Drain connections before exit. Set a force-kill timeout (10s).

#### 29. No audit trail on sensitive operations
- **Grep**: Payment, user deletion, role change, password change handlers. Check if these actions are logged with actor/timestamp.
- **Check**: Sensitive operations (payments, account changes, admin actions) should produce an audit log entry.
- **Fix**: Log `{ action, actor, target, timestamp, metadata }` for sensitive ops. Store in DB table or structured log.

#### 30. Unhandled promise rejections
- **Grep**: `process.on('unhandledRejection'`, global error handlers. Check for `.catch()` on async operations. Check for `async` route handlers without try/catch.
- **Check**: Unhandled rejections should not crash the process silently. All async paths must have error handling.
- **Fix**: Add `process.on('unhandledRejection', handler)`. Use express-async-errors or wrap async handlers. In Next.js, use error.tsx boundaries.

## Output Format

```
## Ship Check Report

**Stack**: [detected stack summary]
**Checked**: [N] items | **Issues**: [N] found

### CRITICAL
- **[Item name]** — [What's wrong, with file:line references]
  Fix: [Concrete 1-2 line fix suggestion for THIS codebase]

### HIGH
[same format]

### MEDIUM
[same format]

### Already Handled
- [Item name] — [brief note on how it's handled]

### Not Applicable
- [Item name] — [why it doesn't apply to this stack]
```

Example skeleton (from the original README): Stack: Next.js + Supabase + Stripe; a CRITICAL entry reads `- **No rate limiting** — app/api/generate/route.ts:14 has no rate limit middleware / Fix: Add @upstash/ratelimit to this route`; an "Already Handled" entry reads `- **Auth tokens** — Using httpOnly cookies via Supabase Auth`; a "Not Applicable" entry reads `- **Admin routes** — No admin panel exists`.

## Item → Specialist Skill Map (deep-check routing)

> 集成说明（2026-09-07）：ship-check 只是 5 分钟发布初筛；命中任一项后，深审交给对应角色/技能的专项（避免与 code-security-audit、backend-performance-review 等专项重复劳动）。对应技能均在 `skills/<角色>/` 下。

| Item | 深审路由（专项技能） |
|---|---|
| 1 No rate limiting on API routes | security/offensive-api-security（限流探测）；security/code-security-audit |
| 2 Auth tokens in localStorage | security/code-security-audit |
| 3 No input sanitization on forms | security/input-validation-sanitization-auditor |
| 4 Hardcoded API keys in frontend | security/secrets-scanner |
| 5 Stripe webhooks without signature verification | security/code-security-audit |
| 6 No database indexing on queried fields | performance/sql-query-optimizer |
| 7 No error boundaries in UI | reliability/error-handling-standardizer（错误显式化；前端扩展） |
| 8 Sessions that never expire | security/auth-security-reviewer |
| 9 No pagination on database queries | performance/sql-query-optimizer；performance/backend-performance-review（Data access 层） |
| 10 Password reset links that don't expire | security/auth-security-reviewer |
| 11 No environment variable validation at startup | reliability/error-handling-standardizer（显式启动失败） |
| 12 Images uploaded directly to server (no CDN) | performance/caching-cdn-strategy-planner |
| 13 No CORS policy | security/offensive-api-security（CORS 测试）；security/code-security-audit |
| 14 Emails sent synchronously in request handlers | performance/backend-performance-review（Async and blocking） |
| 15 No database connection pooling | performance/backend-performance-review（Connection pools 层） |
| 16 Admin routes without role checks | security/auth-security-reviewer（授权） |
| 17 No health check endpoint | reliability/reliability-strategy-builder（Monitoring） |
| 18 No logging in production | reliability/error-handling-standardizer（结构化日志） |
| 19 No backup strategy for database | reliability/backup-restore-runbook |
| 20 No TypeScript on AI-generated code | maintainability/simplify-swarm（strict 模式/防 AI slop）；manual：为 AI 生成代码启用类型检查 |
| 21 No request size limits | security/offensive-api-security（资源消耗）；security/code-security-audit |
| 22 Secrets committed to git history | security/secrets-scanner |
| 23 No idempotency on payment endpoints | reliability/reliability-strategy-builder（重试/幂等） |
| 24 Missing security headers | security/code-security-audit |
| 25 No request timeouts on outbound HTTP calls | reliability/reliability-strategy-builder（超时/重试） |
| 26 No file type/size validation on uploads | security/input-validation-sanitization-auditor |
| 27 Weak or no password hashing | security/auth-security-reviewer |
| 28 No graceful shutdown handling | reliability/error-handling-standardizer；reliability/reliability-strategy-builder（应用可靠性） |
| 29 No audit trail on sensitive operations | security/security-audit-owasp（A09 日志与监控） |
| 30 Unhandled promise rejections | reliability/error-handling-standardizer（异步错误处理）；correctness/bugsweep（若为行为 bug） |

## Rules

- Grep before judging. Never flag something without checking the code first.
- Reference specific files and line numbers for every finding.
- Fix suggestions must be concrete to THIS codebase (name the actual files, middleware, routes).
- If the project is too small for an item to matter yet (e.g., no admin routes exist), mark N/A.
- Don't fix anything — report only. User decides what to act on.
- Run security-critical items (1-5, 8, 10, 13, 16) first. Stop and report CRITICALs early if found.

## Provenance

- Source repo: https://github.com/Prem95/ship-check
- Original path: `.` (repo root); files `SKILL.md`, `README.md`, `references/checklist.md`
- License: MIT (per the repo's README)
- Credits: based on the viral thread by @Hartdrawss (https://x.com/Hartdrawss/status/2035378419278532928) — 20 mistakes that mass-ship in AI-generated code.
- 蒸馏说明：原 3 文件已合并。README 的 "What it checks" 概览与 SKILL.md 30 项清单为同一批条目、但两处编号顺序不一致（README 按 1–16/17–21/22–30 分节连续编号，checklist 用另一套 1–30 编号并按严重度分节）；本文件沿用 checklist 编号，因为 SKILL.md "先跑 (1-5, 8, 10, 13, 16)" 指向该编号。所有条目的 grep/check/fix 指引逐条保留。
