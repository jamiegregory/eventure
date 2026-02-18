import test from "node:test";
import assert from "node:assert/strict";
import { AnalyticsService } from "../services/analytics-service/src/analyticsService.js";

function seedEvents() {
  return [
    {
      eventId: "evt-1",
      type: "AttendeeRegistered",
      emittedAt: "2026-03-10T09:00:00.000Z",
      payload: {
        eventId: "conf-2026",
        attendeeId: "a1",
        attendeeRole: "engineer",
        sourceCampaign: "spring-launch"
      }
    },
    {
      eventId: "evt-2",
      type: "TicketPurchased",
      emittedAt: "2026-03-10T09:05:00.000Z",
      payload: {
        eventId: "conf-2026",
        attendeeId: "a1",
        ticketType: "vip",
        amount: 499,
        currency: "USD",
        sourceCampaign: "spring-launch"
      }
    },
    {
      eventId: "evt-3",
      type: "AttendeeCheckedIn",
      emittedAt: "2026-03-10T10:00:00.000Z",
      payload: {
        eventId: "conf-2026",
        attendeeId: "a1"
      }
    },
    {
      eventId: "evt-4",
      type: "SessionScheduled",
      emittedAt: "2026-03-10T10:30:00.000Z",
      payload: {
        eventId: "conf-2026",
        sessionId: "s1",
        roomId: "main-hall",
        startTime: "2026-03-10T11:00:00.000Z",
        endTime: "2026-03-10T12:00:00.000Z",
        roomCapacity: 100
      }
    },
    {
      eventId: "evt-5",
      type: "SessionAttended",
      emittedAt: "2026-03-10T11:10:00.000Z",
      payload: {
        eventId: "conf-2026",
        attendeeId: "a1",
        sessionId: "s1"
      }
    },
    {
      eventId: "evt-6",
      type: "SponsorLeadCaptured",
      emittedAt: "2026-03-10T11:15:00.000Z",
      payload: {
        eventId: "conf-2026",
        sponsorId: "sp-1",
        leadId: "lead-1",
        attendeeId: "a1",
        sourceCampaign: "expo-booth"
      }
    },
    {
      eventId: "evt-7",
      type: "SponsorLeadConverted",
      emittedAt: "2026-03-10T12:15:00.000Z",
      payload: {
        eventId: "conf-2026",
        sponsorId: "sp-1",
        leadId: "lead-1",
        revenue: 1200
      }
    },
    {
      eventId: "evt-8",
      type: "SchedulePublished",
      emittedAt: "2026-03-10T12:30:00.000Z",
      payload: {
        eventId: "conf-2026",
        scheduleId: "sched-1"
      }
    }
  ];
}

test("ingests domain events and materializes required marts and dashboards", () => {
  const analytics = new AnalyticsService({ now: () => new Date("2026-03-10T13:00:00.000Z") });
  analytics.ingestDomainEvents(seedEvents());

  const funnel = analytics.getRegistrationFunnelMart();
  assert.deepEqual(
    funnel.stages.map((stage) => stage.attendees),
    [1, 1, 1, 1]
  );

  const revenue = analytics.getTicketRevenueMart();
  assert.equal(revenue.totalRevenue, 499);
  assert.equal(revenue.revenueByTicketType.vip, 499);

  const room = analytics.getRoomUtilizationMart();
  assert.equal(room.rooms[0].roomId, "main-hall");
  assert.equal(room.rooms[0].utilizationRate, 0.01);

  const attendance = analytics.getAttendanceRateMart();
  assert.equal(attendance.attendanceRate, 1);

  const sponsor = analytics.getSponsorLeadPerformanceMart();
  assert.equal(sponsor.totals.capturedLeads, 1);
  assert.equal(sponsor.totals.convertedLeads, 1);

  const dashboard = analytics.getDashboardApi();
  assert.equal(dashboard.ticketRevenue.totalRevenue, 499);
  assert.equal(dashboard.qualityChecks.totalIssues, 0);
});

test("builds cohort segmentation model by ticket type, attendee role, and source campaign", () => {
  const analytics = new AnalyticsService();

  analytics.ingestDomainEvents([
    {
      eventId: "cohort-1",
      type: "AttendeeRegistered",
      emittedAt: "2026-03-10T09:00:00.000Z",
      payload: {
        eventId: "conf-2026",
        attendeeId: "a1",
        attendeeRole: "buyer",
        sourceCampaign: "linkedin"
      }
    },
    {
      eventId: "cohort-2",
      type: "TicketPurchased",
      emittedAt: "2026-03-10T09:10:00.000Z",
      payload: {
        eventId: "conf-2026",
        attendeeId: "a1",
        ticketType: "standard",
        amount: 99,
        sourceCampaign: "linkedin"
      }
    },
    {
      eventId: "cohort-3",
      type: "AttendeeCheckedIn",
      emittedAt: "2026-03-10T10:00:00.000Z",
      payload: {
        eventId: "conf-2026",
        attendeeId: "a1"
      }
    }
  ]);

  const model = analytics.getCohortSegmentationModel();
  assert.equal(model.segments.length, 1);
  assert.deepEqual(model.segments[0], {
    ticketType: "standard",
    attendeeRole: "buyer",
    sourceCampaign: "linkedin",
    attendees: 1,
    checkedIn: 1,
    attended: 0,
    revenue: 99,
    checkInRate: 1,
    attendanceRate: 0
  });
});

test("tracks data quality issues for missing ids, late events, and duplicate ingestion", () => {
  const analytics = new AnalyticsService({
    lateEventThresholdMs: 1000,
    now: () => new Date("2026-03-10T10:00:03.000Z")
  });

  const missingIds = analytics.ingestDomainEvent({
    eventId: null,
    type: "AttendeeRegistered",
    emittedAt: "2026-03-10T10:00:00.000Z",
    payload: {
      eventId: "conf-2026",
      attendeeId: "a1"
    }
  });

  assert.equal(missingIds.accepted, false);

  analytics.ingestDomainEvent({
    eventId: "late-1",
    type: "AttendeeRegistered",
    emittedAt: "2026-03-10T10:00:00.000Z",
    payload: {
      eventId: "conf-2026",
      attendeeId: "a2"
    }
  });

  analytics.ingestDomainEvent({
    eventId: "dup-1",
    type: "AttendeeRegistered",
    emittedAt: "2026-03-10T10:00:02.500Z",
    payload: {
      eventId: "conf-2026",
      attendeeId: "a3"
    }
  });

  const duplicate = analytics.ingestDomainEvent({
    eventId: "dup-1",
    type: "AttendeeRegistered",
    emittedAt: "2026-03-10T10:00:02.500Z",
    payload: {
      eventId: "conf-2026",
      attendeeId: "a3"
    }
  });

  assert.equal(duplicate.accepted, false);

  const quality = analytics.getDataQualityChecks();
  assert.equal(quality.byType["missing-ids"], 1);
  assert.equal(quality.byType["late-event"], 1);
  assert.equal(quality.byType["duplicate-ingestion"], 1);
});

test("exports downloadable reports in json and csv formats", () => {
  const analytics = new AnalyticsService();
  analytics.ingestDomainEvents(seedEvents());

  const jsonReport = analytics.getDownloadableReport("ticketRevenue", "json");
  assert.match(jsonReport, /"totalRevenue": 499/);

  const csvReport = analytics.getDownloadableReport("registrationFunnel", "csv");
  assert.match(csvReport, /stage,attendees/);
  assert.match(csvReport, /registered,1/);
});
