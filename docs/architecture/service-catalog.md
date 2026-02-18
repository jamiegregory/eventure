# Service Catalog

This catalog maps bounded contexts to service boundaries and identifies cross-cutting platform modules.

## Domain Services

| Service | Context | Interface Style | Publishes Events | Consumes Events |
| --- | --- | --- | --- | --- |
| `event-core-service` | `event-core` | REST/gRPC command/query | `EventCreated`, `EventUpdated`, `EventArchived` | Planning, registration, and ticketing lifecycle events |
| `scheduling-service` | `scheduling` | REST/gRPC command/query | `SessionScheduled`, `SessionUpdated`, `SessionCancelled` | `EventCreated`, `RoomAssigned` |
| `registration-service` | `registration` | REST/gRPC command/query | `RegistrationCompleted`, `RegistrationCancelled` | `EventPublished`, `TicketIssued` |
| `ticketing-service` | `ticketing` | REST/gRPC command/query | `TicketCreated`, `TicketIssued`, `TicketVoided` | `RegistrationCompleted`, payment status events |
| `room-scheduling-service` | `room-scheduling` | REST/gRPC command/query | `RoomAssigned`, `RoomReassigned` | `SessionScheduled` |
| `analytics-service` | `analytics` | REST/gRPC query + async ingestion | `AnalyticsSnapshotGenerated` | Most platform domain events |
| `ai-planner-service` | `ai-planner` | REST/gRPC command/query | `PlanRecommendationGenerated` | `EventCreated`, `SessionAttendanceUpdated`, `RegistrationCompleted` |
| `attendee-tracking-service` | `attendee-tracking` | REST/gRPC command/query + async ingest | `SessionAttendanceUpdated`, `AttendeeMovementCaptured` | `CheckinRecorded`, beacon/device feeds |
| `lead-retrieval-service` | `lead-retrieval` | REST/gRPC command/query | `LeadCaptured`, `LeadQualified` | `CheckinRecorded`, sponsor metadata updates |
| `checkin-service` | `checkin` | REST/gRPC command/query | `CheckinRecorded`, `CheckoutRecorded` | `RegistrationCompleted`, `TicketIssued` |

## Cross-Cutting Platform Services

| Service | Purpose | Key Capabilities |
| --- | --- | --- |
| `identity-access-service` | Centralized identity, authentication, authorization | RBAC/ABAC policy evaluation, service-to-service auth, tenant-aware identity context |
| `audit-compliance-service` | Compliance controls and immutable audit records | PII access logs, retention policy enforcement, audit export/hold workflows |
| `notification-service` | Outbound user/system messaging | Email/SMS/push/webhook delivery, template management, delivery tracking |

## API Style Standard

1. **Synchronous command/query paths** use REST or gRPC based on latency and type-safety needs.
2. **Asynchronous domain propagation** uses pub/sub topics with versioned contracts.
3. Commands return immediate status; eventual consistency is resolved via subscribed domain events.
