import test from "node:test";
import assert from "node:assert/strict";
import { EventCoreService } from "../services/event-core-service/src/eventCoreService.js";
import { InMemoryEventBus } from "../services/scheduling-service/src/eventBus.js";
import { SchedulingService } from "../services/scheduling-service/src/schedulingService.js";
import { NotificationService } from "../services/notification-service/src/notificationService.js";
import {
  AttendeeTrackingService,
  InMemoryAnalyticsPublisher
} from "../services/attendee-tracking-service/src/attendeeTrackingService.js";


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
test("attendee tracking ingests check-in, session, and beacon events into timeline", () => {
  const tracking = new AttendeeTrackingService();

  tracking.ingestEvent({
    type: "check-in",
    attendeeId: "a10",
    timestamp: "2026-01-10T09:00:00.000Z",
    action: "enter"
  });

  tracking.ingestEvent({
    type: "session-scan",
    attendeeId: "a10",
    sessionId: "s100",
    timestamp: "2026-01-10T09:05:00.000Z",
    action: "enter"
  });

  tracking.ingestEvent({
    type: "beacon-proximity",
    attendeeId: "a10",
    zoneId: "expo-hall",
    timestamp: "2026-01-10T09:15:00.000Z",
    action: "enter",
    proximityBand: "immediate"
  });

  tracking.ingestEvent({
    type: "beacon-proximity",
    attendeeId: "a10",
    zoneId: "expo-hall",
    timestamp: "2026-01-10T09:45:00.000Z",
    action: "exit"
  });

  tracking.ingestEvent({
    type: "session-scan",
    attendeeId: "a10",
    sessionId: "s100",
    timestamp: "2026-01-10T10:00:00.000Z",
    action: "exit"
  });

  const timeline = tracking.getTimeline("a10");
  assert.equal(timeline.sessions.s100.intervals.length, 1);
  assert.equal(timeline.zones["expo-hall"].intervals.length, 1);
  assert.equal(timeline.venue.open, "2026-01-10T09:00:00.000Z");
});

test("engagement metrics include sessions attended, overlap anomalies, and dwell durations", () => {
  const tracking = new AttendeeTrackingService();

  tracking.ingestEvent({
    type: "session-scan",
    attendeeId: "a11",
    sessionId: "s1",
    timestamp: "2026-01-10T09:00:00.000Z",
    action: "enter"
  });
  tracking.ingestEvent({
    type: "session-scan",
    attendeeId: "a11",
    sessionId: "s1",
    timestamp: "2026-01-10T09:45:00.000Z",
    action: "exit"
  });

  tracking.ingestEvent({
    type: "session-scan",
    attendeeId: "a11",
    sessionId: "s2",
    timestamp: "2026-01-10T09:30:00.000Z",
    action: "enter"
  });
  tracking.ingestEvent({
    type: "session-scan",
    attendeeId: "a11",
    sessionId: "s2",
    timestamp: "2026-01-10T10:15:00.000Z",
    action: "exit"
  });

  const metrics = tracking.computeEngagementMetrics("a11");
  assert.equal(metrics.sessionsAttended, 2);
  assert.equal(metrics.overlapAnomalies.length, 1);
  assert.equal(metrics.dwellDurationMs.sessions, 90 * 60 * 1000);
});

test("privacy controls enforce consent, retention, anonymization, and analytics publishing", () => {
  const publisher = new InMemoryAnalyticsPublisher();
  const tracking = new AttendeeTrackingService({
    analyticsPublisher: publisher,
    retention: {
      eventRetentionMs: 60 * 1000,
      timelineRetentionMs: 60 * 1000
    }
  });

  tracking.registerConsent("a12", { tracking: false, analytics: false });
  const rejected = tracking.ingestEvent({
    type: "check-in",
    attendeeId: "a12",
    timestamp: "2026-01-10T09:00:00.000Z"
  });
  assert.equal(rejected.accepted, false);

  tracking.registerConsent("a12", { tracking: true, analytics: true });
  tracking.ingestEvent({
    type: "session-scan",
    attendeeId: "a12",
    sessionId: "s3",
    timestamp: "2026-01-10T09:00:00.000Z",
    action: "enter"
  });
  tracking.ingestEvent({
    type: "session-scan",
    attendeeId: "a12",
    sessionId: "s3",
    timestamp: "2026-01-10T09:10:00.000Z",
    action: "exit"
  });

  const anonymizeResult = tracking.runAnonymizationJob({ salt: "test-salt" });
  assert.equal(anonymizeResult.anonymizedAttendees, 1);

  const analyticsMessage = tracking.publishAggregatesForAnalytics();
  assert.equal(analyticsMessage.type, "AttendeeEngagementAggregates");
  assert.equal(analyticsMessage.payload.sessions[0].sessionId, "s3");

  const retentionResult = tracking.applyRetentionPolicy({ now: new Date("2026-01-10T10:30:00.000Z").getTime() });
  assert.equal(retentionResult.retainedEvents, 0);
  assert.equal(retentionResult.retainedTimelines, 0);
});
