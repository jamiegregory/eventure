import test from "node:test";
import assert from "node:assert/strict";
import { EventCoreService } from "../services/event-core-service/src/eventCoreService.js";
import { InMemoryEventBus } from "../services/scheduling-service/src/eventBus.js";
import { SchedulingService } from "../services/scheduling-service/src/schedulingService.js";
import { NotificationService } from "../services/notification-service/src/notificationService.js";
import { InMemoryPubSubEventBus } from "../services/room-scheduling-service/src/eventBus.js";
import { EVENT_TYPES, RoomSchedulingService } from "../services/room-scheduling-service/src/roomSchedulingService.js";

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
});
