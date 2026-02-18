# Platform Readiness Plan

This plan defines the production-readiness work needed to support Eventure's domain expansion, compliance requirements, and peak on-site operations.

## 1) Observability Stack

### Distributed Tracing

- Adopt OpenTelemetry instrumentation across all synchronous APIs (REST/gRPC), asynchronous event handlers, and external integrations.
- Propagate W3C trace-context headers (`traceparent`, `tracestate`) through API gateways and event envelopes to preserve end-to-end causality.
- Standardize span naming conventions:
  - `<context>.<operation>.command` for writes
  - `<context>.<operation>.query` for reads
  - `<context>.<event>.consume` for event subscribers
- Export traces to a centralized backend (Jaeger/Tempo/Datadog/New Relic equivalent) with service maps and dependency graphs enabled.
- Capture high-cardinality business dimensions as span attributes only where needed (event ID, tenant ID, venue ID) and use sampling policies to control cost.

### Service SLOs

Define and monitor service-level objectives for each critical domain path:

| Service | SLI | Initial SLO | Alert Trigger |
| --- | --- | --- | --- |
| `event-core-service` | API availability | 99.95% monthly | Burn rate > 2x over 1 hour |
| `scheduling-service` | p95 command latency (`publish schedule`) | < 800 ms | p95 > 800 ms for 15 min |
| `registration-service` | registration completion success rate | > 99.5% daily | error budget burn > 5% daily |
| `ticketing-service` | ticket issuance success rate | > 99.7% daily | issuance failures > 0.3% over 30 min |
| `checkin-service` | check-in confirmation latency p95 | < 350 ms | p95 > 350 ms for 10 min |
| `attendee-tracking-service` | ingestion lag | < 60 seconds p95 | lag > 120 seconds for 15 min |

Implementation notes:

- Publish SLO dashboards by service and by event/tenant.
- Use multi-window, multi-burn-rate alerting to reduce noise.
- Require every service to expose RED/USE-style metrics and health probes.

### Domain-Level Business Alerts

Define business alerts that map directly to operational risk:

- **Registration funnel degradation:** registration completion drops below baseline during active campaigns.
- **Ticket oversell risk:** available inventory < dynamic safety threshold while issuance retries increase.
- **Check-in gate congestion:** check-in throughput per gate falls below expected floor for > 10 minutes.
- **Session attendance anomaly:** attendance drops sharply versus forecast for key sessions.
- **Lead capture outage:** sponsor lead scans stop while check-ins continue (possible scanner/device integration failure).

All domain alerts must include runbook links, owning team, severity policy, and automatic ticket creation.

## 2) Compliance Controls

### GDPR/CCPA Data Subject Workflows

Implement a central workflow orchestrated by `audit-compliance-service`:

- **Access request (DSAR):** collect and export all personal data linked to a subject across contexts.
- **Deletion request (Right to Erasure):** perform policy-driven delete/anonymize actions with legal hold checks.
- **Rectification request:** propagate user profile corrections to downstream projections.
- **Opt-out / Do Not Sell or Share (CCPA):** enforce processing restrictions and suppress downstream sharing.

Control requirements:

- Subject identity verification before workflow execution.
- SLA tracking and deadlines by jurisdiction.
- Immutable audit logs for all workflow steps and approvals.
- Data lineage mapping from source services to analytics exports.

### Encryption at Rest / In Transit

- Enforce TLS 1.2+ (prefer TLS 1.3) for all north-south and east-west traffic.
- Require mutual TLS for service-to-service communication in production.
- Encrypt all persistent storage (databases, object stores, backups, event archives) using provider-managed or customer-managed keys.
- Encrypt sensitive fields at application level where breach blast radius must be reduced (PII, attendee identifiers, payment references).

### Key Rotation and Secrets Management

- Centralize secrets in a managed secrets platform (e.g., Vault/cloud secret manager) with short-lived credentials.
- Rotate encryption keys and service credentials at defined intervals (90 days maximum for non-ephemeral secrets).
- Use automatic key versioning and rolling re-encryption for stored data.
- Block plaintext secrets in code/config via CI policy checks and pre-commit scanning.
- Require emergency key revocation and break-glass procedures with post-incident audit.

## 3) Rollout Phases

### Phase 1 (Foundation)

Scope:

- `event-core`
- `scheduling`
- `registration`
- `ticketing`

Exit criteria:

- Core lifecycle events are contract-versioned and replay-safe.
- SLO dashboards + on-call alerting active for all Phase 1 services.
- Compliance workflow MVP supports access and deletion requests for Phase 1 data domains.

### Phase 2 (On-Site Operations)

Scope:

- `room-scheduling`
- `checkin`
- `attendee-tracking`

Exit criteria:

- End-to-end tracing covers gate entry through attendance ingestion.
- Peak on-site load tests validated against event-day target throughput.
- Business alerts tuned for gate congestion and attendance anomalies.

### Phase 3 (Revenue + Intelligence)

Scope:

- `lead-retrieval`
- analytics deepening
- `ai-planner`

Exit criteria:

- Sponsor lead capture data is observable and auditable.
- Analytics pipelines meet freshness SLO and lineage requirements.
- AI planner includes explainability traces and policy-based guardrails.

## 4) Migration Playbooks and Historical Backfills

Create standardized migration playbooks for each context:

1. **Readiness checklist:** schema diffs, compatibility matrix, rollback plan.
2. **Dry run:** execute on production-like snapshot with timing + error-rate capture.
3. **Cutover strategy:** blue/green or dual-write transition with reconciliation windows.
4. **Validation:** row counts, domain invariants, event replay integrity checks.
5. **Rollback:** deterministic restore steps and communication protocol.

Historical backfill jobs requirements:

- Rehydrate historical events into new projections with idempotent consumers.
- Use checkpointed batch windows to allow safe restarts.
- Maintain provenance metadata (`source_system`, `source_timestamp`, `backfill_job_id`).
- Apply throttling to avoid starving live traffic.
- Compare pre/post aggregates and publish variance reports.

## 5) Load and Failure-Mode Validation for Peak Onsite Traffic

### Load Validation

- Build workload models for check-in bursts, session transitions, and sponsor-hall scans.
- Define target traffic envelopes for average, p95, and surge conditions.
- Execute closed-loop and open-loop tests against production-like environments.
- Track saturation indicators (CPU, memory, queue lag, DB lock/contention, downstream latency).

### Failure-Mode Validation

Run regular game-day exercises for:

- Broker/topic partition degradation.
- Database primary failover and replica lag spikes.
- Regional network latency and transient dependency outages.
- Expired certificates/secrets and forced key rotation events.
- Partial mobile scanner/offline device synchronization failures.

Success criteria:

- Auto-scaling and circuit breakers keep critical user journeys within degraded-mode SLOs.
- Recovery point objective (RPO) and recovery time objective (RTO) met for tier-1 services.
- Incident runbooks validated with timestamped response timelines and follow-up actions.

## Deliverables and Governance

- Architecture Decision Records (ADRs) for tracing standards, compliance workflow design, and key management strategy.
- Quarterly readiness reviews with domain owners and platform SRE/security teams.
- A single readiness scorecard tracking SLO status, compliance SLA status, migration completion, and resilience-test pass rate.
