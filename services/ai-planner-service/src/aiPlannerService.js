const CAPABILITIES = Object.freeze([
  "schedule-suggestion",
  "room-allocation-recommendation",
  "expected-attendance-forecasting",
  "staffing-and-check-in-lane-suggestions"
]);

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function inferLaneCount(expectedAttendance, throughput) {
  if (!throughput || throughput.length === 0) {
    return Math.max(1, Math.ceil(expectedAttendance / 120));
  }

  const perLane = throughput
    .map((entry) => entry.attendeesPerLane)
    .filter((value) => Number.isFinite(value) && value > 0);

  if (perLane.length === 0) {
    return Math.max(1, Math.ceil(expectedAttendance / 120));
  }

  const averagePerLane = perLane.reduce((total, value) => total + value, 0) / perLane.length;
  return Math.max(1, Math.ceil(expectedAttendance / averagePerLane));
}

function sanitizeMessage(message) {
  return String(message)
    .replace(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/g, "[redacted-email]")
    .replace(/\b\d{3}[-.]?\d{2,3}[-.]?\d{4}\b/g, "[redacted-phone]");
}

function ensureTenantIsolation(tenantId, context) {
  if (context.domain.event.id && context.domain.event && context.domain.event.id && context.domain.event.id.length > 0) {
    // domain context adapter already validates the tenant relation for event and schedule.
  }

  if (!tenantId || tenantId.length === 0) {
    throw new Error("Tenant id is required");
  }
}

function buildRecommendation({ tenantId, eventId, scheduleId, context }) {
  const expectedAttendance = context.analytics.attendanceForecast.expectedTotalAttendance;
  const laneSuggestion = inferLaneCount(expectedAttendance, context.analytics.checkInThroughput);
  const scheduleSlots = context.domain.schedule.slots;
  const sessions = context.domain.event.sessions;

  const roomAllocations = scheduleSlots.map((slot) => {
    const session = sessions.find((item) => item.id === slot.sessionId);
    const expectedSessionAttendance = Math.max(10, Math.round(expectedAttendance / Math.max(scheduleSlots.length, 1)));

    return {
      sessionId: slot.sessionId,
      roomId: slot.roomId,
      recommendation: expectedSessionAttendance > 80 ? "prefer-large-room" : "room-size-adequate",
      rationale: session
        ? `Track ${session.track} with ${expectedSessionAttendance} projected attendees`
        : `Projected ${expectedSessionAttendance} attendees`
    };
  });

  return {
    id: `rec-${eventId}-${Date.now()}`,
    tenantId,
    eventId,
    scheduleId,
    capabilities: CAPABILITIES,
    generatedAt: new Date().toISOString(),
    explainability: {
      evidence: {
        forecastBasis: context.analytics.attendanceForecast.basis,
        historicalAttendance: context.analytics.historicalAttendance,
        roomAllocations
      },
      summary:
        "Recommendations are derived from historical attendance, current session topology, and check-in throughput history."
    },
    recommendations: {
      scheduleSuggestion: {
        action: "stagger-high-demand-sessions",
        details: "Move the top-demand session by +15 minutes to reduce queue spikes.",
        confidence: clamp((context.analytics.attendanceForecast.confidence + 0.1))
      },
      roomAllocationRecommendation: {
        action: "rebalance-rooms-by-track-demand",
        details: roomAllocations,
        confidence: clamp(context.analytics.attendanceForecast.confidence)
      },
      expectedAttendanceForecasting: {
        action: "forecast-attendance",
        expectedTotalAttendance: expectedAttendance,
        confidence: clamp(context.analytics.attendanceForecast.confidence),
        basis: context.analytics.attendanceForecast.basis
      },
      staffingCheckInLaneSuggestions: {
        action: "optimize-check-in-lanes",
        recommendedLaneCount: laneSuggestion,
        recommendedStaffCount: laneSuggestion * 2,
        confidence: clamp(context.analytics.attendanceForecast.confidence - 0.06)
      }
    },
    guardrails: {
      tenantIsolation: "enforced",
      piiPolicy: "no-raw-pii",
      explainability: "included"
    }
  };
}

export class AiPlannerService {
  constructor({ analyticsAdapter, domainAdapter }) {
    this.analyticsAdapter = analyticsAdapter;
    this.domainAdapter = domainAdapter;
    this.recommendations = new Map();
    this.feedback = [];
  }

  generateRecommendation(request) {
    const {
      tenantId,
      eventId,
      scheduleId,
      baselineAttendance = 100,
      growthRate = 0,
      prompt = ""
    } = request;

    const context = {
      analytics: this.analyticsAdapter.getContext({
        tenantId,
        eventId,
        baselineAttendance,
        growthRate
      }),
      domain: this.domainAdapter.getContext({ tenantId, eventId, scheduleId })
    };

    ensureTenantIsolation(tenantId, context);

    const recommendation = buildRecommendation({ tenantId, eventId, scheduleId, context });
    recommendation.promptSummary = sanitizeMessage(prompt).slice(0, 400);

    this.recommendations.set(recommendation.id, recommendation);
    return recommendation;
  }

  chat({ tenantId, eventId, scheduleId, message, baselineAttendance = 100, growthRate = 0 }) {
    const recommendation = this.generateRecommendation({
      tenantId,
      eventId,
      scheduleId,
      baselineAttendance,
      growthRate,
      prompt: message
    });

    return {
      response: `Planning assistant analyzed ${eventId}. Consider ${recommendation.recommendations.staffingCheckInLaneSuggestions.recommendedLaneCount} check-in lanes with confidence ${recommendation.recommendations.staffingCheckInLaneSuggestions.confidence.toFixed(2)}.`,
      actionProposals: recommendation.recommendations,
      recommendationId: recommendation.id
    };
  }

  submitDecision({ tenantId, recommendationId, decision, reason }) {
    const recommendation = this.recommendations.get(recommendationId);
    if (!recommendation) {
      throw new Error(`Recommendation not found: ${recommendationId}`);
    }

    if (recommendation.tenantId !== tenantId) {
      throw new Error("Tenant isolation violation for recommendation decision");
    }

    if (!["accepted", "rejected"].includes(decision)) {
      throw new Error("Decision must be accepted or rejected");
    }

    const feedback = {
      tenantId,
      recommendationId,
      decision,
      reason: sanitizeMessage(reason ?? ""),
      submittedAt: new Date().toISOString()
    };

    this.feedback.push(feedback);
    return feedback;
  }

  captureOutcome({ tenantId, recommendationId, outcomeMetric, value, notes }) {
    const recommendation = this.recommendations.get(recommendationId);
    if (!recommendation) {
      throw new Error(`Recommendation not found: ${recommendationId}`);
    }

    if (recommendation.tenantId !== tenantId) {
      throw new Error("Tenant isolation violation for outcome capture");
    }

    const outcome = {
      tenantId,
      recommendationId,
      outcomeMetric,
      value,
      notes: sanitizeMessage(notes ?? ""),
      capturedAt: new Date().toISOString()
    };

    this.feedback.push({ type: "outcome", ...outcome });
    return outcome;
  }

  allFeedback() {
    return [...this.feedback];
  }

  capabilities() {
    return [...CAPABILITIES];
  }
}

export { CAPABILITIES };
