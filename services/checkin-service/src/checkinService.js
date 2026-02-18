const ONSITE_MODES = Object.freeze({
  KIOSK: "self-serve-kiosk",
  STAFF: "staff-operated"
});

const EVENT_TYPES = Object.freeze({
  CHECKIN_RECORDED: "CheckinRecorded",
  BADGE_PRINTED: "BadgePrinted",
  CHECKIN_REVERSED: "CheckinReversed"
});

function nowIso() {
  return new Date().toISOString();
}

function normalizeManualQuery(manualQuery) {
  if (!manualQuery) {
    return null;
  }

  if (typeof manualQuery === "string") {
    return { attendeeId: manualQuery };
  }

  return manualQuery;
}

export class CheckinService {
  constructor({ eventBus }) {
    this.eventBus = eventBus;
    this.attendees = new Map();
    this.checkins = new Map();
    this.idempotencyStore = new Map();
    this.badgePrintQueue = [];
    this.processedSyncOps = new Set();
    this.metrics = {
      checkinAttempts: 0,
      checkinSuccesses: 0,
      checkinFailures: 0,
      reverseFailures: 0,
      syncConflicts: 0,
      startedAt: Date.now()
    };
  }

  registerAttendee(attendee) {
    this.attendees.set(attendee.id, attendee);
    return attendee;
  }

  lookupAttendee({ qrCode, barcode, manualQuery }) {
    const query = normalizeManualQuery(manualQuery);

    for (const attendee of this.attendees.values()) {
      if (qrCode && attendee.qrCode === qrCode) {
        return attendee;
      }

      if (barcode && attendee.barcode === barcode) {
        return attendee;
      }

      if (query) {
        if (query.attendeeId && attendee.id === query.attendeeId) {
          return attendee;
        }

        if (query.email && attendee.email === query.email) {
          return attendee;
        }

        if (query.name && attendee.name?.toLowerCase() === query.name.toLowerCase()) {
          return attendee;
        }
      }
    }

    return null;
  }

  recordCheckinTransaction({ idempotencyKey, attendeeLookup, mode, stationId, occurredAt }) {
    this.metrics.checkinAttempts += 1;

    if (!Object.values(ONSITE_MODES).includes(mode)) {
      this.metrics.checkinFailures += 1;
      throw new Error(`Unsupported onsite mode: ${mode}`);
    }

    if (idempotencyKey && this.idempotencyStore.has(idempotencyKey)) {
      return {
        ...this.idempotencyStore.get(idempotencyKey),
        idempotentReplay: true
      };
    }

    const attendee = this.lookupAttendee(attendeeLookup ?? {});

    if (!attendee) {
      this.metrics.checkinFailures += 1;
      throw new Error("Attendee not found");
    }

    const existing = this.checkins.get(attendee.id);

    if (existing?.status === "checked-in") {
      const alreadyCheckedIn = {
        ok: true,
        attendeeId: attendee.id,
        status: "already-checked-in",
        checkedInAt: existing.checkedInAt,
        mode: existing.mode,
        stationId: existing.stationId
      };

      if (idempotencyKey) {
        this.idempotencyStore.set(idempotencyKey, alreadyCheckedIn);
      }

      return alreadyCheckedIn;
    }

    const checkedInAt = occurredAt ?? nowIso();
    const checkinRecord = {
      attendeeId: attendee.id,
      status: "checked-in",
      checkedInAt,
      lastMutationAt: checkedInAt,
      mode,
      stationId
    };

    this.checkins.set(attendee.id, checkinRecord);
    this.metrics.checkinSuccesses += 1;

    const result = {
      ok: true,
      attendeeId: attendee.id,
      status: checkinRecord.status,
      checkedInAt,
      mode,
      stationId
    };

    if (idempotencyKey) {
      this.idempotencyStore.set(idempotencyKey, result);
    }

    this.eventBus.emit(EVENT_TYPES.CHECKIN_RECORDED, {
      attendeeId: attendee.id,
      mode,
      stationId,
      checkedInAt
    });

    this.enqueueBadgePrint({
      attendeeId: attendee.id,
      printerId: mode === ONSITE_MODES.KIOSK ? "kiosk-printer" : "staff-printer",
      requestedBy: stationId ?? mode
    });

    return result;
  }

  reverseCheckin({ attendeeId, reason, operatorId, occurredAt }) {
    const existing = this.checkins.get(attendeeId);

    if (!existing || existing.status !== "checked-in") {
      this.metrics.reverseFailures += 1;
      throw new Error(`Cannot reverse check-in for attendee: ${attendeeId}`);
    }

    const reversedAt = occurredAt ?? nowIso();
    const updated = {
      ...existing,
      status: "reversed",
      reversedAt,
      reversalReason: reason,
      reversedBy: operatorId,
      lastMutationAt: reversedAt
    };

    this.checkins.set(attendeeId, updated);

    this.eventBus.emit(EVENT_TYPES.CHECKIN_REVERSED, {
      attendeeId,
      reason,
      operatorId,
      reversedAt
    });

    return updated;
  }

  enqueueBadgePrint({ attendeeId, printerId, requestedBy }) {
    const job = {
      id: `badge-${this.badgePrintQueue.length + 1}`,
      attendeeId,
      printerId,
      requestedBy,
      status: "queued",
      queuedAt: nowIso()
    };

    this.badgePrintQueue.push(job);
    return job;
  }

  processBadgePrintJob(jobId, printedAt = nowIso()) {
    const job = this.badgePrintQueue.find((queuedJob) => queuedJob.id === jobId);

    if (!job) {
      throw new Error(`Badge print job not found: ${jobId}`);
    }

    job.status = "printed";
    job.printedAt = printedAt;

    this.eventBus.emit(EVENT_TYPES.BADGE_PRINTED, {
      attendeeId: job.attendeeId,
      jobId: job.id,
      printerId: job.printerId,
      printedAt
    });

    return job;
  }

  applyOfflineSync({ deviceId, operations }) {
    const applied = [];
    const duplicates = [];
    const conflicts = [];

    for (const operation of operations) {
      const opId = `${deviceId}:${operation.clientOperationId}`;

      if (this.processedSyncOps.has(opId)) {
        duplicates.push({
          clientOperationId: operation.clientOperationId,
          reason: "duplicate"
        });
        continue;
      }

      const attendeeId = operation.payload?.attendeeId;
      const existing = attendeeId ? this.checkins.get(attendeeId) : null;
      const opTime = Date.parse(operation.occurredAt ?? nowIso());
      const lastMutationTime = existing?.lastMutationAt ? Date.parse(existing.lastMutationAt) : 0;

      if (existing && opTime < lastMutationTime) {
        conflicts.push({
          clientOperationId: operation.clientOperationId,
          attendeeId,
          resolution: "server-state-wins",
          serverStatus: existing.status
        });
        this.metrics.syncConflicts += 1;
        continue;
      }

      if (operation.type === "checkin") {
        this.recordCheckinTransaction({
          idempotencyKey: `${deviceId}-${operation.clientOperationId}`,
          attendeeLookup: { manualQuery: { attendeeId } },
          mode: operation.payload.mode,
          stationId: operation.payload.stationId,
          occurredAt: operation.occurredAt
        });
      } else if (operation.type === "reverse") {
        this.reverseCheckin({
          attendeeId,
          reason: operation.payload.reason,
          operatorId: operation.payload.operatorId,
          occurredAt: operation.occurredAt
        });
      } else {
        conflicts.push({
          clientOperationId: operation.clientOperationId,
          attendeeId,
          resolution: "unsupported-operation"
        });
        this.metrics.syncConflicts += 1;
        continue;
      }

      this.processedSyncOps.add(opId);
      applied.push({ clientOperationId: operation.clientOperationId, attendeeId });
    }

    return {
      deviceId,
      applied,
      duplicates,
      conflicts
    };
  }

  getOperationalDashboard() {
    const elapsedMinutes = Math.max((Date.now() - this.metrics.startedAt) / 60000, 1 / 60);

    return {
      queueLength: this.badgePrintQueue.filter((job) => job.status === "queued").length,
      throughputPerMinute: Number((this.metrics.checkinSuccesses / elapsedMinutes).toFixed(2)),
      failureRates: {
        checkin: this.metrics.checkinAttempts
          ? Number((this.metrics.checkinFailures / this.metrics.checkinAttempts).toFixed(3))
          : 0,
        reverse: this.metrics.reverseFailures,
        syncConflicts: this.metrics.syncConflicts
      },
      counters: {
        checkinAttempts: this.metrics.checkinAttempts,
        checkinSuccesses: this.metrics.checkinSuccesses,
        checkinFailures: this.metrics.checkinFailures
      }
    };
  }
}

export { EVENT_TYPES, ONSITE_MODES };
