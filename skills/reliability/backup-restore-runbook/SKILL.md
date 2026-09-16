---
name: backup-restore-runbook
description: Creates comprehensive disaster recovery procedures with automated backup scripts, restore procedures, validation checks, and role assignments. Use for "database backup", "disaster recovery", "data restore", or "DR planning".
---

# Backup/Restore Runbook Generator

Create reliable disaster recovery procedures for your databases.

## Backup Strategy

Design the strategy first; it is the contract the runbook enforces. Inline concrete numbers for the target database — no placeholders in the final runbook.

### Backup types and retention

| Type                          | Cadence                              | Retention | Restores to      |
| ----------------------------- | ------------------------------------ | --------- | ---------------- |
| Full                          | Daily (e.g. 02:00 UTC; ~50 GB, ~45m) | 30 days   | Backup time      |
| Incremental                   | Hourly (~500 MB, ~5m)                | 7 days    | Last incremental |
| Transaction log / WAL         | Every 15 min                         | 3 days    | Any point (PITR) |

Rules:

- **Off-host, multi-location**: object storage (e.g. `s3://backups/`) plus a cross-region/account copy. Local disk is staging, never the system of record.
- **Retention ≥ the longest committed recovery scenario** — a 30-day full retention cannot recover 40-day-old corruption; the published RTO/RPO must be reachable from the oldest retained artifact.
- **Encrypt at rest**; backups are production data.
- **RPO is set by the highest-frequency capture**: with 15-minute log shipping, worst-case data loss is 15 minutes.

## Backup Execution

Take the backup with the native tool, then verify before declaring success:

- **PostgreSQL** — a full logical backup with `pg_dump --format=custom --compress=9` (custom format is what `pg_restore` needs), or a physical base backup with `pg_basebackup` for a PITR chain. Read host/user/db from config; never hard-code credentials.
- **MySQL** — a consistent logical backup with `mysqldump --single-transaction --quick --lock-tables=false` so InnoDB writes are not blocked; stream through `gzip` to the staging path.
- **Verify, then ship**: assert the artifact exists and its size is plausible *before* uploading; after upload, confirm the object is listed in the bucket. A backup that silently failed is worse than no backup.
- **Retention enforcement**: prune local staging (e.g. keep 7 days) only after a verified upload — never prune the remote copy on the local schedule.
- **Notify on completion** (Slack/webhook) with filename and size, so a missing notification is itself a signal.

## Restore Procedures

### Full restore

Sequence (each step gated on the previous):

1. **Fetch** the chosen artifact from object storage into a scratch path.
2. **Create a fresh, empty database** (e.g. `production_restored`) — never restore over the live database; cutover happens later.
3. **Restore** with `pg_restore` (custom-format dumps) against the new database.
4. **Verify before cutover**: table count, row counts of critical tables, constraints, indexes (see Validation Checks). A restore is not "done" until validated.

### Point-in-time recovery (PITR)

PITR needs a **base backup** plus a **continuous WAL archive**. Watch the common conflation:

- `pg_basebackup` **takes** a base backup; it is not itself a recovery action. Recovery replays WAL on top of an already-restored base backup.
- **`recovery.conf` no longer exists — it was removed in PostgreSQL 12.** On PG 12+ recovery is configured by:
  - placing an **empty `recovery.signal`** file in the data directory, and
  - setting parameters in `postgresql.conf`: `restore_command` (e.g. `aws s3 cp s3://my-backups/wal/%f %p`), `recovery_target_time = '<timestamp>'`, and `recovery_target_action = 'promote'` (promote = accept writes once the target is reached).
- **PostgreSQL ≤ 11 only**: the old flow still applies — write those same parameters to `recovery.conf` instead of using `recovery.signal` + `postgresql.conf`.
- Start the server; it enters recovery, replays WAL to the target, then promotes. Wait on readiness (`pg_isready`) before declaring success, and confirm the promoted node accepts writes.

## Validation Checks

A restore is only proven by validation. Check, in order:

1. **Schema completeness** — table count in `public` meets the expected minimum (e.g. ≥10); a near-empty schema means a silent failure.
2. **Row presence** — critical tables (e.g. `users`, `products`, `orders`) are non-empty; assert a threshold, not just "exists".
3. **Constraints** — foreign-key count matches expectations (partial restores often drop FKs).
4. **Indexes** — index count in the restored schema matches the source.
5. **Query performance** — time a representative query (e.g. a filtered `COUNT(*)`); if it exceeds ~1s where it should be sub-second, indexes were likely lost.
6. **Application-level** — the app can connect and read through the restored database before cutover.

## Disaster Recovery Runbook

### 1. Assess situation (5 minutes)

- [ ] Identify incident severity (P0/P1/P2)
- [ ] Determine the data-loss window
- [ ] Notify stakeholders

**Contacts:**

- DBA On-Call: [phone]
- Engineering Lead: [phone]
- CTO: [phone]

### 2. Stop the bleeding (10 minutes)

- [ ] Enable maintenance mode
- [ ] Stop writes to the corrupted database
- [ ] Preserve evidence (logs, backups)

```bash
# Enable maintenance mode
kubectl scale deployment/api --replicas=0
```

### 3. Identify the recovery point (15 minutes)

- [ ] Determine the last good backup
- [ ] Check backup integrity
- [ ] Calculate data loss

```bash
# List available backups
aws s3 ls s3://my-backups/postgres/ | tail -20

# Check backup size
aws s3 ls s3://my-backups/postgres/production_20240115_020000.sql.gz --human-readable
```

### 4. Prepare the recovery environment (30 minutes)

- [ ] Spin up a new database instance
- [ ] Configure networking
- [ ] Test connectivity

```bash
# Create a recovery instance
aws rds create-db-instance \
  --db-instance-identifier production-recovery \
  --db-instance-class db.r6g.xlarge \
  --engine postgres \
  --master-username postgres \
  --master-user-password [secure-password]
```

### 5. Execute the restore (1-2 hours)

- [ ] Download the backup from object storage
- [ ] Run the full-restore (or PITR) procedure above
- [ ] Apply transaction logs (if PITR)
- [ ] Verify data integrity

### 6. Validate and test (30 minutes)

- [ ] Run the validation checks above
- [ ] Test critical queries
- [ ] Verify row counts
- [ ] Check data consistency

### 7. Cutover (15 minutes)

- [ ] Update application config
- [ ] Point DNS to the new database
- [ ] Disable maintenance mode
- [ ] Monitor for errors

```bash
# Update connection string
kubectl set env deployment/api DATABASE_URL=postgresql://...

# Scale up
kubectl scale deployment/api --replicas=3
```

### 8. Post-recovery (1 hour)

- [ ] Monitor system health
- [ ] Verify user reports
- [ ] Document the incident
- [ ] Schedule a postmortem

## Recovery Time Objective (RTO)

| Scenario        | Target     | Actual     |
| --------------- | ---------- | ---------- |
| Full restore    | 2 hours    | [measured] |
| PITR restore    | 3 hours    | [measured] |
| Region failover | 15 minutes | [measured] |

## Recovery Point Objective (RPO)

| Backup Type      | Data Loss Window |
| ---------------- | ---------------- |
| Full backup      | 24 hours         |
| Incremental      | 1 hour           |
| Transaction logs | 15 minutes       |

**Derivation.** Derive RTO from the sum of the restore steps — fetch + provision + restore + validate + cutover — not from a wish. Derive RPO from the capture frequency of the newest artifact you actually retain. Publish either only after it has been demonstrated in a drill; mark estimated values as estimates.

## Backup Monitoring

Backups fail silently, so monitor the *absence* of backups, not only their errors:

- **Freshness gate** — alert if no new backup appeared in the last N hours (e.g. > 25 h for a daily full). This catches the "scheduler died" case.
- **Size sanity** — alert if the latest artifact is implausibly small (e.g. < 10 GB when ~50 GB is typical); a truncated dump looks like success.
- **Restore proof** — the strongest signal is a recent *successful restore drill*, not a recent backup file.
- **Routing** — page the on-call DBA on a freshness violation; run the check on a schedule independent of the backup job.

## Role Assignments

### Database Administrator (Primary)

- Execute restore procedures
- Verify data integrity
- Monitor recovery progress

### Engineering Lead

- Coordinate response
- Communicate with stakeholders
- Make cutover decisions

### DevOps Engineer

- Provision infrastructure
- Update application configs
- Monitor system health

### Product Manager

- Assess business impact
- Prioritize recovery
- Customer communication

### Escalation Path

1. DBA on-call →
2. Engineering Lead →
3. CTO →
4. CEO (P0 incidents only)

## Best Practices

1. **Test restores regularly**: quarterly DR drills — at least one full restore per quarter
2. **Automate backups**: never rely on manual processes
3. **Multiple locations**: cross-region backup storage
4. **Monitor backup health**: alert on failures and on silence
5. **Document procedures**: keep the runbook updated
6. **Encrypt backups**: protect sensitive data
7. **Version control**: track backup/restore procedure changes
