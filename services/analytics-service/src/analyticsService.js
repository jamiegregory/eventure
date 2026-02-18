const DEFAULT_LATE_EVENT_THRESHOLD_MS = 1000 * 60 * 60 * 24;

function toEpoch(value) {
  return new Date(value).getTime();
}

function toIso(value) {
  return new Date(value).toISOString();
}

function csvEscape(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const raw = String(value);
  if (raw.includes(",") || raw.includes("\"") || raw.includes("\n")) {
    return `"${raw.replaceAll("\"", "\"\"")}"`;
  }

  return raw;
}

function toCsv(rows) {
  if (rows.length === 0) {
    return "";
  }

  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [headers.join(",")];

  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(","));
  }

  return lines.join("\n");
}

export class AnalyticsService {
  constructor({ lateEventThresholdMs = DEFAULT_LATE_EVENT_THRESHOLD_MS, now = () => new Date() } = {}) {
    this.lateEventThresholdMs = lateEventThresholdMs;
    this.now = now;
    this.ingestedEvents = [];
    this.ingestedEventIds = new Set();
    this.qualityIssues = [];
    this.sessions = new Map();
    this.attendees = new Map();
    this.sponsors = new Map();
  }

  ingestDomainEvent(domainEvent) {
    const ingestedAt = toIso(this.now());
    const normalized = {
      eventId: domainEvent?.eventId,
      type: domainEvent?.type,
      emittedAt: domainEvent?.emittedAt,
      payload: domainEvent?.payload ?? {}
    };

    if (!normalized.eventId || !normalized.payload.eventId) {
      this.qualityIssues.push({
        issueType: "missing-ids",
        eventId: normalized.eventId ?? null,
        type: normalized.type ?? null,
        detectedAt: ingestedAt,
        details: "eventId and payload.eventId are required"
      });
      return { accepted: false, reason: "missing-ids" };
    }

    if (this.ingestedEventIds.has(normalized.eventId)) {
      this.qualityIssues.push({
        issueType: "duplicate-ingestion",
        eventId: normalized.eventId,
        type: normalized.type,
        detectedAt: ingestedAt,
        details: "eventId already ingested"
      });
      return { accepted: false, reason: "duplicate-ingestion" };
    }

    if (normalized.emittedAt && toEpoch(ingestedAt) - toEpoch(normalized.emittedAt) > this.lateEventThresholdMs) {
      this.qualityIssues.push({
        issueType: "late-event",
        eventId: normalized.eventId,
        type: normalized.type,
        detectedAt: ingestedAt,
        details: `event arrived more than ${this.lateEventThresholdMs}ms after emission`
      });
    }

    this.ingestedEventIds.add(normalized.eventId);
    this.ingestedEvents.push({ ...normalized, ingestedAt });
    this.projectToMarts(normalized);

    return { accepted: true };
  }

  ingestDomainEvents(events) {
    return events.map((event) => this.ingestDomainEvent(event));
  }

  projectToMarts(event) {
    const { type, payload } = event;
    const attendee = payload.attendeeId ? this.ensureAttendee(payload.attendeeId) : null;

    switch (type) {
      case "AttendeeRegistered": {
        attendee.registration = {
          registeredAt: payload.registeredAt ?? event.emittedAt,
          attendeeRole: payload.attendeeRole ?? "unknown",
          sourceCampaign: payload.sourceCampaign ?? "unknown"
        };
        break;
      }
      case "TicketPurchased": {
        attendee.ticketPurchase = {
          purchasedAt: payload.purchasedAt ?? event.emittedAt,
          ticketType: payload.ticketType ?? "unknown",
          amount: Number(payload.amount ?? 0),
          currency: payload.currency ?? "USD",
          sourceCampaign: payload.sourceCampaign ?? attendee.registration?.sourceCampaign ?? "unknown"
        };
        break;
      }
      case "AttendeeCheckedIn": {
        attendee.checkedInAt = payload.checkedInAt ?? event.emittedAt;
        break;
      }
      case "SessionScheduled": {
        const startEpoch = toEpoch(payload.startTime);
        const endEpoch = toEpoch(payload.endTime);
        this.sessions.set(payload.sessionId, {
          sessionId: payload.sessionId,
          roomId: payload.roomId,
          startTime: payload.startTime,
          endTime: payload.endTime,
          durationMinutes: Math.max(0, Math.round((endEpoch - startEpoch) / 60000)),
          roomCapacity: Number(payload.roomCapacity ?? 0),
          attendees: new Set()
        });
        break;
      }
      case "SessionAttended": {
        if (attendee) {
          attendee.attendedSessions.add(payload.sessionId);
        }

        const scheduledSession = this.sessions.get(payload.sessionId);
        if (scheduledSession) {
          scheduledSession.attendees.add(payload.attendeeId);
        }
        break;
      }
      case "SponsorLeadCaptured": {
        const sponsor = this.ensureSponsor(payload.sponsorId);
        sponsor.leads.set(payload.leadId, {
          leadId: payload.leadId,
          attendeeId: payload.attendeeId,
          sourceCampaign: payload.sourceCampaign ?? "unknown",
          capturedAt: payload.capturedAt ?? event.emittedAt,
          converted: false,
          revenue: 0
        });
        break;
      }
      case "SponsorLeadConverted": {
        const sponsor = this.ensureSponsor(payload.sponsorId);
        const lead = sponsor.leads.get(payload.leadId) ?? {
          leadId: payload.leadId,
          attendeeId: payload.attendeeId ?? "unknown",
          sourceCampaign: payload.sourceCampaign ?? "unknown",
          capturedAt: payload.capturedAt ?? null,
          converted: false,
          revenue: 0
        };

        lead.converted = true;
        lead.revenue = Number(payload.revenue ?? 0);
        lead.convertedAt = payload.convertedAt ?? event.emittedAt;
        sponsor.leads.set(payload.leadId, lead);
        break;
      }
      default:
        // Ingests all domain events, and only projects known events into marts.
        break;
    }
  }

  ensureAttendee(attendeeId) {
    const existing = this.attendees.get(attendeeId);
    if (existing) {
      return existing;
    }

    const attendee = {
      attendeeId,
      registration: null,
      ticketPurchase: null,
      checkedInAt: null,
      attendedSessions: new Set()
    };

    this.attendees.set(attendeeId, attendee);
    return attendee;
  }

  ensureSponsor(sponsorId) {
    const existing = this.sponsors.get(sponsorId);
    if (existing) {
      return existing;
    }

    const sponsor = {
      sponsorId,
      leads: new Map()
    };

    this.sponsors.set(sponsorId, sponsor);
    return sponsor;
  }

  getRegistrationFunnelMart() {
    const attendees = [...this.attendees.values()];
    const registered = attendees.filter((a) => a.registration).length;
    const purchased = attendees.filter((a) => a.ticketPurchase).length;
    const checkedIn = attendees.filter((a) => a.checkedInAt).length;
    const attended = attendees.filter((a) => a.attendedSessions.size > 0).length;

    return {
      stages: [
        { stage: "registered", attendees: registered },
        { stage: "ticket_purchased", attendees: purchased },
        { stage: "checked_in", attendees: checkedIn },
        { stage: "attended_session", attendees: attended }
      ],
      conversionRates: {
        registrationToPurchase: registered ? purchased / registered : 0,
        purchaseToCheckIn: purchased ? checkedIn / purchased : 0,
        checkInToAttendance: checkedIn ? attended / checkedIn : 0
      }
    };
  }

  getTicketRevenueMart() {
    const purchases = [...this.attendees.values()].flatMap((attendee) =>
      attendee.ticketPurchase ? [{ attendeeId: attendee.attendeeId, ...attendee.ticketPurchase }] : []
    );

    const revenueByTicketType = purchases.reduce((acc, purchase) => {
      acc[purchase.ticketType] = (acc[purchase.ticketType] ?? 0) + purchase.amount;
      return acc;
    }, {});

    return {
      currency: purchases[0]?.currency ?? "USD",
      totalRevenue: purchases.reduce((sum, purchase) => sum + purchase.amount, 0),
      purchases: purchases.length,
      revenueByTicketType
    };
  }

  getRoomUtilizationMart() {
    const rooms = new Map();

    for (const session of this.sessions.values()) {
      const room = rooms.get(session.roomId) ?? {
        roomId: session.roomId,
        bookedSeatMinutes: 0,
        consumedSeatMinutes: 0
      };

      room.bookedSeatMinutes += session.durationMinutes * session.roomCapacity;
      room.consumedSeatMinutes += session.durationMinutes * session.attendees.size;
      rooms.set(session.roomId, room);
    }

    const roomMetrics = [...rooms.values()].map((room) => ({
      ...room,
      utilizationRate: room.bookedSeatMinutes ? room.consumedSeatMinutes / room.bookedSeatMinutes : 0
    }));

    return {
      rooms: roomMetrics,
      overallUtilizationRate:
        roomMetrics.reduce((sum, room) => sum + room.consumedSeatMinutes, 0) /
        (roomMetrics.reduce((sum, room) => sum + room.bookedSeatMinutes, 0) || 1)
    };
  }

  getAttendanceRateMart() {
    const attendees = [...this.attendees.values()];
    const registered = attendees.filter((attendee) => attendee.registration).length;
    const checkedIn = attendees.filter((attendee) => attendee.checkedInAt).length;
    const attended = attendees.filter((attendee) => attendee.attendedSessions.size > 0).length;

    return {
      registeredAttendees: registered,
      checkedInAttendees: checkedIn,
      attendedAttendees: attended,
      attendanceRate: registered ? attended / registered : 0,
      checkInRate: registered ? checkedIn / registered : 0
    };
  }

  getSponsorLeadPerformanceMart() {
    const sponsors = [...this.sponsors.values()].map((sponsor) => {
      const leads = [...sponsor.leads.values()];
      const converted = leads.filter((lead) => lead.converted);
      return {
        sponsorId: sponsor.sponsorId,
        capturedLeads: leads.length,
        convertedLeads: converted.length,
        conversionRate: leads.length ? converted.length / leads.length : 0,
        revenue: converted.reduce((sum, lead) => sum + lead.revenue, 0)
      };
    });

    return {
      sponsors,
      totals: {
        capturedLeads: sponsors.reduce((sum, sponsor) => sum + sponsor.capturedLeads, 0),
        convertedLeads: sponsors.reduce((sum, sponsor) => sum + sponsor.convertedLeads, 0),
        revenue: sponsors.reduce((sum, sponsor) => sum + sponsor.revenue, 0)
      }
    };
  }

  getCohortSegmentationModel() {
    const segments = new Map();

    for (const attendee of this.attendees.values()) {
      const ticketType = attendee.ticketPurchase?.ticketType ?? "unknown";
      const attendeeRole = attendee.registration?.attendeeRole ?? "unknown";
      const sourceCampaign = attendee.ticketPurchase?.sourceCampaign ?? attendee.registration?.sourceCampaign ?? "unknown";
      const key = `${ticketType}|${attendeeRole}|${sourceCampaign}`;
      const segment = segments.get(key) ?? {
        ticketType,
        attendeeRole,
        sourceCampaign,
        attendees: 0,
        checkedIn: 0,
        attended: 0,
        revenue: 0
      };

      segment.attendees += 1;
      if (attendee.checkedInAt) {
        segment.checkedIn += 1;
      }

      if (attendee.attendedSessions.size > 0) {
        segment.attended += 1;
      }

      if (attendee.ticketPurchase) {
        segment.revenue += attendee.ticketPurchase.amount;
      }

      segments.set(key, segment);
    }

    return {
      segments: [...segments.values()].map((segment) => ({
        ...segment,
        checkInRate: segment.attendees ? segment.checkedIn / segment.attendees : 0,
        attendanceRate: segment.attendees ? segment.attended / segment.attendees : 0
      }))
    };
  }

  getDashboardApi() {
    return {
      registrationFunnel: this.getRegistrationFunnelMart(),
      ticketRevenue: this.getTicketRevenueMart(),
      roomUtilization: this.getRoomUtilizationMart(),
      attendanceRate: this.getAttendanceRateMart(),
      sponsorLeadPerformance: this.getSponsorLeadPerformanceMart(),
      segmentation: this.getCohortSegmentationModel(),
      qualityChecks: this.getDataQualityChecks()
    };
  }

  getDataQualityChecks() {
    const grouped = this.qualityIssues.reduce((acc, issue) => {
      acc[issue.issueType] = (acc[issue.issueType] ?? 0) + 1;
      return acc;
    }, {});

    return {
      totalIssues: this.qualityIssues.length,
      byType: grouped,
      issues: [...this.qualityIssues]
    };
  }

  getDownloadableReport(reportName, format = "json") {
    const reportData = this.resolveReport(reportName);

    if (format === "json") {
      return JSON.stringify(reportData, null, 2);
    }

    if (format === "csv") {
      if (Array.isArray(reportData)) {
        return toCsv(reportData);
      }

      if (reportData && Array.isArray(reportData.stages)) {
        return toCsv(reportData.stages);
      }

      if (reportData && Array.isArray(reportData.rooms)) {
        return toCsv(reportData.rooms);
      }

      if (reportData && Array.isArray(reportData.sponsors)) {
        return toCsv(reportData.sponsors);
      }

      if (reportData && Array.isArray(reportData.segments)) {
        return toCsv(reportData.segments);
      }

      if (reportData && Array.isArray(reportData.issues)) {
        return toCsv(reportData.issues);
      }

      return toCsv([reportData]);
    }

    throw new Error(`Unsupported report format: ${format}`);
  }

  resolveReport(reportName) {
    const reports = {
      registrationFunnel: this.getRegistrationFunnelMart(),
      ticketRevenue: this.getTicketRevenueMart(),
      roomUtilization: this.getRoomUtilizationMart(),
      attendanceRate: this.getAttendanceRateMart(),
      sponsorLeadPerformance: this.getSponsorLeadPerformanceMart(),
      segmentation: this.getCohortSegmentationModel(),
      dataQuality: this.getDataQualityChecks(),
      dashboard: this.getDashboardApi()
    };

    const report = reports[reportName];
    if (!report) {
      throw new Error(`Unknown report: ${reportName}`);
    }

    return report;
  }
}
