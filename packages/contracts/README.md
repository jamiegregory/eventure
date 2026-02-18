# @eventure/contracts

Shared schema package for canonical identifiers and event envelope metadata.

## Includes

- Canonical ID field names:
  - `event_id`
  - `session_id`
  - `attendee_id`
  - `ticket_id`
  - `room_id`
- Shared event envelope fields:
  - `event_type`
  - `source`
  - `occurred_at`
  - `trace_id`
  - `tenant_id`
- Core example domain event contracts:
  - `RegistrationCompleted`
  - `CheckinRecorded`
  - `SessionAttendanceUpdated`
