---
name: observability-designer
description: Designs production observability - metrics, structured logs, tracing and alert rules that realize agreed SLIs. Use when instrumenting services, building dashboards, or turning SLOs into alertable signals.
---

# Observability Designer (POWERFUL)

## Overview

Observability Designer creates production-ready dashboards, alert configurations, and monitoring strategies across the three pillars (metrics, logs, traces).

**Scope boundary.** SLO/SLI *definitions* — error-budget math, multi-window burn-rate thresholds, SLO review gates — are out of scope here. This skill consumes the SLIs it agrees and turns them into measurable signals: dashboards, alert rules, and instrumentation. It does not define SLOs.

## How to produce the artifacts

- **Dashboard spec** (Grafana JSON + doc) — parameterize by service type, name, criticality, and audience role.
- **Alert-config analysis** — read the existing alert config and report noise, duplicates, and coverage gaps *first*; only emit an optimized config once that report has been reviewed.
- **SLO scaffold** — a quick skeleton only; the real error-budget math is out of scope here.

**Verification loop:** after deploying optimized alerts, track the noise metrics for one on-call rotation — if the actionable-alert ratio did not improve, re-analyze the live config and iterate. Import the generated dashboard into Grafana and confirm every golden-signal panel renders with live data before closing the task.

## Core Competencies

### SLI/SLO/SLA Framework Design
- **Service Level Indicators (SLI):** Define measurable signals that indicate service health
- **Service Level Objectives (SLO):** Set reliability targets based on user experience
- **Service Level Agreements (SLA):** Establish customer-facing commitments with consequences
- **Error Budget Management:** Calculate and track error budget consumption
- **Burn Rate Alerting:** Multi-window burn rate alerts for proactive SLO protection

### Three Pillars of Observability

#### Metrics
- **Golden Signals:** Latency, traffic, errors, and saturation monitoring
- **RED Method:** Rate, Errors, and Duration for request-driven services
- **USE Method:** Utilization, Saturation, and Errors for resource monitoring
- **Business Metrics:** Revenue, user engagement, and feature adoption tracking
- **Infrastructure Metrics:** CPU, memory, disk, network, and custom resource metrics

#### Logs
- **Structured Logging:** JSON-based log formats with consistent fields
- **Log Aggregation:** Centralized log collection and indexing strategies
- **Log Levels:** Appropriate use of DEBUG, INFO, WARN, ERROR, FATAL levels
- **Correlation IDs:** Request tracing through distributed systems
- **Log Sampling:** Volume management for high-throughput systems

#### Traces
- **Distributed Tracing:** End-to-end request flow visualization
- **Span Design:** Meaningful span boundaries and metadata
- **Trace Sampling:** Intelligent sampling strategies for performance and cost
- **Service Maps:** Automatic dependency discovery through traces
- **Root Cause Analysis:** Trace-driven debugging workflows

### Dashboard Design Principles

#### Information Architecture
- **Hierarchy:** Overview → Service → Component → Instance drill-down paths
- **Purpose mix:** weight the dashboard toward operational signals, leaving room for exploratory ones — the split is a judgement call for the service, not a fixed ratio
- **Cognitive Load:** keep a screen to what one on-call person can scan at a glance; split it rather than crowd it
- **User Journey:** Role-based dashboard personas (SRE, Developer, Executive)

#### Visualization Best Practices
- **Chart Selection:** Time series for trends, heatmaps for distributions, gauges for status
- **Color Theory:** Red for critical, amber for warning, green for healthy states
- **Reference Lines:** SLO targets, capacity thresholds, and historical baselines
- **Time Ranges:** Default to meaningful windows (4h for incidents, 7d for trends)

#### Panel Design
- **Metric Queries:** Efficient Prometheus/InfluxDB queries with proper aggregation
- **Alerting Integration:** Visual alert state indicators on relevant panels
- **Interactive Elements:** Template variables, drill-down links, and annotation overlays
- **Performance:** Sub-second render times through query optimization

### Alert Design and Optimization

#### Alert Classification
- **Severity Levels:** 
  - **Critical:** Service down, SLO burn rate high
  - **Warning:** Approaching thresholds, non-user-facing issues
  - **Info:** Deployment notifications, capacity planning alerts
- **Actionability:** Every alert must have a clear response action
- **Alert Routing:** Escalation policies based on severity and team ownership

#### Alert Fatigue Prevention
- **Signal vs Noise:** High precision (few false positives) over high recall
- **Hysteresis:** Different thresholds for firing and resolving alerts
- **Suppression:** Dependent alert suppression during known outages
- **Grouping:** Related alerts grouped into single notifications

#### Alert Rule Design
- **Threshold Selection:** Statistical methods for threshold determination
- **Window Functions:** Appropriate averaging windows and percentile calculations
- **Alert Lifecycle:** Clear firing conditions and automatic resolution criteria
- **Testing:** Alert rule validation against historical data

### Runbook Generation and Incident Response

#### Runbook Structure
- **Alert Context:** What the alert means and why it fired
- **Impact Assessment:** User-facing vs internal impact evaluation
- **Investigation Steps:** Ordered troubleshooting procedures with time estimates
- **Resolution Actions:** Common fixes and escalation procedures
- **Post-Incident:** Follow-up tasks and prevention measures

#### Incident Detection Patterns
- **Anomaly Detection:** Statistical methods for detecting unusual patterns
- **Composite Alerts:** Multi-signal alerts for complex failure modes
- **Predictive Alerts:** Capacity and trend-based forward-looking alerts
- **Canary Monitoring:** Early detection through progressive deployment monitoring

### Golden Signals Framework

#### Latency Monitoring
- **Request Latency:** P50, P95, P99 response time tracking
- **Queue Latency:** Time spent waiting in processing queues
- **Network Latency:** Inter-service communication delays
- **Database Latency:** Query execution and connection pool metrics

#### Traffic Monitoring
- **Request Rate:** Requests per second with burst detection
- **Bandwidth Usage:** Network throughput and capacity utilization
- **User Sessions:** Active user tracking and session duration
- **Feature Usage:** API endpoint and feature adoption metrics

#### Error Monitoring
- **Error Rate:** 4xx and 5xx HTTP response code tracking
- **Error Budget:** SLO-based error rate targets and consumption
- **Error Distribution:** Error type classification and trending
- **Silent Failures:** Detection of processing failures without HTTP errors

#### Saturation Monitoring
- **Resource Utilization:** CPU, memory, disk, and network usage
- **Queue Depth:** Processing queue length and wait times
- **Connection Pools:** Database and service connection saturation
- **Rate Limiting:** API throttling and quota exhaustion tracking

### Distributed Tracing Strategies

#### Trace Architecture
- **Sampling Strategy:** Head-based, tail-based, and adaptive sampling
- **Trace Propagation:** Context propagation across service boundaries
- **Span Correlation:** Parent-child relationship modeling
- **Trace Storage:** Retention policies and storage optimization

#### Service Instrumentation
- **Auto-Instrumentation:** Framework-based automatic trace generation
- **Manual Instrumentation:** Custom span creation for business logic
- **Baggage Handling:** Cross-cutting concern propagation
- **Performance Impact:** Instrumentation overhead measurement and optimization

### Log Aggregation Patterns

#### Collection Architecture
- **Agent Deployment:** Log shipping agent strategies (push vs pull)
- **Log Routing:** Topic-based routing and filtering
- **Parsing Strategies:** Structured vs unstructured log handling
- **Schema Evolution:** Log format versioning and migration

#### Storage and Indexing
- **Index Design:** Optimized field indexing for common query patterns
- **Retention Policies:** Time and volume-based log retention
- **Compression:** Log data compression and archival strategies
- **Search Performance:** Query optimization and result caching

### Cost Optimization for Observability

The retention and sampling choices below keep the signal alive under a bounded telemetry budget. (Whether the ingestion spend itself is worth it — a cost-efficiency judgment — is out of scope here.)

#### Data Management
- **Metric Retention:** Tiered retention based on metric importance
- **Log Sampling:** Intelligent sampling to reduce ingestion costs
- **Trace Sampling:** Cost-effective trace collection strategies
- **Data Archival:** Cold storage for historical observability data

#### Resource Optimization
- **Query Efficiency:** Optimized metric and log queries
- **Storage Costs:** Appropriate storage tiers for different data types
- **Ingestion Rate Limiting:** Controlled data ingestion to manage costs
- **Cardinality Management:** High-cardinality metric detection and mitigation

## Method: turning agreed SLIs into signals

### SLI selection — consuming the SLO owner's definitions

These are the parameters you *wire*, not definitions you own: the SLO/error-budget math and burn-rate thresholds are out of scope here (see the boundary note above).
- **Pick SLIs that track user experience, not internals**: availability (ratio of good requests), latency (a percentile under a threshold), and — for request-driven services — the RED tuple (Rate, Errors, Duration). Resource health uses USE (Utilization, Saturation, Errors).
- **Express each SLI as a ratio of good events to total events** over a rolling window; the SLO is the target ratio (e.g. 99.9% over 30 days).
- **Error budget = 100% − SLO**, converted to allowed bad-minutes (0.1% of 30 days ≈ 43.2 min). The budget is the currency for release-velocity decisions.
- **Burn-rate alerting**: alert on how fast the budget is consumed. A fast-burn short window (e.g. 2% of budget in 1 h) pages; a slow-burn long window (e.g. 5% in 6 h) opens a ticket. Combining windows avoids both flapping and blind spots.
## Integration Patterns

### Monitoring Stack Integration
- **Prometheus:** Metric collection and alerting rule generation
- **Grafana:** Dashboard creation and visualization configuration
- **Elasticsearch/Kibana:** Log analysis and dashboard integration
- **Jaeger/Zipkin:** Distributed tracing configuration and analysis

### CI/CD Integration
- **Pipeline Monitoring:** Build, test, and deployment observability
- **Deployment Correlation:** Release impact tracking and rollback triggers
- **Feature Flag Monitoring:** A/B test and feature rollout observability
- **Performance Regression:** Automated performance monitoring in pipelines

### Incident Management Integration
- **PagerDuty/VictorOps:** Alert routing and escalation policies
- **Slack/Teams:** Notification and collaboration integration
- **JIRA/ServiceNow:** Incident tracking and resolution workflows
- **Post-Mortem:** Automated incident analysis and improvement tracking

## Advanced Patterns

### Multi-Cloud Observability
- **Cross-Cloud Metrics:** Unified metrics across AWS, GCP, Azure
- **Network Observability:** Inter-cloud connectivity monitoring
- **Cost Attribution:** Cloud resource cost tracking and optimization
- **Compliance Monitoring:** Security and compliance posture tracking

### Microservices Observability
- **Service Mesh Integration:** Istio/Linkerd observability configuration
- **API Gateway Monitoring:** Request routing and rate limiting observability
- **Container Orchestration:** Kubernetes cluster and workload monitoring
- **Service Discovery:** Dynamic service monitoring and health checks

## Best Practices

### Organizational Alignment
- **SLO Setting:** Collaborative target setting between product and engineering
- **Alert Ownership:** Clear escalation paths and team responsibilities
- **Dashboard Governance:** Centralized dashboard management and standards
- **Training Programs:** Team education on observability tools and practices

### Technical Excellence
- **Infrastructure as Code:** Observability configuration version control
- **Testing Strategy:** Alert rule testing and dashboard validation
- **Performance Monitoring:** Observability system performance tracking
- **Security Considerations:** Access control and data privacy in observability

### Continuous Improvement
- **Metrics Review:** Regular SLI/SLO effectiveness assessment
- **Alert Tuning:** Ongoing alert threshold and routing optimization
- **Dashboard Evolution:** User feedback-driven dashboard improvements
- **Tool Evaluation:** Regular assessment of observability tool effectiveness

## Provenance

- Source repo: https://github.com/alirezarezvani/claude-skills
- Original path: engineering/skills/observability-designer/SKILL.md
- License: MIT
- 并入说明（2026-09-07）：下载并归一为单文件（frontmatter 仅 name/description）；原仓库配套技能/辅助文件未随附，需要时回上游取用。
- Integration note (2026-09-07): fetched and normalized to single-file; sibling skills and auxiliary files of the source repo are not bundled - see upstream.
