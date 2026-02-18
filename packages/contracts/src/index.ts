/**
 * Canonical identifier aliases used across Eventure domain and integration contracts.
 */
export type EventId = string;
export type SessionId = string;
export type AttendeeId = string;
export type TicketId = string;
export type RoomId = string;
export type LeadId = string;

/**
 * Canonical identifier field names for payload validation and schema generation.
 */
export const CANONICAL_ID_FIELDS = {
  event_id: "event_id",
  session_id: "session_id",
  attendee_id: "attendee_id",
  ticket_id: "ticket_id",
  room_id: "room_id"
} as const;

export const LEAD_ID_FIELD = "lead_id" as const;

/**
 * Shared envelope metadata present on every published domain event.
 */
export interface EventEnvelope {
  event_type: string;
  source: string;
  occurred_at: string;
  trace_id: string;
  tenant_id: string;
}

export interface RegistrationCompleted extends EventEnvelope {
  event_type: "RegistrationCompleted";
  payload: {
    event_id: EventId;
    attendee_id: AttendeeId;
    ticket_id: TicketId;
    registration_status: "completed";
  };
}

export interface CheckinRecorded extends EventEnvelope {
  event_type: "CheckinRecorded";
  payload: {
    event_id: EventId;
    attendee_id: AttendeeId;
    ticket_id: TicketId;
    checked_in_at: string;
  };
}

export interface SessionAttendanceUpdated extends EventEnvelope {
  event_type: "SessionAttendanceUpdated";
  payload: {
    event_id: EventId;
    session_id: SessionId;
    attendee_id: AttendeeId;
    room_id: RoomId;
    attendance_state: "present" | "absent" | "left";
  };
}

export interface LeadCaptured extends EventEnvelope {
  event_type: "LeadCaptured";
  payload: {
    lead_id: LeadId;
    event_id: EventId;
    attendee_id: AttendeeId;
    company_id: string;
    booth_id: string;
    badge_scan_id: string;
    consent_policy_version: string;
  };
}

export interface LeadQualified extends EventEnvelope {
  event_type: "LeadQualified";
  payload: {
    lead_id: LeadId;
    attendee_id: AttendeeId;
    company_id: string;
    booth_id: string;
    interest_level: "hot" | "warm" | "cold";
    product_interest: string[];
  };
}

export interface LeadExported extends EventEnvelope {
  event_type: "LeadExported";
  payload: {
    lead_id: LeadId;
    attendee_id: AttendeeId;
    company_id: string;
    booth_id: string;
    exported_by: string;
  };
}

export type DomainEvent =
  | RegistrationCompleted
  | CheckinRecorded
  | SessionAttendanceUpdated
  | LeadCaptured
  | LeadQualified
  | LeadExported;
