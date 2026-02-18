const EVENT_TYPES = Object.freeze({
  CAPTURED: "LeadCaptured",
  QUALIFIED: "LeadQualified",
  EXPORTED: "LeadExported"
});

const INTEREST_LEVELS = new Set(["hot", "warm", "cold"]);

function buildEnvelope({ eventType, source, tenantId, traceId, payload }) {
  return {
    event_type: eventType,
    source,
    occurred_at: new Date().toISOString(),
    trace_id: traceId,
    tenant_id: tenantId,
    payload
  };
}

function normalizeQualification(input = {}) {
  const interestLevel = input.interestLevel ?? "cold";
  if (!INTEREST_LEVELS.has(interestLevel)) {
    throw new Error(`Unsupported interestLevel: ${interestLevel}`);
  }

  const productInterest = Array.isArray(input.productInterest) ? [...new Set(input.productInterest)] : [];
  const notes = (input.notes ?? "").trim();

  if (notes.length > 2000) {
    throw new Error("Qualification notes exceed 2000 characters");
  }

  return {
    interestLevel,
    productInterest,
    notes
  };
}

export class LeadRetrievalService {
  constructor({ eventBus, source = "lead-retrieval-service" }) {
    this.eventBus = eventBus;
    this.source = source;
    this.leads = new Map();
    this.policiesByBooth = new Map();
    this.captureAuditLog = [];
  }

  registerOwnershipPolicy({ companyId, boothId, allowedUserIds = [], exportEnabled = false }) {
    if (!companyId || !boothId) {
      throw new Error("companyId and boothId are required");
    }

    const policy = {
      companyId,
      boothId,
      allowedUserIds: new Set(allowedUserIds),
      exportEnabled
    };

    this.policiesByBooth.set(boothId, policy);
    return {
      ...policy,
      allowedUserIds: [...policy.allowedUserIds]
    };
  }

  captureBadgeLead({
    leadId,
    eventId,
    attendeeId,
    actorUserId,
    companyId,
    boothId,
    badgeScanId,
    tenantId,
    traceId,
    consent,
    qualification
  }) {
    this.assertLeadAccess({ actorUserId, companyId, boothId, operation: "capture" });
    this.assertConsent(consent);
    this.assertCaptureAllowed({ actorUserId, attendeeId, boothId });

    if (!leadId || !eventId || !attendeeId || !badgeScanId) {
      throw new Error("leadId, eventId, attendeeId, and badgeScanId are required");
    }

    const normalizedQualification = normalizeQualification(qualification);
    const lead = {
      leadId,
      eventId,
      attendeeId,
      actorUserId,
      companyId,
      boothId,
      badgeScanId,
      consent: {
        granted: true,
        policyVersion: consent.policyVersion,
        grantedAt: consent.grantedAt
      },
      qualification: normalizedQualification,
      status: "captured",
      capturedAt: new Date().toISOString(),
      qualifiedAt: null,
      exportedAt: null
    };

    this.leads.set(leadId, lead);
    this.captureAuditLog.push({
      actorUserId,
      attendeeId,
      boothId,
      capturedAt: lead.capturedAt
    });

    this.emit(EVENT_TYPES.CAPTURED, tenantId, traceId, {
      lead_id: lead.leadId,
      event_id: lead.eventId,
      attendee_id: lead.attendeeId,
      company_id: lead.companyId,
      booth_id: lead.boothId,
      badge_scan_id: lead.badgeScanId,
      consent_policy_version: consent.policyVersion
    });

    return lead;
  }

  qualifyLead({ leadId, actorUserId, companyId, boothId, tenantId, traceId, qualification }) {
    this.assertLeadAccess({ actorUserId, companyId, boothId, operation: "qualify" });
    const lead = this.getLeadOrThrow(leadId);

    lead.qualification = normalizeQualification(qualification);
    lead.qualifiedAt = new Date().toISOString();
    lead.status = "qualified";

    this.emit(EVENT_TYPES.QUALIFIED, tenantId, traceId, {
      lead_id: lead.leadId,
      attendee_id: lead.attendeeId,
      company_id: lead.companyId,
      booth_id: lead.boothId,
      interest_level: lead.qualification.interestLevel,
      product_interest: lead.qualification.productInterest
    });

    return lead;
  }

  exportLead({ leadId, actorUserId, companyId, boothId, tenantId, traceId }) {
    this.assertLeadAccess({ actorUserId, companyId, boothId, operation: "export" });
    const lead = this.getLeadOrThrow(leadId);
    const policy = this.getPolicyOrThrow(boothId);

    if (!policy.exportEnabled) {
      throw new Error(`Export is not enabled for booth ${boothId}`);
    }

    lead.exportedAt = new Date().toISOString();
    lead.status = "exported";

    this.emit(EVENT_TYPES.EXPORTED, tenantId, traceId, {
      lead_id: lead.leadId,
      attendee_id: lead.attendeeId,
      company_id: lead.companyId,
      booth_id: lead.boothId,
      exported_by: actorUserId
    });

    return lead;
  }

  assertConsent(consent) {
    if (!consent?.granted || !consent.policyVersion || !consent.grantedAt) {
      throw new Error("Explicit attendee consent is required before lead capture");
    }
  }

  assertCaptureAllowed({ actorUserId, attendeeId, boothId }) {
    const oneMinuteAgo = Date.now() - 60_000;
    const recentCaptures = this.captureAuditLog.filter((entry) => new Date(entry.capturedAt).getTime() >= oneMinuteAgo);

    const actorCaptures = recentCaptures.filter((entry) => entry.actorUserId === actorUserId);
    if (actorCaptures.length >= 20) {
      throw new Error(`Capture rate limit exceeded for actor ${actorUserId}`);
    }

    const duplicateWindow = Date.now() - 30_000;
    const duplicate = this.captureAuditLog.find(
      (entry) =>
        entry.attendeeId === attendeeId &&
        entry.boothId === boothId &&
        new Date(entry.capturedAt).getTime() >= duplicateWindow
    );

    if (duplicate) {
      throw new Error("Duplicate badge scan detected for attendee in active anti-abuse window");
    }
  }

  assertLeadAccess({ actorUserId, companyId, boothId, operation }) {
    const policy = this.getPolicyOrThrow(boothId);

    if (policy.companyId !== companyId) {
      throw new Error(`Company ${companyId} does not own booth ${boothId}`);
    }

    if (!policy.allowedUserIds.has(actorUserId)) {
      throw new Error(`User ${actorUserId} is not allowed to ${operation} leads for booth ${boothId}`);
    }
  }

  getPolicyOrThrow(boothId) {
    const policy = this.policiesByBooth.get(boothId);
    if (!policy) {
      throw new Error(`Ownership policy not found for booth ${boothId}`);
    }

    return policy;
  }

  getLeadOrThrow(leadId) {
    const lead = this.leads.get(leadId);
    if (!lead) {
      throw new Error(`Lead not found: ${leadId}`);
    }

    return lead;
  }

  emit(eventType, tenantId, traceId, payload) {
    const envelope = buildEnvelope({
      eventType,
      source: this.source,
      tenantId,
      traceId,
      payload
    });

    this.eventBus.emit(eventType, envelope);
    return envelope;
  }
}

export { EVENT_TYPES, INTEREST_LEVELS, normalizeQualification };
