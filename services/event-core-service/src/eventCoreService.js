const VALID_STATES = Object.freeze({
  DRAFT: "draft",
  PUBLISHED: "published",
  ARCHIVED: "archived"
});

function validateSessionEntity(session) {
  const requiredFields = ["id", "title", "durationMinutes", "speakerId", "track", "requiredRoomFeatures"];
  for (const field of requiredFields) {
    if (session[field] === undefined || session[field] === null) {
      throw new Error(`Session missing required field: ${field}`);
    }
  }

  if (!Number.isInteger(session.durationMinutes) || session.durationMinutes <= 0) {
    throw new Error("Session durationMinutes must be a positive integer");
  }

  if (!Array.isArray(session.requiredRoomFeatures)) {
    throw new Error("Session requiredRoomFeatures must be an array");
  }
}

export class EventCoreService {
  constructor() {
    this.events = new Map();
  }

  createDraftEvent({ id, name, tenantId = "public" }) {
    if (!id || !name) {
      throw new Error("Event id and name are required");
    }

    const event = {
      id,
      name,
      tenantId,
      lifecycleState: VALID_STATES.DRAFT,
      sessions: []
    };

    this.events.set(id, event);
    return event;
  }

  addSessionToEvent(eventId, session) {
    const event = this.getEventOrThrow(eventId);
    if (event.lifecycleState !== VALID_STATES.DRAFT) {
      throw new Error("Sessions can only be added while event is in draft state");
    }

    validateSessionEntity(session);
    event.sessions.push({ ...session });
    return event;
  }

  publishEvent(eventId) {
    const event = this.getEventOrThrow(eventId);
    if (event.lifecycleState !== VALID_STATES.DRAFT) {
      throw new Error("Only draft events can be published");
    }

    event.lifecycleState = VALID_STATES.PUBLISHED;
    return event;
  }

  archiveEvent(eventId) {
    const event = this.getEventOrThrow(eventId);
    if (event.lifecycleState !== VALID_STATES.PUBLISHED) {
      throw new Error("Only published events can be archived");
    }

    event.lifecycleState = VALID_STATES.ARCHIVED;
    return event;
  }

  getEventOrThrow(eventId) {
    const event = this.events.get(eventId);
    if (!event) {
      throw new Error(`Event not found: ${eventId}`);
    }

    return event;
  }
}

export { VALID_STATES, validateSessionEntity };
