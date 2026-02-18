import test from "node:test";
import assert from "node:assert/strict";
import { EventCoreService } from "../services/event-core-service/src/eventCoreService.js";
import { InMemoryEventBus } from "../services/scheduling-service/src/eventBus.js";
import { SchedulingService } from "../services/scheduling-service/src/schedulingService.js";
import { NotificationService } from "../services/notification-service/src/notificationService.js";
import { AnalyticsService } from "../services/analytics-service/src/analyticsService.js";
import { AiPlannerService } from "../services/ai-planner-service/src/aiPlannerService.js";
import { AnalyticsContextAdapter, DomainContextAdapter } from "../services/ai-planner-service/src/contextAdapters.js";

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

test("ai planner generates explainable recommendations with guardrails", () => {
  const analyticsService = new AnalyticsService();
  analyticsService.recordAttendance({
    tenantId: "tenant-1",
    eventId: "ev-plan",
    timeslot: "09:00",
    attendeeCount: 220
  });
  analyticsService.recordCheckInOutcome({
    tenantId: "tenant-1",
    eventId: "ev-plan",
    timeslot: "08:00",
    attendeesCheckedIn: 300,
    laneCount: 3
  });

  const eventCoreService = new EventCoreService();
  eventCoreService.createDraftEvent({ id: "ev-plan", name: "Planner Event", tenantId: "tenant-1" });
  eventCoreService.addSessionToEvent("ev-plan", {
    id: "session-1",
    title: "Keynote",
    durationMinutes: 60,
    speakerId: "sp100",
    track: "main",
    requiredRoomFeatures: ["projector"]
  });

  const schedulingService = new SchedulingService({
    eventBus: new InMemoryEventBus(),
    notificationService: new NotificationService()
  });

  schedulingService.createProposal({
    tenantId: "tenant-1",
    scheduleId: "sched-plan",
    attendeeIds: ["att-1"],
    slots: [
      {
        sessionId: "session-1",
        speakerId: "sp100",
        roomId: "room-main",
        track: "main",
        startTime: "2026-02-10T09:00:00.000Z",
        endTime: "2026-02-10T10:00:00.000Z"
      }
    ]
  });

  const planner = new AiPlannerService({
    analyticsAdapter: new AnalyticsContextAdapter({ analyticsService }),
    domainAdapter: new DomainContextAdapter({ eventCoreService, schedulingService })
  });

  const recommendation = planner.generateRecommendation({
    tenantId: "tenant-1",
    eventId: "ev-plan",
    scheduleId: "sched-plan",
    baselineAttendance: 180,
    growthRate: 0.1,
    prompt: "Contact me at test@example.com or 555-333-1212"
  });

  assert.equal(recommendation.guardrails.tenantIsolation, "enforced");
  assert.equal(recommendation.guardrails.piiPolicy, "no-raw-pii");
  assert.equal(recommendation.recommendations.expectedAttendanceForecasting.expectedTotalAttendance >= 180, true);
  assert.equal(recommendation.promptSummary.includes("test@example.com"), false);
  assert.equal(recommendation.promptSummary.includes("555-333-1212"), false);
});

test("ai planner supports decision feedback and outcome capture", () => {
  const analyticsService = new AnalyticsService();
  const eventCoreService = new EventCoreService();
  const schedulingService = new SchedulingService({
    eventBus: new InMemoryEventBus(),
    notificationService: new NotificationService()
  });

  eventCoreService.createDraftEvent({ id: "ev-feedback", name: "Feedback Event", tenantId: "tenant-2" });
  eventCoreService.addSessionToEvent("ev-feedback", {
    id: "session-2",
    title: "Workshop",
    durationMinutes: 45,
    speakerId: "sp200",
    track: "workshop",
    requiredRoomFeatures: ["whiteboard"]
  });

  schedulingService.createProposal({
    tenantId: "tenant-2",
    scheduleId: "sched-feedback",
    attendeeIds: [],
    slots: [
      {
        sessionId: "session-2",
        speakerId: "sp200",
        roomId: "room-2",
        track: "workshop",
        startTime: "2026-02-10T12:00:00.000Z",
        endTime: "2026-02-10T12:45:00.000Z"
      }
    ]
  });

  const planner = new AiPlannerService({
    analyticsAdapter: new AnalyticsContextAdapter({ analyticsService }),
    domainAdapter: new DomainContextAdapter({ eventCoreService, schedulingService })
  });

  const chatResponse = planner.chat({
    tenantId: "tenant-2",
    eventId: "ev-feedback",
    scheduleId: "sched-feedback",
    message: "Please optimize staffing"
  });

  assert.ok(chatResponse.response.includes("check-in lanes"));

  const decision = planner.submitDecision({
    tenantId: "tenant-2",
    recommendationId: chatResponse.recommendationId,
    decision: "accepted",
    reason: "Looks good"
  });

  assert.equal(decision.decision, "accepted");

  const outcome = planner.captureOutcome({
    tenantId: "tenant-2",
    recommendationId: chatResponse.recommendationId,
    outcomeMetric: "avg-check-in-minutes",
    value: 6,
    notes: "Improved after extra lane"
  });

  assert.equal(outcome.outcomeMetric, "avg-check-in-minutes");
  assert.equal(planner.allFeedback().length, 2);
});
