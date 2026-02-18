const EVENT_TYPES = Object.freeze({
  SCHEDULE_DRAFTED: "ScheduleDrafted",
  ASSIGNMENTS_FINALIZED: "RoomAssignmentsFinalized"
});

function toMillis(value) {
  return new Date(value).getTime();
}

function overlaps(left, right) {
  return toMillis(left.startTime) < toMillis(right.endTime)
    && toMillis(right.startTime) < toMillis(left.endTime);
}

function windowContains(window, slot) {
  return toMillis(window.startTime) <= toMillis(slot.startTime)
    && toMillis(slot.endTime) <= toMillis(window.endTime);
}

function minutesBetween(leftEnd, rightStart) {
  return Math.floor((toMillis(rightStart) - toMillis(leftEnd)) / 60000);
}

export class RoomSchedulingService {
  constructor({ eventBus }) {
    this.eventBus = eventBus;
    this.rooms = new Map();
    this.assignmentsBySchedule = new Map();
    this.assignmentAuditTrail = [];

    if (this.eventBus?.subscribe) {
      this.eventBus.subscribe(EVENT_TYPES.SCHEDULE_DRAFTED, (payload) => {
        this.finalizeAssignmentsForDraft(payload);
      });
    }
  }

  upsertRoom({ roomId, capacity, location, equipment = [], accessibilityTags = [] }) {
    const existing = this.rooms.get(roomId);
    const room = {
      roomId,
      capacity,
      location,
      equipment,
      accessibilityTags,
      availabilityWindows: existing?.availabilityWindows ?? [],
      blackoutPeriods: existing?.blackoutPeriods ?? []
    };

    this.rooms.set(roomId, room);
    return room;
  }

  addAvailabilityWindow(roomId, window) {
    const room = this.getRoomOrThrow(roomId);
    room.availabilityWindows.push(window);
    return room;
  }

  addBlackoutPeriod(roomId, blackout) {
    const room = this.getRoomOrThrow(roomId);
    room.blackoutPeriods.push(blackout);
    return room;
  }

  solveAssignments({ scheduleId, sessions }) {
    const orderedSessions = [...sessions].sort((a, b) => toMillis(a.startTime) - toMillis(b.startTime));
    const assignments = [];
    const unassigned = [];

    for (const session of orderedSessions) {
      const candidates = this.rankRoomsForSession(session, assignments);
      const selected = candidates.find((candidate) => candidate.feasible);

      if (!selected) {
        unassigned.push({
          sessionId: session.sessionId,
          diagnostics: this.explainFailure(session, assignments)
        });
        continue;
      }

      assignments.push({
        scheduleId,
        sessionId: session.sessionId,
        speakerId: session.speakerId,
        track: session.track,
        startTime: session.startTime,
        endTime: session.endTime,
        roomId: selected.roomId,
        assignmentType: "auto"
      });
    }

    const result = {
      scheduleId,
      assignments,
      unassigned,
      success: unassigned.length === 0,
      finalizedAt: new Date().toISOString()
    };

    this.assignmentsBySchedule.set(scheduleId, {
      ...result,
      sessions: orderedSessions
    });

    return result;
  }

  getConflictDiagnostics({ scheduleId, sessions }) {
    const liveSessions = sessions ?? this.assignmentsBySchedule.get(scheduleId)?.sessions ?? [];
    const currentAssignments = this.assignmentsBySchedule.get(scheduleId)?.assignments ?? [];

    return {
      scheduleId,
      diagnostics: liveSessions
        .map((session) => ({
          sessionId: session.sessionId,
          failure: this.explainFailure(session, currentAssignments)
        }))
        .filter((entry) => entry.failure.blockers.length > 0)
    };
  }

  overrideAssignment({ scheduleId, sessionId, roomId, actorId, reason }) {
    const record = this.assignmentsBySchedule.get(scheduleId);
    if (!record) {
      throw new Error(`Schedule assignment record not found: ${scheduleId}`);
    }

    const session = record.sessions.find((item) => item.sessionId === sessionId);
    if (!session) {
      throw new Error(`Session not found in schedule: ${sessionId}`);
    }

    const reasons = this.getBlockingReasons(roomId, session, record.assignments.filter((item) => item.sessionId !== sessionId));
    if (reasons.length > 0) {
      throw new Error(`Override rejected for room ${roomId}: ${reasons.join("; ")}`);
    }

    const existingAssignment = record.assignments.find((item) => item.sessionId === sessionId);
    const nextAssignments = record.assignments.filter((item) => item.sessionId !== sessionId);
    nextAssignments.push({
      scheduleId,
      sessionId,
      speakerId: session.speakerId,
      track: session.track,
      startTime: session.startTime,
      endTime: session.endTime,
      roomId,
      assignmentType: "manual"
    });

    record.assignments = nextAssignments.sort((a, b) => toMillis(a.startTime) - toMillis(b.startTime));

    const auditEntry = {
      scheduleId,
      sessionId,
      fromRoomId: existingAssignment?.roomId ?? null,
      toRoomId: roomId,
      actorId,
      reason,
      overriddenAt: new Date().toISOString()
    };

    this.assignmentAuditTrail.push(auditEntry);
    return { scheduleId, sessionId, roomId, audited: true };
  }

  getAssignments(scheduleId) {
    return this.assignmentsBySchedule.get(scheduleId) ?? null;
  }

  getAuditTrail(scheduleId) {
    return this.assignmentAuditTrail.filter((entry) => entry.scheduleId === scheduleId);
  }

  finalizeAssignmentsForDraft(payload) {
    const { scheduleId, sessions = [] } = payload;
    const result = this.solveAssignments({ scheduleId, sessions });
    this.eventBus.emit(EVENT_TYPES.ASSIGNMENTS_FINALIZED, {
      scheduleId,
      success: result.success,
      assignedCount: result.assignments.length,
      unassignedCount: result.unassigned.length
    });

    return result;
  }

  rankRoomsForSession(session, currentAssignments) {
    const roomEntries = [...this.rooms.values()];

    return roomEntries
      .map((room) => {
        const blockers = this.getBlockingReasons(room.roomId, session, currentAssignments);
        const feasible = blockers.length === 0;

        return {
          roomId: room.roomId,
          feasible,
          blockers,
          score: feasible ? this.scoreRoom(room, session, currentAssignments) : -Infinity
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  scoreRoom(room, session, assignments) {
    const capacityWaste = Math.max(0, room.capacity - session.expectedAttendance);
    const capacityScore = 100 - capacityWaste;

    const lastRoomAssignment = assignments
      .filter((item) => item.roomId === room.roomId)
      .sort((a, b) => toMillis(b.endTime) - toMillis(a.endTime))[0];

    let setupTurnoverScore = 20;
    if (lastRoomAssignment) {
      const turnoverMinutes = minutesBetween(lastRoomAssignment.endTime, session.startTime);
      setupTurnoverScore = turnoverMinutes >= 15 ? 25 : -25;
    }

    let speakerTransitionScore = 0;
    const speakerPrev = assignments
      .filter((item) => item.speakerId === session.speakerId)
      .sort((a, b) => toMillis(b.endTime) - toMillis(a.endTime))[0];

    if (speakerPrev) {
      speakerTransitionScore = speakerPrev.roomId === room.roomId ? 20 : -10;
    }

    let adjacencyScore = 0;
    const priorTrack = assignments
      .filter((item) => item.track === session.track)
      .sort((a, b) => toMillis(b.endTime) - toMillis(a.endTime))[0];

    if (priorTrack) {
      adjacencyScore = priorTrack.roomId === room.roomId
        ? 20
        : this.sameBuilding(priorTrack.roomId, room.roomId)
          ? 10
          : -5;
    }

    return capacityScore + setupTurnoverScore + speakerTransitionScore + adjacencyScore;
  }

  sameBuilding(roomIdLeft, roomIdRight) {
    const left = this.rooms.get(roomIdLeft);
    const right = this.rooms.get(roomIdRight);
    if (!left || !right) {
      return false;
    }

    const leftBuilding = left.location.split("-")[0];
    const rightBuilding = right.location.split("-")[0];
    return leftBuilding === rightBuilding;
  }

  getBlockingReasons(roomId, session, currentAssignments) {
    const room = this.getRoomOrThrow(roomId);
    const reasons = [];

    if (room.capacity < session.expectedAttendance) {
      reasons.push(`capacity ${room.capacity} below expected attendance ${session.expectedAttendance}`);
    }

    const lacksEquipment = (session.requiredEquipment ?? []).filter((item) => !room.equipment.includes(item));
    if (lacksEquipment.length > 0) {
      reasons.push(`missing equipment: ${lacksEquipment.join(", ")}`);
    }

    const missingAccessibility = (session.accessibilityNeeds ?? [])
      .filter((item) => !room.accessibilityTags.includes(item));
    if (missingAccessibility.length > 0) {
      reasons.push(`missing accessibility tags: ${missingAccessibility.join(", ")}`);
    }

    const slot = { startTime: session.startTime, endTime: session.endTime };

    if (room.availabilityWindows.length > 0) {
      const inWindow = room.availabilityWindows.some((window) => windowContains(window, slot));
      if (!inWindow) {
        reasons.push("outside availability windows");
      }
    }

    const blackout = room.blackoutPeriods.some((window) => overlaps(window, slot));
    if (blackout) {
      reasons.push("overlaps blackout period");
    }

    const doubleBooking = currentAssignments.some((assignment) => {
      if (assignment.roomId !== room.roomId) {
        return false;
      }

      return overlaps(assignment, slot);
    });

    if (doubleBooking) {
      reasons.push("room already assigned for overlapping session");
    }

    return reasons;
  }

  explainFailure(session, currentAssignments) {
    const ranked = this.rankRoomsForSession(session, currentAssignments);
    const blockers = ranked.every((entry) => !entry.feasible)
      ? ranked.flatMap((entry) => entry.blockers.map((reason) => ({ roomId: entry.roomId, reason })))
      : [];

    const alternatives = ranked
      .slice(0, 3)
      .map((entry) => ({
        roomId: entry.roomId,
        feasible: entry.feasible,
        score: entry.feasible ? entry.score : null,
        blockers: entry.feasible ? [] : entry.blockers
      }));

    return {
      blockers,
      alternatives
    };
  }

  getRoomOrThrow(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new Error(`Room not found: ${roomId}`);
    }

    return room;
  }
}

export { EVENT_TYPES };
