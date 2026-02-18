# Event-Driven Contracts

This document defines eventing conventions for domain interoperability across Eventure.

## Integration Style

- Use **REST/gRPC** for synchronous command/query workflows.
- Use **pub/sub domain events** for asynchronous state propagation and integration.

## Event Envelope Standard

Every event on the bus must include the shared envelope fields defined in `packages/contracts`:

- `event_type`: stable event name (e.g., `RegistrationCompleted`)
- `source`: emitting service identifier
- `occurred_at`: RFC 3339 timestamp in UTC
- `trace_id`: distributed trace correlation id
- `tenant_id`: tenant boundary identifier

## Required Domain Events

At minimum, the platform publishes and consumes these core events:

- `RegistrationCompleted`
- `CheckinRecorded`
- `SessionAttendanceUpdated`

Additional events may be defined per context, but they must reuse canonical IDs and the standard envelope.

## Contract Governance

1. Contracts are versioned and backward-compatible by default.
2. Breaking changes require a new event version and migration window.
3. Producers own event semantics; consumers own idempotent handling and retries.
4. PII payload fields must be tagged for auditing and retention rules.
