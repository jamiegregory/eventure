import test from "node:test";
import assert from "node:assert/strict";
import { EventCoreService } from "../services/event-core-service/src/eventCoreService.js";
import { InMemoryEventBus } from "../services/scheduling-service/src/eventBus.js";
import { SchedulingService } from "../services/scheduling-service/src/schedulingService.js";
import { NotificationService } from "../services/notification-service/src/notificationService.js";
import { LeadRetrievalService } from "../services/lead-retrieval-service/src/leadRetrievalService.js";
import { IntegrationService } from "../services/integration-service/src/crmConnectors.js";

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
});
