import test from "node:test";
import assert from "node:assert/strict";
import { EventCoreService } from "../services/event-core-service/src/eventCoreService.js";
import { InMemoryEventBus } from "../services/scheduling-service/src/eventBus.js";
import { SchedulingService } from "../services/scheduling-service/src/schedulingService.js";
import { NotificationService } from "../services/notification-service/src/notificationService.js";

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
import { createApiGateway, InMemoryRateLimiter } from "../services/api-gateway/src/gatewayService.js";
import { createAttendeeBff, composeAttendeeView } from "../services/attendee-bff/src/attendeeBff.js";
import { createOrganizerBff, composeOrganizerView } from "../services/organizer-bff/src/organizerBff.js";

test("api gateway routes organizer paths only for admin roles", () => {
  const gateway = createApiGateway();

  const forbidden = gateway.handle({
    method: "GET",
    path: "/api/v1/organizer/overview",
    headers: { "x-user-role": "attendee" },
    query: { eventId: "ev-1" }
  });

  assert.equal(forbidden.status, 403);

  const allowed = gateway.handle({
    method: "GET",
    path: "/api/v1/organizer/overview",
    headers: {
      "x-user-role": "admin",
      authorization: "Bearer admin-token"
    },
    query: { eventId: "ev-1" }
  });

  assert.equal(allowed.status, 200);
  assert.equal(allowed.authToken, "admin-token");
});

test("api gateway enforces rate limiting and versioned APIs", () => {
  const gateway = createApiGateway({
    rateLimiter: new InMemoryRateLimiter({ maxRequests: 1, windowMs: 60_000 })
  });

  const unsupported = gateway.handle({
    method: "GET",
    path: "/api/v2/attendee/agenda",
    headers: {}
  });

  assert.equal(unsupported.status, 404);
  assert.equal(unsupported.error.code, "unsupported_version");

  const first = gateway.handle({
    method: "GET",
    path: "/api/v1/attendee/agenda",
    headers: {},
    ip: "10.0.0.8"
  });

  const second = gateway.handle({
    method: "GET",
    path: "/api/v1/attendee/agenda",
    headers: {},
    ip: "10.0.0.8"
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
});

test("attendee bff composes registration ticket schedule and room payload", () => {
  const attendeeBff = createAttendeeBff();
  const response = attendeeBff.handle({
    method: "GET",
    path: "/overview",
    query: { attendeeId: "a-1" },
    meta: { traceId: "trace-1", token: "t-1" }
  });

  assert.equal(response.status, 200);
  assert.equal(response.data.registration.attendeeId, "a-1");
  assert.equal(response.data.ticket.id, "ticket-1");
  assert.equal(response.data.schedule[0].room.name, "Main Hall");
});

test("organizer bff composes roster and session room assignments", () => {
  const organizerBff = createOrganizerBff();
  const response = organizerBff.handle({
    method: "GET",
    path: "/overview",
    query: { eventId: "ev-1" },
    meta: { traceId: "trace-2", token: "t-2" }
  });

  assert.equal(response.status, 200);
  assert.equal(response.data.roster.length, 2);
  assert.equal(response.data.sessions[0].room.name, "Main Hall");
});

test("composition helpers build deterministic payload shapes", () => {
  const attendeeView = composeAttendeeView({
    attendeeId: "a-2",
    registrations: [{ id: "reg-9", attendeeId: "a-2", eventId: "ev-3" }],
    tickets: [{ id: "ticket-9", attendeeId: "a-2" }],
    schedules: [{ id: "s-1", attendeeIds: ["a-2"], roomId: "r-1" }],
    rooms: [{ id: "r-1", name: "Room One" }]
  });

  const organizerView = composeOrganizerView({
    eventId: "ev-3",
    registrations: [{ id: "reg-9", attendeeId: "a-2", eventId: "ev-3" }],
    tickets: [{ id: "ticket-9", attendeeId: "a-2" }],
    schedules: [{ id: "s-1", eventId: "ev-3", roomId: "r-1" }],
    rooms: [{ id: "r-1", name: "Room One" }]
  });

  assert.equal(attendeeView.schedule[0].room.name, "Room One");
  assert.equal(organizerView.roster[0].ticket.id, "ticket-9");
});
