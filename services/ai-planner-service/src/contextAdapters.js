function assertObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
}

function assertNumber(value, fieldName) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Invalid number for field: ${fieldName}`);
  }
}

function assertString(value, fieldName) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid string for field: ${fieldName}`);
  }
}

export class AnalyticsContextAdapter {
  constructor({ analyticsService }) {
    this.analyticsService = analyticsService;
  }

  getContext({ tenantId, eventId, baselineAttendance, growthRate }) {
    const attendanceForecast = this.analyticsService.forecastAttendance({
      tenantId,
      eventId,
      baselineAttendance,
      growthRate
    });

    const checkInThroughput = this.analyticsService.getCheckInThroughput({ tenantId, eventId });
    const historicalAttendance = this.analyticsService.getHistoricalAttendanceByTimeslot({ tenantId, eventId });

    assertObject(attendanceForecast, "Analytics service returned invalid attendance forecast payload");
    assertNumber(attendanceForecast.expectedTotalAttendance, "expectedTotalAttendance");
    assertNumber(attendanceForecast.confidence, "confidence");
    assertString(attendanceForecast.basis, "basis");

    return {
      attendanceForecast,
      checkInThroughput,
      historicalAttendance
    };
  }
}

export class DomainContextAdapter {
  constructor({ eventCoreService, schedulingService }) {
    this.eventCoreService = eventCoreService;
    this.schedulingService = schedulingService;
  }

  getContext({ tenantId, eventId, scheduleId }) {
    const event = this.eventCoreService.getEventOrThrow(eventId);
    if (event.tenantId !== tenantId) {
      throw new Error("Tenant isolation violation for domain event context");
    }

    const proposal = this.schedulingService.getProposalOrThrow(scheduleId);
    if (proposal.tenantId !== tenantId) {
      throw new Error("Tenant isolation violation for schedule context");
    }

    return {
      event: {
        id: event.id,
        name: event.name,
        lifecycleState: event.lifecycleState,
        sessions: event.sessions.map((session) => ({
          id: session.id,
          title: session.title,
          durationMinutes: session.durationMinutes,
          track: session.track,
          requiredRoomFeatures: [...session.requiredRoomFeatures]
        }))
      },
      schedule: {
        scheduleId: proposal.scheduleId,
        slots: proposal.slots.map((slot) => ({
          sessionId: slot.sessionId,
          roomId: slot.roomId,
          startTime: slot.startTime,
          endTime: slot.endTime,
          track: slot.track
        }))
      }
    };
  }
}
