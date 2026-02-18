const EVENT_TYPES = Object.freeze({
  DRAFTED: "ScheduleDrafted",
  PUBLISHED: "SchedulePublished",
  CHANGED: "ScheduleChanged"
});

function overlaps(a, b) {
  return a.startTime < b.endTime && b.startTime < a.endTime;
}

function toMinutes(iso) {
  return new Date(iso).getTime();
}

function normalizeSlot(slot) {
  return {
    ...slot,
    startTime: toMinutes(slot.startTime),
    endTime: toMinutes(slot.endTime)
  };
}

function collectConflicts(slots) {
  const conflicts = [];
  const normalized = slots.map(normalizeSlot);

  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = i + 1; j < normalized.length; j += 1) {
      const left = normalized[i];
      const right = normalized[j];

      if (!overlaps(left, right)) {
        continue;
      }

      if (left.speakerId === right.speakerId) {
        conflicts.push({
          type: "speaker-overlap",
          leftSessionId: left.sessionId,
          rightSessionId: right.sessionId,
          speakerId: left.speakerId
        });
      }

      if (left.roomId === right.roomId) {
        conflicts.push({
          type: "room-double-booking",
          leftSessionId: left.sessionId,
          rightSessionId: right.sessionId,
          roomId: left.roomId
        });
      }

      if (left.track === right.track && left.roomId !== right.roomId) {
        conflicts.push({
          type: "track-constraint",
          leftSessionId: left.sessionId,
          rightSessionId: right.sessionId,
          track: left.track,
          rule: "track sessions must share the same room when overlapping"
        });
      }
    }
  }

  return conflicts;
}

export class SchedulingService {
  constructor({ eventBus, notificationService }) {
    this.eventBus = eventBus;
    this.notificationService = notificationService;
    this.proposals = new Map();
    this.publishedSchedules = new Map();
    this.attendeePreferences = new Map();
  }

  // API: POST /proposals
  createProposal({ scheduleId, slots, attendeeIds = [], tenantId = "public" }) {
    const proposal = {
      scheduleId,
      tenantId,
      slots,
      attendeeIds,
      status: "draft",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.proposals.set(scheduleId, proposal);
    this.eventBus.emit(EVENT_TYPES.DRAFTED, { scheduleId, slotsCount: slots.length });
    return proposal;
  }

  // API: POST /validate
  validateProposal({ scheduleId, slots }) {
    const effectiveSlots = slots ?? this.getProposalOrThrow(scheduleId).slots;
    const conflicts = collectConflicts(effectiveSlots);

    return {
      scheduleId,
      valid: conflicts.length === 0,
      conflicts
    };
  }

  // API: POST /publish
  publishSchedule({ scheduleId }) {
    const proposal = this.getProposalOrThrow(scheduleId);
    const validation = this.validateProposal({ scheduleId, slots: proposal.slots });

    if (!validation.valid) {
      return {
        scheduleId,
        published: false,
        conflicts: validation.conflicts
      };
    }

    const existing = this.publishedSchedules.get(scheduleId);
    const changeType = existing ? EVENT_TYPES.CHANGED : EVENT_TYPES.PUBLISHED;

    const published = {
      ...proposal,
      status: "published",
      publishedAt: new Date().toISOString()
    };

    this.publishedSchedules.set(scheduleId, published);

    this.eventBus.emit(changeType, {
      scheduleId,
      slotsCount: proposal.slots.length
    });

    const speakerIds = [...new Set(proposal.slots.map((slot) => slot.speakerId))];

    this.notificationService.notifyScheduleChange({
      attendeeIds: proposal.attendeeIds,
      speakerIds,
      scheduleId,
      changeType
    });

    return {
      scheduleId,
      published: true,
      conflicts: []
    };
  }

  registerAttendeePreferences(attendeeId, preferences) {
    this.attendeePreferences.set(attendeeId, preferences);
  }

  // Read model API: GET /attendees/:attendeeId/agenda
  getPersonalizedAgenda(attendeeId, scheduleId) {
    const schedule = this.publishedSchedules.get(scheduleId);
    if (!schedule) {
      throw new Error(`Published schedule not found: ${scheduleId}`);
    }

    const preferences = this.attendeePreferences.get(attendeeId) ?? {};
    const preferredTracks = new Set(preferences.preferredTracks ?? []);
    const preferredSpeakers = new Set(preferences.preferredSpeakers ?? []);

    const sessions = schedule.slots
      .filter((slot) => {
        if (preferredTracks.size === 0 && preferredSpeakers.size === 0) {
          return true;
        }

        return preferredTracks.has(slot.track) || preferredSpeakers.has(slot.speakerId);
      })
      .sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));

    return {
      attendeeId,
      scheduleId,
      sessions
    };
  }

  getProposalOrThrow(scheduleId) {
    const proposal = this.proposals.get(scheduleId);
    if (!proposal) {
      throw new Error(`Schedule proposal not found: ${scheduleId}`);
    }

    return proposal;
  }
}

export { EVENT_TYPES, collectConflicts };
