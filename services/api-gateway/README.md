# API Gateway

Role-aware gateway that routes `/api/v1/organizer/*` traffic to organizer-bff and `/api/v1/attendee/*` traffic to attendee-bff.

## Capabilities
- Role-aware routing (`admin|organizer` required for organizer routes)
- Auth token propagation (bearer token forwarded to BFF handlers)
- In-memory rate limiting
- Request tracing via `x-trace-id`
- Versioned APIs (`/api/v1/...`)
