---
name: security-audit-owasp
description: Audits code and deployments for security vulnerabilities and drives secure, regression-proof fixes. Use for security, pentesting, auth, sessions, JWT, cookies, credentials, CORS, sensitive data, incidents, or production security.
---

# security-audit-owasp

> 蒸馏自 Prismas33/security-audit（仓库内路径 `.`）。原为 4 文件（SKILL.md + README.md + references/attack-patterns.md + references/secure-change-gates.md）；两篇附属参考文档已内联为正文章节，frontmatter 的 author/version 移入 Provenance。
> Distilled from Prismas33/security-audit (repo path `.`); originally 4 files (SKILL.md, README.md, and two reference documents now inlined as body sections).

Security workflow that audits code like a pentester and prevents regressions while remediation is implemented and deployed.

## When to Use

Activate when the user asks:
- "Analyze the security of..."
- "How would you attack this endpoint?"
- "Do a security audit"
- "Pentester mode"
- "Find vulnerabilities in..."
- "OWASP check"
- "Fix this auth/session/CORS issue"
- "Are credentials leaking?"
- "Deploy this security fix"
- "Security incident"

## Analysis Mode — Core Approach

Think like an attacker:
1. **Reconnaissance** — What's exposed? What info leaks?
2. **Attack Vectors** — How can I exploit this?
3. **Impact** — What can I achieve if I exploit?
4. **Remediation** — How to fix?

Then think like the operator who must safely ship the fix:
5. **Contract mapping** — Which browser, proxy/CDN, frontend, API, mobile APK, and legacy clients depend on this behavior?
6. **Regression proof** — What small test would prove the change works without breaking those clients?
7. **Security evidence** — What production header, preflight response, or auth flow proves the security fix behaves as intended?

## Security Change Mode

Use this mode when the request asks to implement or deploy a security fix. Do not stop at a code patch.

### 1. Classify the Change

Treat these as **cross-layer security changes**:

- authentication, JWT, cookies, refresh tokens, logout, password reset;
- credentials in URLs, browser storage, logs, errors, analytics, or `Referer`;
- CORS, CSP, CSRF, proxy/CDN headers;
- authorization/role checks;
- uploads, encryption, secrets, payments, or webhooks.

For a cross-layer change, map this contract before editing:

| Layer | Verify |
|---|---|
| Browser/frontend | request method, `credentials`, storage, redirects, error handling |
| API | request parsing, auth middleware, response/cookie headers, logout |
| CORS/proxy/CDN | exact allowed origin, credentials header, `Vary: Origin`, HTTPS |
| Native/APK/legacy | Bearer/API compatibility, WebView cookie behavior, update constraints |

### 2. Mandatory Rules

- Never place passwords, session tokens, access tokens, refresh tokens, API keys, or credentials in URLs.
- Never store passwords in browser storage.
- Do not store browser access/session tokens in `localStorage` or `sessionStorage` when an `HttpOnly` cookie session is feasible.
- Do not log raw request bodies, authorization headers, cookies, provider errors, or unredacted exception objects.
- Do not use `Access-Control-Allow-Origin: *` with credentials. Use explicit origins and `Access-Control-Allow-Credentials: true`.
- Preserve an explicit compatibility path for native/legacy clients before replacing Bearer authentication.
- Release readiness, deployment ordering, rollback and health checks are out of scope here.
- Do not claim a security fix is complete until its focused production validation has passed.

### 3. Cookie Session Checklist

When migrating web auth from Bearer/JWT in browser storage to cookies, verify every item:

- [ ] Cookie is `HttpOnly`.
- [ ] Cookie is `Secure` in production.
- [ ] `SameSite=Lax` or `Strict` is deliberate and compatible with the flow.
- [ ] Cookie path/domain are minimal and correct for the API host.
- [ ] Frontend fetch uses `credentials: 'include'`.
- [ ] API CORS has explicit frontend origin, `credentials: true`, and no wildcard origin.
- [ ] Auth middleware accepts the cookie securely.
- [ ] Login and token refresh set the cookie; logout clears the same cookie attributes.
- [ ] State-changing cookie-authenticated endpoints have CSRF protection appropriate to the site architecture.
- [ ] Native/APK/CLI Bearer support is retained or a tested migration path exists.

### 4. Pre-Deploy Security Checks

Before deploy — security-specific checks only:

- [ ] Every new or changed endpoint has authentication and authorization applied.
- [ ] No secrets, tokens, or credentials were introduced into source, config files, or the built bundle.
- [ ] New dependencies introduce no known vulnerabilities (npm audit / pip-audit).
- [ ] Production CORS origins match the real panel origin exactly.

After deploy — security verification:

- [ ] Browser preflight `OPTIONS` confirms expected origin, methods, headers, and credentials policy.
- [ ] URL bar, browser storage, and console are checked for sensitive data.
- [ ] Logout and session expiry invalidate the session server-side.
- [ ] A supported native/APK flow is smoke-tested when auth behavior changed.

### Expected Output

For each vulnerability found:

```markdown
### 🚨 [SEVERITY] Vulnerability Title

**Location:** `file.py:line` or `endpoint`

**What I found:**
Problem description.

**How I would attack:**
Concrete exploitation steps.

**Impact:**
What an attacker can achieve.

**Remediation:**
How to fix, with code example.
```

## Checklist — Analysis

### 1. Authentication & Sessions
- [ ] Passwords stored with secure hash (bcrypt/argon2)?
- [ ] JWT tokens with short expiration?
- [ ] Browser sessions avoid JWT/access tokens in `localStorage` or `sessionStorage`?
- [ ] Web session tokens use `HttpOnly`, `Secure`, `SameSite` cookies where possible?
- [ ] Refresh tokens implemented correctly?
- [ ] Brute force protection (rate limiting)?
- [ ] Session fixation prevented?
- [ ] Logout invalidates server-side session?
- [ ] Login, refresh, and logout are validated end-to-end with the deployed frontend and API?

### 2. Authorization
- [ ] Permission checks on ALL endpoints?
- [ ] IDOR (Insecure Direct Object Reference) prevented?
- [ ] Privilege escalation prevented?
- [ ] Consistent role-based access control?

### 3. Injection
- [ ] SQL Injection — parameterized queries?
- [ ] NoSQL Injection prevented?
- [ ] Command Injection — inputs sanitized?
- [ ] LDAP Injection prevented?
- [ ] XPath Injection prevented?

### 4. XSS (Cross-Site Scripting)
- [ ] Output encoding on all dynamic data?
- [ ] Content-Security-Policy header?
- [ ] React/Vue auto-escaping working?
- [ ] dangerouslySetInnerHTML avoided or sanitized?

### 5. CSRF (Cross-Site Request Forgery)
- [ ] CSRF tokens in forms?
- [ ] SameSite cookies?
- [ ] Origin/Referer verification?
- [ ] Cookie-authenticated state-changing API routes protected against cross-site requests?

### 6. Sensitive Data
- [ ] HTTPS enforced?
- [ ] Sensitive data in logs?
- [ ] Hardcoded credentials in code?
- [ ] Secrets in environment variables?
- [ ] .env in .gitignore?
- [ ] Query parameters, URL fragments, history, `Referer`, browser storage, and console checked for credentials/tokens?
- [ ] Error logging redacts authorization, cookie, password, token, key, and secret fields?

### 7. Security Headers
- [ ] X-Content-Type-Options: nosniff
- [ ] X-Frame-Options: DENY/SAMEORIGIN
- [ ] Strict-Transport-Security (HSTS)
- [ ] Content-Security-Policy
- [ ] X-XSS-Protection (legacy browsers)

### 8. API Security
- [ ] Rate limiting implemented?
- [ ] Input validation on all endpoints?
- [ ] Error messages don't reveal internal info?
- [ ] API versioning?
- [ ] CORS configured restrictively?
- [ ] Credentialed CORS tested with the exact production origin and preflight request?

### 9. File Upload
- [ ] File type validation (not just extension)?
- [ ] Max size defined?
- [ ] Files stored outside webroot?
- [ ] Filenames sanitized?
- [ ] Antivirus scan?

### 10. Dependencies
- [ ] Dependencies updated?
- [ ] Known vulnerabilities (npm audit, pip-audit)?
- [ ] Lock files committed?

## OWASP Top 10 (2021) Checks

### A01: Broken Access Control
- Authentication bypass
- Access to other users' resources
- Privilege escalation
- Metadata manipulation (JWT, cookies)

### A02: Cryptographic Failures
- Sensitive data in plaintext
- Weak algorithms (MD5, SHA1 for passwords)
- Hardcoded keys
- Transmission without TLS

### A03: Injection
- SQLi, NoSQLi, Command Injection
- XSS, LDAP Injection
- Dynamic queries without parameterization

### A04: Insecure Design
- Missing rate limiting
- Business logic flaws
- Missing server-side validation

### A05: Security Misconfiguration
- Missing headers
- Debug mode in production
- Insecure defaults
- Excessive permissions

### A06: Vulnerable Components
- Outdated dependencies
- Known CVEs
- Abandoned libraries

### A07: Auth Failures
- Credential stuffing possible
- Weak password policy
- Insecure session management
- Access/session tokens exposed to browser JavaScript storage

### A08: Software & Data Integrity
- Insecure CI/CD
- Auto-update without verification
- Insecure deserialization

### A09: Logging & Monitoring
- Security events not logged
- Insufficient logs
- Alerts not configured

### A10: SSRF
- User-controlled URLs
- Internal requests exposed
- Metadata services accessible

## Attack Patterns (detailed reference)

> 内联自原 references/attack-patterns.md；原文为葡萄牙语，保持原文。Inlined from the original references/attack-patterns.md; originally written in Portuguese and kept verbatim.

### 1. SQL Injection

**Como Identificar:**
```python
# VULNERÁVEL - concatenação de strings
query = f"SELECT * FROM users WHERE id = {user_input}"
query = "SELECT * FROM users WHERE id = " + user_input

# VULNERÁVEL - format strings
query = "SELECT * FROM users WHERE id = %s" % user_input
```

**Remediação:**
```python
# Queries parametrizadas
cursor.execute("SELECT * FROM users WHERE id = ?", (user_input,))

# Com ORM
User.query.filter_by(id=user_input).first()
```

### 2. XSS (Cross-Site Scripting)

**Tipos:**
1. **Stored XSS** — Payload guardado no servidor
2. **Reflected XSS** — Payload no URL/request
3. **DOM XSS** — Manipulação client-side

**Como Identificar:**
```javascript
// VULNERÁVEL - innerHTML com dados não sanitizados
element.innerHTML = userInput;

// VULNERÁVEL - document.write
document.write(userInput);

// VULNERÁVEL - eval
eval(userInput);
```

**Remediação:**
```javascript
// Usar textContent em vez de innerHTML
element.textContent = userInput;

// Sanitizar HTML se necessário
import DOMPurify from 'dompurify';
element.innerHTML = DOMPurify.sanitize(userInput);

// React já escapa por default
return <div>{userInput}</div>; // Safe
```

### 3. IDOR (Insecure Direct Object Reference)

**Como Identificar:**
```
# URLs previsíveis
GET /api/users/123/profile
GET /api/orders/456/invoice

# Verificar se mudar o ID mostra dados de outros users
GET /api/users/124/profile  # Deveria dar 403, não 200
```

**Remediação:**
```python
# SEMPRE verificar ownership
@app.get("/users/{user_id}/profile")
def get_profile(user_id: int, current_user: User):
    if user_id != current_user.id and not current_user.is_admin:
        raise HTTPException(403, "Forbidden")
    return get_user_profile(user_id)
```

### 4. Authentication Bypass

**Vetores Comuns:**
```
# JWT sem verificação
- Alterar alg: "none"
- Alterar user_id no payload
- Chave fraca (brute force)

# Password Reset
- Token previsível
- Token reutilizável
- Rate limiting ausente

# Session
- Session fixation
- Cookie sem HttpOnly/Secure
```

### 5. SSRF (Server-Side Request Forgery)

**Como Identificar:**
```python
# VULNERÁVEL - URL controlada por user
@app.get("/fetch")
def fetch_url(url: str):
    response = requests.get(url)  # SSRF!
    return response.text
```

**Remediação:**
```python
# Whitelist de domínios
ALLOWED_HOSTS = ["api.trusted.com", "cdn.trusted.com"]

def fetch_url(url: str):
    parsed = urlparse(url)
    if parsed.netloc not in ALLOWED_HOSTS:
        raise HTTPException(400, "Domain not allowed")
    # ... fetch
```

### 6. Insecure Deserialization

**Como Identificar:**
```python
# VULNERÁVEL
import pickle
data = pickle.loads(user_input)  # RCE possível!

# VULNERÁVEL - YAML
import yaml
yaml.load(user_input)  # Usar yaml.safe_load()
```

**Remediação:**
```python
# Usar safe_load
yaml.safe_load(user_input)

# Evitar pickle com dados não confiáveis
# Usar JSON em vez de pickle para serialização
```

### 7. Path Traversal

**Como Identificar:**
```python
# VULNERÁVEL
@app.get("/files/{filename}")
def get_file(filename: str):
    return open(f"/uploads/{filename}").read()
```

**Remediação:**
```python
import os

def get_file(filename: str):
    # Resolver caminho real
    base = os.path.realpath("/uploads")
    path = os.path.realpath(os.path.join(base, filename))

    # Verificar se está dentro do diretório permitido
    if not path.startswith(base):
        raise HTTPException(400, "Invalid path")

    return open(path).read()
```

### 8. Command Injection

**Como Identificar:**
```python
# VULNERÁVEL
os.system(f"ping {user_input}")
subprocess.call(f"convert {filename}", shell=True)
```

**Remediação:**
```python
# Usar lista de argumentos, não shell=True
subprocess.run(["ping", "-c", "4", user_input], shell=False)

# Validar input
import re
if not re.match(r'^[\d.]+$', user_input):
    raise ValueError("Invalid IP")
```

### 9. Mass Assignment

**Como Identificar:**
```python
# VULNERÁVEL - aceita todos os campos
@app.post("/users")
def create_user(data: dict):
    user = User(**data)  # Pode incluir is_admin=True!
    db.add(user)
```

**Remediação:**
```python
# Usar schema específico
class CreateUserRequest(BaseModel):
    username: str
    email: str
    # Não incluir is_admin, role

@app.post("/users")
def create_user(data: CreateUserRequest):
    user = User(
        username=data.username,
        email=data.email,
        is_admin=False  # Sempre default seguro
    )
```

### 10. Rate Limiting Bypass

**Técnicas de Bypass:**
```
# Headers de proxy
X-Forwarded-For: 127.0.0.1
X-Real-IP: different-ip
X-Originating-IP: different-ip

# Case variations
/api/login
/API/LOGIN
/api/Login

# Path manipulation
/api/login/
/api//login
/api/login?x=1
```

**Remediação:**
```python
# Rate limit por user ID, não só IP
# Ignorar headers de proxy não confiáveis
# Normalizar paths antes de rate limiting
```

## Secure Change Gates (cross-layer auth reference)

> 内联自原 references/secure-change-gates.md。Inlined from the original references/secure-change-gates.md.

Use this whenever a security finding changes an authentication, browser, API, or proxy contract.

### Change Record

```markdown
## Security Change Record

Risk: CRITICAL/HIGH/MEDIUM/LOW
Root cause:
Affected layers: browser | frontend | API | proxy/CDN | native/APK | database
Compatibility decision:
```

### Stop Conditions

Stop deployment and repair when any condition is true:

- Login depends on an API CORS header that is not already live.
- The frontend/API origins are unknown or a wildcard origin is being combined with credentials.
- A JWT/password/token still appears in a URL, browser storage, console, or generated log.
- A fix removes Bearer auth without an explicit APK/native compatibility decision.

## Analysis Commands

### Python
```bash
# Dependency vulnerabilities
pip-audit

# Static analysis
bandit -r .

# Secrets in code
trufflehog .
```

### JavaScript/Node
```bash
# Dependency vulnerabilities
npm audit
pnpm audit

# Secrets
npx secretlint .
```

### General
```bash
# Secrets in git history
gitleaks detect

# General scan
trivy fs .
```

### Browser/API Contract Checks
```bash
# CORS preflight: replace the domain and origin with production values.
curl -i -X OPTIONS https://api.example.com/auth/login \
  -H "Origin: https://panel.example.com" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type"

# Find common credential leaks in source. Review matches before treating them as vulnerabilities.
rg -n "(password|pass|token|access_token|refresh_token|authorization)=|localStorage.*(token|password)|console\\.(log|error).*?(token|password)" .
```

## Incident Workflow

For a suspected credential/session exposure:

1. **Contain:** remove the active exposure, block unsafe URL/query handling, and stop raw sensitive logging.
2. **Assess:** identify browser history, screenshots, logs, CDN/proxy, analytics, git, chat, backups, and client storage that may contain the secret.
3. **Rotate:** change exposed passwords, signing secrets, API keys, and provider secrets as applicable.
4. **Remediate:** fix the root cause across frontend, API, and infrastructure.
5. **Verify:** re-run the pre-deploy security checks and document evidence and remaining risk.

Never place real credentials, tokens, or copied sensitive URLs in the incident report.

## Severity Levels

| Level | Description | Examples |
|-------|-------------|----------|
| 🔴 **CRITICAL** | Compromises entire system | RCE, SQLi with admin, Total auth bypass |
| 🟠 **HIGH** | Access to sensitive data | IDOR, Stored XSS, Privilege escalation |
| 🟡 **MEDIUM** | Limited impact | CSRF, Reflected XSS, Info disclosure |
| 🟢 **LOW** | Low risk | Missing headers, Verbose errors |
| ⚪ **INFO** | Best practices | Suggested improvements |

## Output Format — Full Audit Report

When the user asks for a complete audit:

```markdown
# 🔒 Security Audit Report

**Project:** [Name]
**Date:** YYYY-MM-DD
**Scope:** [What was analyzed]

## Executive Summary

| Severity | Count |
|----------|-------|
| 🔴 Critical | X |
| 🟠 High | X |
| 🟡 Medium | X |
| 🟢 Low | X |

## Vulnerabilities Found

### 🔴 CRITICAL: [Title]
[Details per template above]

### 🟠 HIGH: [Title]
[...]

## Priority Recommendations

1. [Immediate action 1]
2. [Immediate action 2]
3. [Short-term action]

## Remediation Checklist

- [ ] Critical fix 1
- [ ] Critical fix 2
- [ ] ...
```

## Limitations

This skill **DOES NOT replace** a professional pentest. It serves as:
- ✅ Identify obvious vulnerabilities
- ✅ Security code review
- ✅ Attack education
- ✅ Best practices checklist

**DOES NOT:**
- ❌ Real penetration testing
- ❌ Automated fuzzing
- ❌ Infrastructure scanning
- ❌ Total security guarantee

## Provenance

- Source repo: https://github.com/Prismas33/security-audit
- Original path: repo root (`SKILL.md` + `references/` + `README.md`)
- Author: Prismas33（原 frontmatter `metadata.author`，version 2.0.0 见原 `metadata.version`）
- License: MIT（原 README "## License: MIT"）
- 蒸馏说明：原 4 文件（SKILL.md + README.md + references/attack-patterns.md + references/secure-change-gates.md）；两篇 references 全文内联（attack-patterns 保持葡萄牙语原文），README 安装/结构信息并入 Provenance 未单独保留。原 README 的 `npx skills add Prismas33/security-audit` 安装方式已省略（本 skill 为自包含文本）。
