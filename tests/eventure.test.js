import test from "node:test";
import assert from "node:assert/strict";
import { EventCoreService } from "../services/event-core-service/src/eventCoreService.js";
import { InMemoryEventBus } from "../services/scheduling-service/src/eventBus.js";
import { SchedulingService } from "../services/scheduling-service/src/schedulingService.js";
import { NotificationService } from "../services/notification-service/src/notificationService.js";
import { AnalyticsService } from "../services/analytics-service/src/analyticsService.js";
import { AiPlannerService } from "../services/ai-planner-service/src/aiPlannerService.js";
import { AnalyticsContextAdapter, DomainContextAdapter } from "../services/ai-planner-service/src/contextAdapters.js";
import { LeadRetrievalService } from "../services/lead-retrieval-service/src/leadRetrievalService.js";
import { IntegrationService } from "../services/integration-service/src/crmConnectors.js";
import {
  AttendeeTrackingService,
  InMemoryAnalyticsPublisher
} from "../services/attendee-tracking-service/src/attendeeTrackingService.js";

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
test("lead retrieval captures, qualifies, and exports with consent and ownership controls", () => {
  const eventBus = new InMemoryEventBus();
  const service = new LeadRetrievalService({ eventBus });

  service.registerOwnershipPolicy({
    companyId: "comp1",
    boothId: "booth1",
    allowedUserIds: ["u1"],
    exportEnabled: true
  });

  const captured = service.captureBadgeLead({
    leadId: "lead1",
    eventId: "ev1",
    attendeeId: "att1",
    actorUserId: "u1",
    companyId: "comp1",
    boothId: "booth1",
    badgeScanId: "scan1",
    tenantId: "tenant1",
    traceId: "trace-1",
    consent: {
      granted: true,
      policyVersion: "v2",
      grantedAt: "2026-01-10T10:00:00.000Z"
    },
    qualification: {
      interestLevel: "warm",
      productInterest: ["analytics"],
      notes: "Interested in product demo"
    }
  });

  assert.equal(captured.status, "captured");

  const qualified = service.qualifyLead({
    leadId: "lead1",
    actorUserId: "u1",
    companyId: "comp1",
    boothId: "booth1",
    tenantId: "tenant1",
    traceId: "trace-2",
    qualification: {
      interestLevel: "hot",
      productInterest: ["analytics", "ai-planner"],
      notes: "Ready for follow-up call"
    }
  });

  assert.equal(qualified.status, "qualified");

  const exported = service.exportLead({
    leadId: "lead1",
    actorUserId: "u1",
    companyId: "comp1",
    boothId: "booth1",
    tenantId: "tenant1",
    traceId: "trace-3"
  });

  assert.equal(exported.status, "exported");

  const eventTypes = eventBus.allEvents().map((event) => event.type);
  assert.deepEqual(eventTypes, ["LeadCaptured", "LeadQualified", "LeadExported"]);
});

test("lead capture enforces anti-abuse duplicate window and explicit consent", () => {
  const service = new LeadRetrievalService({ eventBus: new InMemoryEventBus() });
  service.registerOwnershipPolicy({
    companyId: "comp2",
    boothId: "booth2",
    allowedUserIds: ["u2"],
    exportEnabled: false
  });

  assert.throws(
    () =>
      service.captureBadgeLead({
        leadId: "lead2",
        eventId: "ev2",
        attendeeId: "att2",
        actorUserId: "u2",
        companyId: "comp2",
        boothId: "booth2",
        badgeScanId: "scan2",
        tenantId: "tenant2",
        traceId: "trace-4",
        consent: {
          granted: false,
          policyVersion: "v1",
          grantedAt: "2026-01-10T10:00:00.000Z"
        },
        qualification: {
          interestLevel: "cold",
          productInterest: [],
          notes: ""
        }
      }),
    /Explicit attendee consent/
  );

  service.captureBadgeLead({
    leadId: "lead3",
    eventId: "ev2",
    attendeeId: "att3",
    actorUserId: "u2",
    companyId: "comp2",
    boothId: "booth2",
    badgeScanId: "scan3",
    tenantId: "tenant2",
    traceId: "trace-5",
    consent: {
      granted: true,
      policyVersion: "v1",
      grantedAt: "2026-01-10T10:01:00.000Z"
    },
    qualification: {
      interestLevel: "cold",
      productInterest: [],
      notes: ""
    }
  });

  assert.throws(
    () =>
      service.captureBadgeLead({
        leadId: "lead4",
        eventId: "ev2",
        attendeeId: "att3",
        actorUserId: "u2",
        companyId: "comp2",
        boothId: "booth2",
        badgeScanId: "scan4",
        tenantId: "tenant2",
        traceId: "trace-6",
        consent: {
          granted: true,
          policyVersion: "v1",
          grantedAt: "2026-01-10T10:02:00.000Z"
        },
        qualification: {
          interestLevel: "cold",
          productInterest: [],
          notes: ""
        }
      }),
    /Duplicate badge scan/
  );
});

test("integration service maps leads to Salesforce and HubSpot objects", () => {
  const integrationService = new IntegrationService();

  const lead = {
    leadId: "lead-map-1",
    eventId: "ev-map-1",
    attendeeId: "att-map-1",
    companyId: "comp-map",
    boothId: "booth-map",
    consent: {
      granted: true,
      policyVersion: "v3",
      grantedAt: "2026-01-10T11:00:00.000Z"
    },
    qualification: {
      interestLevel: "warm",
      productInterest: ["sponsorship", "mobile-app"],
      notes: "Asked for pricing deck"
    },
    capturedAt: "2026-01-10T11:00:00.000Z",
    qualifiedAt: "2026-01-10T11:30:00.000Z",
    exportedAt: "2026-01-10T11:40:00.000Z"
  };

  const salesforce = integrationService.mapLeadForCrm({ lead, provider: "salesforce" });
  assert.equal(salesforce.object, "Lead");
  assert.equal(salesforce.attributes.External_Id__c, "lead-map-1");

  const hubspot = integrationService.mapLeadForCrm({ lead, provider: "hubspot" });
  assert.equal(hubspot.objectType, "contacts");
  assert.equal(hubspot.properties.eventure_external_id, "lead-map-1");
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
