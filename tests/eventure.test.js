import test from "node:test";
import assert from "node:assert/strict";
import { EventCoreService } from "../services/event-core-service/src/eventCoreService.js";
import { InMemoryEventBus } from "../services/scheduling-service/src/eventBus.js";
import { SchedulingService } from "../services/scheduling-service/src/schedulingService.js";
import { NotificationService } from "../services/notification-service/src/notificationService.js";
import { CheckinService, EVENT_TYPES, ONSITE_MODES } from "../services/checkin-service/src/checkinService.js";
import { OfflineCheckinClient } from "../services/checkin-service/src/offlineSyncClient.js";

test("event lifecycle supports draft -> published -> archived", () => {
  const eventCore = new EventCoreService();
  eventCore.createDraftEvent({ id: "ev1", name: "Event One" });

  const published = eventCore.publishEvent("ev1");
  assert.equal(published.lifecycleState, "published");

  const archived = eventCore.archiveEvent("ev1");
  assert.equal(archived.lifecycleState, "archived");
});

test("session entities require duration/speaker/track/room features", () => {
  const eventCore = new EventCoreService();
  eventCore.createDraftEvent({ id: "ev2", name: "Event Two" });

  const updated = eventCore.addSessionToEvent("ev2", {
    id: "s1",
    title: "Building Eventure",
    durationMinutes: 45,
    speakerId: "sp1",
    track: "engineering",
    requiredRoomFeatures: ["projector", "recording"]
  });

  assert.equal(updated.sessions.length, 1);
});

test("scheduling validate catches overlap conflicts", () => {
  const service = new SchedulingService({
    eventBus: new InMemoryEventBus(),
    notificationService: new NotificationService()
  });

  const slots = [
    {
      sessionId: "s1",
      speakerId: "sp1",
      roomId: "r1",
      track: "engineering",
      startTime: "2026-01-10T09:00:00.000Z",
      endTime: "2026-01-10T10:00:00.000Z"
    },
    {
      sessionId: "s2",
      speakerId: "sp1",
      roomId: "r1",
      track: "engineering",
      startTime: "2026-01-10T09:30:00.000Z",
      endTime: "2026-01-10T10:30:00.000Z"
    }
  ];

  service.createProposal({ scheduleId: "sched1", slots, attendeeIds: ["a1"] });
  const validation = service.validateProposal({ scheduleId: "sched1" });

  assert.equal(validation.valid, false);
  assert.equal(validation.conflicts.length, 2);
});

test("publishing schedules emits events and sends notifications", () => {
  const eventBus = new InMemoryEventBus();
  const notificationService = new NotificationService();
  const service = new SchedulingService({ eventBus, notificationService });

  const slots = [
    {
      sessionId: "s3",
      speakerId: "sp2",
      roomId: "r2",
      track: "product",
      startTime: "2026-01-10T11:00:00.000Z",
      endTime: "2026-01-10T12:00:00.000Z"
    }
  ];

  service.createProposal({ scheduleId: "sched2", slots, attendeeIds: ["a2"] });
  const publishResult = service.publishSchedule({ scheduleId: "sched2" });

  assert.equal(publishResult.published, true);

  const eventTypes = eventBus.allEvents().map((event) => event.type);
  assert.deepEqual(eventTypes, ["ScheduleDrafted", "SchedulePublished"]);

  const notifications = notificationService.allMessages();
  assert.equal(notifications.length, 2);
});

test("read model returns personalized attendee agenda", () => {
  const service = new SchedulingService({
    eventBus: new InMemoryEventBus(),
    notificationService: new NotificationService()
  });

  const slots = [
    {
      sessionId: "s4",
      speakerId: "sp3",
      roomId: "r3",
      track: "design",
      startTime: "2026-01-10T13:00:00.000Z",
      endTime: "2026-01-10T14:00:00.000Z"
    },
    {
      sessionId: "s5",
      speakerId: "sp4",
      roomId: "r4",
      track: "engineering",
      startTime: "2026-01-10T15:00:00.000Z",
      endTime: "2026-01-10T16:00:00.000Z"
    }
  ];

  service.createProposal({ scheduleId: "sched3", slots, attendeeIds: ["a3"] });
  service.publishSchedule({ scheduleId: "sched3" });

  service.registerAttendeePreferences("a3", {
    preferredTracks: ["engineering"]
  });

  const agenda = service.getPersonalizedAgenda("a3", "sched3");
  assert.equal(agenda.sessions.length, 1);
  assert.equal(agenda.sessions[0].sessionId, "s5");
});

test("checkin transactions support attendee lookup and idempotency", () => {
  const eventBus = new InMemoryEventBus();
  const service = new CheckinService({ eventBus });

  service.registerAttendee({
    id: "a100",
    name: "Alex Doe",
    email: "alex@example.com",
    qrCode: "qr-100",
    barcode: "bc-100"
  });

  const firstCheckin = service.recordCheckinTransaction({
    idempotencyKey: "idem-1",
    attendeeLookup: { qrCode: "qr-100" },
    mode: ONSITE_MODES.KIOSK,
    stationId: "kiosk-1"
  });
  const replay = service.recordCheckinTransaction({
    idempotencyKey: "idem-1",
    attendeeLookup: { barcode: "bc-100" },
    mode: ONSITE_MODES.KIOSK,
    stationId: "kiosk-1"
  });

  assert.equal(firstCheckin.status, "checked-in");
  assert.equal(replay.idempotentReplay, true);

  const eventTypes = eventBus.allEvents().map((event) => event.type);
  assert.equal(eventTypes[0], EVENT_TYPES.CHECKIN_RECORDED);
});

test("onsite staff mode, badge print integration, reverse event, and ops dashboard", () => {
  const eventBus = new InMemoryEventBus();
  const service = new CheckinService({ eventBus });

  service.registerAttendee({
    id: "a200",
    name: "Sam Operator",
    email: "sam@example.com",
    qrCode: "qr-200",
    barcode: "bc-200"
  });

  service.recordCheckinTransaction({
    attendeeLookup: { manualQuery: { attendeeId: "a200" } },
    mode: ONSITE_MODES.STAFF,
    stationId: "staff-desk-1"
  });

  const queuedJob = service.badgePrintQueue[0];
  assert.equal(queuedJob.status, "queued");

  service.processBadgePrintJob(queuedJob.id);
  service.reverseCheckin({
    attendeeId: "a200",
    reason: "duplicate",
    operatorId: "op-1"
  });

  const dashboard = service.getOperationalDashboard();
  assert.equal(typeof dashboard.queueLength, "number");
  assert.equal(typeof dashboard.throughputPerMinute, "number");

  const eventTypes = eventBus.allEvents().map((event) => event.type);
  assert.deepEqual(eventTypes, [
    EVENT_TYPES.CHECKIN_RECORDED,
    EVENT_TYPES.BADGE_PRINTED,
    EVENT_TYPES.CHECKIN_REVERSED
  ]);
});

test("offline-first client queue sync applies operations and resolves conflicts", () => {
  const service = new CheckinService({ eventBus: new InMemoryEventBus() });

  service.registerAttendee({ id: "a300", name: "Offline User", email: "offline@example.com" });

  const client = new OfflineCheckinClient({ deviceId: "device-1" });

  client.enqueueOperation({
    clientOperationId: "c1",
    type: "checkin",
    payload: { attendeeId: "a300", mode: ONSITE_MODES.KIOSK, stationId: "kiosk-7" },
    occurredAt: "2026-01-10T10:00:00.000Z"
  });

  const syncResult = client.syncWith(service);
  assert.equal(syncResult.applied.length, 1);

  client.enqueueOperation({
    clientOperationId: "c2",
    type: "checkin",
    payload: { attendeeId: "a300", mode: ONSITE_MODES.KIOSK, stationId: "kiosk-7" },
    occurredAt: "2026-01-09T10:00:00.000Z"
  });

  const conflictResult = client.syncWith(service);
  assert.equal(conflictResult.conflicts.length, 1);
});
