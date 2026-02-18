import test from "node:test";
import assert from "node:assert/strict";
import { EventCoreService } from "../services/event-core-service/src/eventCoreService.js";
import { InMemoryEventBus } from "../services/scheduling-service/src/eventBus.js";
import { SchedulingService } from "../services/scheduling-service/src/schedulingService.js";
import { NotificationService } from "../services/notification-service/src/notificationService.js";
import { CheckinService, EVENT_TYPES, ONSITE_MODES } from "../services/checkin-service/src/checkinService.js";
import { OfflineCheckinClient } from "../services/checkin-service/src/offlineSyncClient.js";
import { InMemoryPubSubEventBus } from "../services/room-scheduling-service/src/eventBus.js";
import { EVENT_TYPES, RoomSchedulingService } from "../services/room-scheduling-service/src/roomSchedulingService.js";
import {
  ATTENDEE_STATES,
  REGISTRATION_EVENTS,
  RegistrationService
} from "../services/registration-service/src/registrationService.js";

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
test("room scheduling solver models room constraints and finalizes drafted schedules", () => {
  const eventBus = new InMemoryPubSubEventBus();
  const roomService = new RoomSchedulingService({ eventBus });

  roomService.upsertRoom({
    roomId: "r-main",
    capacity: 120,
    location: "A-1",
    equipment: ["projector", "recording"],
    accessibilityTags: ["wheelchair"]
  });
  roomService.addAvailabilityWindow("r-main", {
    startTime: "2026-01-10T08:00:00.000Z",
    endTime: "2026-01-10T18:00:00.000Z"
  });

  roomService.upsertRoom({
    roomId: "r-small",
    capacity: 30,
    location: "A-2",
    equipment: ["projector"],
    accessibilityTags: []
  });
  roomService.addAvailabilityWindow("r-small", {
    startTime: "2026-01-10T08:00:00.000Z",
    endTime: "2026-01-10T18:00:00.000Z"
  });

  eventBus.emit(EVENT_TYPES.SCHEDULE_DRAFTED, {
    scheduleId: "sched-r1",
    sessions: [
      {
        sessionId: "talk-1",
        speakerId: "spA",
        track: "platform",
        expectedAttendance: 80,
        requiredEquipment: ["projector"],
        accessibilityNeeds: ["wheelchair"],
        startTime: "2026-01-10T09:00:00.000Z",
        endTime: "2026-01-10T10:00:00.000Z"
      }
    ]
  });

  const assignments = roomService.getAssignments("sched-r1");
  assert.equal(assignments.assignments.length, 1);
  assert.equal(assignments.assignments[0].roomId, "r-main");

  const eventTypes = eventBus.allEvents().map((event) => event.type);
  assert.deepEqual(eventTypes, ["ScheduleDrafted", "RoomAssignmentsFinalized"]);
});

test("room scheduling diagnostics explains failures and alternatives", () => {
  const roomService = new RoomSchedulingService({ eventBus: new InMemoryPubSubEventBus() });

  roomService.upsertRoom({
    roomId: "r-1",
    capacity: 40,
    location: "B-1",
    equipment: ["projector"],
    accessibilityTags: []
  });
  roomService.addAvailabilityWindow("r-1", {
    startTime: "2026-01-10T08:00:00.000Z",
    endTime: "2026-01-10T09:00:00.000Z"
  });

  const result = roomService.solveAssignments({
    scheduleId: "sched-r2",
    sessions: [
      {
        sessionId: "talk-x",
        speakerId: "spX",
        track: "ai",
        expectedAttendance: 100,
        requiredEquipment: ["projector", "recording"],
        accessibilityNeeds: ["wheelchair"],
        startTime: "2026-01-10T11:00:00.000Z",
        endTime: "2026-01-10T12:00:00.000Z"
      }
    ]
  });

  assert.equal(result.success, false);
  assert.equal(result.unassigned.length, 1);

  const diagnostics = roomService.getConflictDiagnostics({ scheduleId: "sched-r2" });
  assert.equal(diagnostics.diagnostics.length, 1);
  assert.equal(diagnostics.diagnostics[0].sessionId, "talk-x");
  assert.ok(diagnostics.diagnostics[0].failure.blockers.length > 0);
  assert.equal(diagnostics.diagnostics[0].failure.alternatives[0].roomId, "r-1");
});

test("manual room assignment overrides are audited", () => {
  const roomService = new RoomSchedulingService({ eventBus: new InMemoryPubSubEventBus() });

  roomService.upsertRoom({
    roomId: "r-lrg",
    capacity: 100,
    location: "C-1",
    equipment: ["projector"],
    accessibilityTags: []
  });
  roomService.upsertRoom({
    roomId: "r-alt",
    capacity: 110,
    location: "C-2",
    equipment: ["projector"],
    accessibilityTags: []
  });

  roomService.solveAssignments({
    scheduleId: "sched-r3",
    sessions: [
      {
        sessionId: "talk-y",
        speakerId: "spY",
        track: "ops",
        expectedAttendance: 70,
        requiredEquipment: ["projector"],
        accessibilityNeeds: [],
        startTime: "2026-01-10T14:00:00.000Z",
        endTime: "2026-01-10T15:00:00.000Z"
      }
    ]
  });

  roomService.overrideAssignment({
    scheduleId: "sched-r3",
    sessionId: "talk-y",
    roomId: "r-alt",
    actorId: "planner-1",
    reason: "AV team requested alternative room"
  });

  const updated = roomService.getAssignments("sched-r3");
  assert.equal(updated.assignments[0].roomId, "r-alt");
  assert.equal(updated.assignments[0].assignmentType, "manual");

  const audit = roomService.getAuditTrail("sched-r3");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actorId, "planner-1");
test("registration service supports form builder, policies, and state transitions", () => {
  const eventBus = new InMemoryEventBus();
  const service = new RegistrationService({ eventBus });

  const form = service.configureForm({
    eventId: "ev-reg-1",
    fields: [
      { id: "company", type: "text", required: true },
      { id: "needsAccommodation", type: "boolean" }
    ],
    conditionalQuestions: [
      {
        id: "hotelDetails",
        when: { fieldId: "needsAccommodation", equals: true },
        question: "Please share your hotel requirements"
      }
    ]
  });

  assert.equal(form.fields.length, 2);
  assert.equal(form.conditionalQuestions.length, 1);

  service.configurePolicy({
    eventId: "ev-reg-1",
    capacity: 1,
    approvalsRequired: false,
    inviteOnly: true,
    invitedAttendeeIds: ["a1", "a2"]
  });

  service.startRegistration({
    commandId: "cmd-start-1",
    registrationId: "reg1",
    eventId: "ev-reg-1",
    attendeeId: "a1",
    answers: { company: "Eventure" }
  });
  const approved = service.submitRegistration({
    commandId: "cmd-submit-1",
    registrationId: "reg1"
  });
  assert.equal(approved.state, ATTENDEE_STATES.APPROVED);

  service.startRegistration({
    commandId: "cmd-start-2",
    registrationId: "reg2",
    eventId: "ev-reg-1",
    attendeeId: "a2",
    answers: { company: "Waitlist Co" }
  });
  const waitlisted = service.submitRegistration({
    commandId: "cmd-submit-2",
    registrationId: "reg2"
  });
  assert.equal(waitlisted.state, ATTENDEE_STATES.WAITLISTED);

  const cancelled = service.cancelRegistration({
    commandId: "cmd-cancel-1",
    registrationId: "reg2",
    reason: "Can no longer attend"
  });
  assert.equal(cancelled.state, ATTENDEE_STATES.CANCELLED);

  const eventTypes = eventBus.allEvents().map((event) => event.type);
  assert.deepEqual(eventTypes, [
    REGISTRATION_EVENTS.STARTED,
    REGISTRATION_EVENTS.COMPLETED,
    REGISTRATION_EVENTS.STARTED,
    REGISTRATION_EVENTS.WAITLISTED,
    REGISTRATION_EVENTS.CANCELLED
  ]);
});

test("registration commands are idempotent and prevent duplicate active registrations", () => {
  const service = new RegistrationService({ eventBus: new InMemoryEventBus() });

  const started = service.startRegistration({
    commandId: "dup-cmd-start",
    registrationId: "dup-reg-1",
    eventId: "ev-reg-2",
    attendeeId: "a10"
  });
  const replayed = service.startRegistration({
    commandId: "dup-cmd-start",
    registrationId: "dup-reg-1",
    eventId: "ev-reg-2",
    attendeeId: "a10"
  });
  assert.deepEqual(replayed, started);

  assert.throws(() => {
    service.startRegistration({
      commandId: "dup-cmd-start-2",
      registrationId: "dup-reg-2",
      eventId: "ev-reg-2",
      attendeeId: "a10"
    });
  }, /Duplicate registration attempt/);
});

test("registration reporting exposes analytics-friendly summary", () => {
  const service = new RegistrationService({ eventBus: new InMemoryEventBus() });

  service.configurePolicy({
    eventId: "ev-reg-3",
    capacity: 5,
    approvalsRequired: true
  });

  service.startRegistration({
    commandId: "rep-start-1",
    registrationId: "rep-reg-1",
    eventId: "ev-reg-3",
    attendeeId: "a1"
  });
  service.submitRegistration({
    commandId: "rep-submit-1",
    registrationId: "rep-reg-1"
  });
  service.approveRegistration({
    commandId: "rep-approve-1",
    registrationId: "rep-reg-1"
  });

  service.startRegistration({
    commandId: "rep-start-2",
    registrationId: "rep-reg-2",
    eventId: "ev-reg-3",
    attendeeId: "a2"
  });
  service.cancelRegistration({
    commandId: "rep-cancel-2",
    registrationId: "rep-reg-2",
    reason: "No time"
  });

  const report = service.getAnalyticsReport("ev-reg-3");
  assert.equal(report.totals.registrations, 2);
  assert.equal(report.byState.approved, 1);
  assert.equal(report.byState.cancelled, 1);
});
