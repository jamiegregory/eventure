import crypto from "node:crypto";

const EVENT_TYPES = Object.freeze({
  CHECK_IN: "check-in",
  SESSION_SCAN: "session-scan",
  BEACON_PROXIMITY: "beacon-proximity"
});

function toMillis(timestamp) {
  return new Date(timestamp).getTime();
}

function normalizeTimestamp(timestamp) {
  if (!timestamp) {
    return new Date().toISOString();
  }

  const millis = toMillis(timestamp);
  if (Number.isNaN(millis)) {
    throw new Error(`Invalid timestamp: ${timestamp}`);
  }

  return new Date(millis).toISOString();
}


function initializeContextState() {
  return {
    open: null,
    intervals: []
  };
}

function appendInterval(context, start, end) {
  context.intervals.push({
    enteredAt: start,
    exitedAt: end
  });
}

function closeOpenInterval(context, exitAt) {
  if (!context.open) {
    return;
  }

  appendInterval(context, context.open, exitAt);
  context.open = null;
}

function getIntervalDuration(interval) {
  if (!interval.exitedAt) {
    return 0;
  }

  return Math.max(0, toMillis(interval.exitedAt) - toMillis(interval.enteredAt));
}

function hasOverlap(left, right) {
  const leftStart = toMillis(left.enteredAt);
  const leftEnd = toMillis(left.exitedAt);
  const rightStart = toMillis(right.enteredAt);
  const rightEnd = toMillis(right.exitedAt);

  return leftStart < rightEnd && rightStart < leftEnd;
}

function clampToBefore(isoTimestamp, beforeIso) {
  if (!beforeIso) {
    return true;
  }

  return toMillis(isoTimestamp) <= toMillis(beforeIso);
}

class InMemoryAnalyticsPublisher {
  constructor() {
    this.messages = [];
  }

  publish(type, payload) {
    const message = {
      type,
      payload,
      publishedAt: new Date().toISOString()
    };

    this.messages.push(message);
    return message;
  }

  allMessages() {
    return [...this.messages];
  }
}

export class AttendeeTrackingService {
  constructor({
    analyticsPublisher = new InMemoryAnalyticsPublisher(),
    retention = { eventRetentionMs: 7 * 24 * 60 * 60 * 1000, timelineRetentionMs: 30 * 24 * 60 * 60 * 1000 }
  } = {}) {
    this.analyticsPublisher = analyticsPublisher;
    this.retention = retention;
    this.rawEvents = [];
    this.attendeeTimelines = new Map();
    this.consentRegistry = new Map();
  }

  registerConsent(attendeeId, consent = {}) {
    const normalized = {
      tracking: consent.tracking !== false,
      analytics: consent.analytics !== false,
      updatedAt: new Date().toISOString()
    };

    this.consentRegistry.set(attendeeId, normalized);
    return normalized;
  }

  ingestEvent(event) {
    this.validateEvent(event);

    const timestamp = normalizeTimestamp(event.timestamp);
    const consent = this.getEffectiveConsent(event.attendeeId, event.consent);

    if (!consent.tracking) {
      return {
        accepted: false,
        reason: "tracking-consent-disabled",
        eventType: event.type,
        attendeeId: event.attendeeId
      };
    }

    const minimized = this.minimizeEventData({ ...event, timestamp, consent });
    this.rawEvents.push(minimized);

    const timeline = this.getOrCreateTimeline(minimized.attendeeId);
    this.applyTimelineEvent(timeline, minimized);

    return {
      accepted: true,
      eventType: minimized.type,
      attendeeId: minimized.attendeeId
    };
  }

  getTimeline(attendeeId) {
    const timeline = this.attendeeTimelines.get(attendeeId);
    if (!timeline) {
      return null;
    }

    return structuredClone({
      attendeeId,
      venue: timeline.venue,
      sessions: timeline.sessions,
      zones: timeline.zones,
      updatedAt: timeline.updatedAt
    });
  }

  computeEngagementMetrics(attendeeId) {
    const timeline = this.attendeeTimelines.get(attendeeId);
    if (!timeline) {
      return {
        attendeeId,
        sessionsAttended: 0,
        overlapAnomalies: [],
        dwellDurationMs: { sessions: 0, zones: 0 }
      };
    }

    const sessionDurations = {};
    let sessionsTotal = 0;
    const sessionEntries = Object.entries(timeline.sessions);

    for (const [sessionId, state] of sessionEntries) {
      const duration = state.intervals.reduce((sum, interval) => sum + getIntervalDuration(interval), 0);
      sessionDurations[sessionId] = duration;
      sessionsTotal += duration;
    }

    const zoneDurations = {};
    let zonesTotal = 0;
    for (const [zoneId, state] of Object.entries(timeline.zones)) {
      const duration = state.intervals.reduce((sum, interval) => sum + getIntervalDuration(interval), 0);
      zoneDurations[zoneId] = duration;
      zonesTotal += duration;
    }

    const overlapAnomalies = this.collectOverlapAnomalies(timeline.sessions);

    return {
      attendeeId,
      sessionsAttended: sessionEntries.filter(([, state]) => state.intervals.length > 0).length,
      overlapAnomalies,
      dwellDurationMs: {
        sessions: sessionsTotal,
        zones: zonesTotal,
        bySession: sessionDurations,
        byZone: zoneDurations
      }
    };
  }

  applyRetentionPolicy({ now = Date.now() } = {}) {
    const { eventRetentionMs, timelineRetentionMs } = this.retention;
    const eventCutoff = now - eventRetentionMs;
    const timelineCutoff = now - timelineRetentionMs;

    this.rawEvents = this.rawEvents.filter((event) => toMillis(event.timestamp) >= eventCutoff);

    for (const [attendeeId, timeline] of this.attendeeTimelines) {
      if (toMillis(timeline.updatedAt) < timelineCutoff) {
        this.attendeeTimelines.delete(attendeeId);
      }
    }

    return {
      retainedEvents: this.rawEvents.length,
      retainedTimelines: this.attendeeTimelines.size
    };
  }

  runAnonymizationJob({ salt = "eventure", before } = {}) {
    const anonymizedIds = new Map();

    const anonymize = (attendeeId) => {
      if (anonymizedIds.has(attendeeId)) {
        return anonymizedIds.get(attendeeId);
      }

      const hash = crypto.createHash("sha256").update(`${salt}:${attendeeId}`).digest("hex").slice(0, 16);
      const anonId = `anon_${hash}`;
      anonymizedIds.set(attendeeId, anonId);
      return anonId;
    };

    this.rawEvents = this.rawEvents.map((event) => {
      if (!clampToBefore(event.timestamp, before)) {
        return event;
      }

      return {
        ...event,
        attendeeId: anonymize(event.attendeeId)
      };
    });

    for (const [attendeeId, timeline] of [...this.attendeeTimelines.entries()]) {
      if (!clampToBefore(timeline.updatedAt, before)) {
        continue;
      }

      const anonId = anonymize(attendeeId);
      this.attendeeTimelines.delete(attendeeId);
      this.attendeeTimelines.set(anonId, {
        ...timeline,
        attendeeId: anonId
      });
    }

    for (const [attendeeId, consent] of [...this.consentRegistry.entries()]) {
      const anonId = anonymize(attendeeId);
      this.consentRegistry.delete(attendeeId);
      this.consentRegistry.set(anonId, consent);
    }

    return {
      anonymizedAttendees: anonymizedIds.size
    };
  }

  publishAggregatesForAnalytics({ emittedAt = new Date().toISOString() } = {}) {
    const bySession = {};
    const byZone = {};

    for (const [attendeeId, timeline] of this.attendeeTimelines.entries()) {
      const consent = this.consentRegistry.get(attendeeId) ?? { analytics: true };
      if (!consent.analytics) {
        continue;
      }

      for (const [sessionId, state] of Object.entries(timeline.sessions)) {
        bySession[sessionId] ??= { uniqueAttendees: new Set(), dwellDurationMs: 0 };
        bySession[sessionId].uniqueAttendees.add(attendeeId);
        bySession[sessionId].dwellDurationMs += state.intervals.reduce(
          (sum, interval) => sum + getIntervalDuration(interval),
          0
        );
      }

      for (const [zoneId, state] of Object.entries(timeline.zones)) {
        byZone[zoneId] ??= { uniqueAttendees: new Set(), dwellDurationMs: 0 };
        byZone[zoneId].uniqueAttendees.add(attendeeId);
        byZone[zoneId].dwellDurationMs += state.intervals.reduce(
          (sum, interval) => sum + getIntervalDuration(interval),
          0
        );
      }
    }

    const payload = {
      emittedAt,
      sessions: Object.entries(bySession).map(([sessionId, value]) => ({
        sessionId,
        uniqueAttendees: value.uniqueAttendees.size,
        dwellDurationMs: value.dwellDurationMs
      })),
      zones: Object.entries(byZone).map(([zoneId, value]) => ({
        zoneId,
        uniqueAttendees: value.uniqueAttendees.size,
        dwellDurationMs: value.dwellDurationMs
      }))
    };

    return this.analyticsPublisher.publish("AttendeeEngagementAggregates", payload);
  }

  validateEvent(event) {
    if (!event || typeof event !== "object") {
      throw new Error("Event payload is required");
    }

    if (!event.attendeeId) {
      throw new Error("Event attendeeId is required");
    }

    if (!Object.values(EVENT_TYPES).includes(event.type)) {
      throw new Error(`Unsupported event type: ${event.type}`);
    }

    if (event.type === EVENT_TYPES.SESSION_SCAN && !event.sessionId) {
      throw new Error("Session scan event requires sessionId");
    }

    if (event.type === EVENT_TYPES.BEACON_PROXIMITY && !event.zoneId) {
      throw new Error("Beacon proximity event requires zoneId");
    }
  }

  getEffectiveConsent(attendeeId, consentFromEvent = {}) {
    const existing = this.consentRegistry.get(attendeeId) ?? {};
    const merged = {
      tracking: consentFromEvent.tracking ?? existing.tracking ?? true,
      analytics: consentFromEvent.analytics ?? existing.analytics ?? true,
      updatedAt: new Date().toISOString()
    };

    this.consentRegistry.set(attendeeId, merged);
    return merged;
  }

  minimizeEventData(event) {
    const base = {
      type: event.type,
      attendeeId: event.attendeeId,
      timestamp: event.timestamp,
      consent: {
        tracking: event.consent.tracking,
        analytics: event.consent.analytics
      }
    };

    if (event.type === EVENT_TYPES.SESSION_SCAN) {
      return {
        ...base,
        sessionId: event.sessionId,
        action: event.action ?? "enter"
      };
    }

    if (event.type === EVENT_TYPES.BEACON_PROXIMITY) {
      return {
        ...base,
        zoneId: event.zoneId,
        action: event.action ?? "enter",
        proximityBand: event.proximityBand ?? "near"
      };
    }

    return {
      ...base,
      action: event.action ?? "enter"
    };
  }

  getOrCreateTimeline(attendeeId) {
    if (!this.attendeeTimelines.has(attendeeId)) {
      this.attendeeTimelines.set(attendeeId, {
        attendeeId,
        venue: initializeContextState(),
        sessions: {},
        zones: {},
        updatedAt: new Date().toISOString()
      });
    }

    return this.attendeeTimelines.get(attendeeId);
  }

  applyTimelineEvent(timeline, event) {
    if (event.type === EVENT_TYPES.CHECK_IN) {
      this.applyContextTransition(timeline.venue, event.action, event.timestamp);
    }

    if (event.type === EVENT_TYPES.SESSION_SCAN) {
      timeline.sessions[event.sessionId] ??= initializeContextState();
      this.applyContextTransition(timeline.sessions[event.sessionId], event.action, event.timestamp);
    }

    if (event.type === EVENT_TYPES.BEACON_PROXIMITY) {
      timeline.zones[event.zoneId] ??= initializeContextState();
      this.applyContextTransition(timeline.zones[event.zoneId], event.action, event.timestamp);
    }

    timeline.updatedAt = event.timestamp;
  }

  applyContextTransition(contextState, action, timestamp) {
    if (action === "exit") {
      closeOpenInterval(contextState, timestamp);
      return;
    }

    if (contextState.open) {
      closeOpenInterval(contextState, timestamp);
    }

    contextState.open = timestamp;
  }

  collectOverlapAnomalies(sessions) {
    const entries = Object.entries(sessions);
    const anomalies = [];

    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const [leftSessionId, leftState] = entries[i];
        const [rightSessionId, rightState] = entries[j];

        for (const leftInterval of leftState.intervals) {
          for (const rightInterval of rightState.intervals) {
            if (!hasOverlap(leftInterval, rightInterval)) {
              continue;
            }

            anomalies.push({
              type: "session-overlap",
              leftSessionId,
              rightSessionId,
              leftInterval,
              rightInterval
            });
          }
        }
      }
    }

    return anomalies;
  }
}

export { EVENT_TYPES, InMemoryAnalyticsPublisher };
