# Eventure Services

This repository contains a lightweight implementation of:

- `event-core-service` with event lifecycle management and session entities.
- `scheduling-service` with proposal/validate/publish scheduling APIs, conflict rules, read model, and event emission.
- `notification-service` integration for attendee/speaker schedule change notices.
- `attendee-tracking-service` for check-in/session/beacon ingestion, timeline modeling, privacy controls, and analytics aggregates.
- `checkin-service` with attendee lookup (QR/barcode/manual), idempotent check-in transactions, self-serve/staff onsite modes, badge print queue handling, offline sync conflict resolution, event emission (`CheckinRecorded`, `BadgePrinted`, `CheckinReversed`), and operational dashboard metrics.

Run tests with:

```bash
npm test
```
## Architecture

- `docs/architecture/platform-readiness-plan.md`: observability, compliance, rollout phases, migration/backfill, and resilience validation plan.

