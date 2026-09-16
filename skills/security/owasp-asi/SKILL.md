---
name: owasp-asi
description: Classifies security findings against the OWASP Top 10 for Agentic Applications 2026 (ASI) risk categories. Use for mapping agent-security findings to standardized risk categories.
---

# OWASP ASI Classification Framework

**OWASP Top 10 for Agentic Applications 2026** - Standardized risk classification for AI agent security.

## Risk Categories

| ID | Risk Type | Key Indicators |
|:---|:----------|:---------------|
| **ASI01** | Agent Goal Hijack | Prompt injection, instruction override, goal manipulation |
| **ASI02** | Tool Misuse & Exploitation | Unauthorized tool calls, parameter tampering, unvalidated inputs |
| **ASI03** | Identity & Privilege Abuse | Auth bypass, permission escalation, missing authorization |
| **ASI04** | Agentic Supply Chain | Malicious dependencies, compromised tools, package poisoning |
| **ASI05** | Unexpected Code Execution | RCE, command injection, code evaluation |
| **ASI06** | Memory & Context Poisoning | Data leakage, context manipulation, memory corruption |
| **ASI07** | Insecure Inter-Agent Comm | Unencrypted channels, data exposure between agents |
| **ASI08** | Cascading Failures | Error propagation, chain reaction vulnerabilities |
| **ASI09** | Human-Agent Trust Exploit | Social engineering, deceptive responses |
| **ASI10** | Rogue Agents | Malicious agent behavior, unauthorized actions |

## Finding → ASI Mapping

| Finding Type | ASI Category | Rationale |
|:-------------|:-------------|:----------|
| API keys, tokens | ASI06 | Context contains sensitive data |
| System prompts | ASI01 | Enables goal hijacking |
| Credentials | ASI03 | Identity abuse risk |
| Internal configs | ASI04 | Supply chain exposure |
| PII exposure | ASI07 | Inter-agent data leak |
| Command injection | ASI05 | Unexpected code execution |
| Unauthorized tool calls | ASI02 | Tool misuse |

## Severity Classification

### Critical 🚨
- Complete private keys exposed
- Production credentials with unrestricted access
- Remote code execution confirmed
- Full agent takeover possible

### High ⚠️
- API keys with limited scope
- Authentication tokens
- System prompt disclosure
- Partial credential exposure

### Medium 💡
- Configuration details
- Internal endpoints
- Metadata leakage
- Conditional exploitation paths

### Low ℹ️
- Generic system information
- Non-sensitive configurations
- Indirect hints

> 本框架只做严重级归类；不设整改时限，也不设发布门禁，不设 SLA。
> This framework classifies severity only; it does not set remediation deadlines, release gates, or SLAs.

## Usage

Load this skill when performing OWASP ASI classification, then apply the mapping rules above to classify agent-security findings.
