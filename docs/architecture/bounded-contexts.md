# Bounded Contexts and Ownership

This document defines the core business domains for the Eventure platform and establishes clear ownership boundaries.

## Context Ownership Matrix

| Context | Primary Responsibility | Owns Data | Service Team |
| --- | --- | --- | --- |
| `event-core` | Event lifecycle, event metadata, event policies | Event profile, event state, event configuration | Event Core Team |
| `scheduling` | Session creation, agenda structure, speaker/session alignment | Session definitions, agenda order, schedule metadata | Scheduling Team |
| `registration` | Attendee onboarding and registration workflow | Registration records, attendee-to-event registration status | Registration Team |
| `ticketing` | Ticket products, pricing, inventory, issuance | Ticket catalog, ticket inventory, ticket assignment/issuance | Ticketing Team |
| `room-scheduling` | Room inventory and room-session allocation | Room capacity, room allocation, room constraints | Room Scheduling Team |
| `analytics` | KPI aggregation, dashboards, BI exports | Derived metrics, aggregate analytics tables | Analytics Team |
| `ai-planner` | AI-assisted planning recommendations and optimization | Recommendation models, planner suggestions, AI decision traces | AI Planner Team |
| `attendee-tracking` | Session-level attendance telemetry and movement signals | Attendance events, dwell/activity traces | Attendee Tracking Team |
| `lead-retrieval` | Sponsor/exhibitor lead capture workflows | Lead capture records, scan activity, sponsor lead exports | Lead Retrieval Team |
| `checkin` | On-site check-in and access validation | Check-in records, gate/session entry state | Check-in Team |

## Ownership Rules

1. Each bounded context has exactly one owning team accountable for schema evolution.
2. Other contexts consume published contracts and events; direct writes to foreign data stores are prohibited.
3. Cross-context integrations happen through:
   - synchronous command/query APIs (REST/gRPC), or
   - asynchronous domain events (pub/sub).
4. Shared concerns (identity, audit, notifications) are provided as platform services, not duplicated inside domain services.
