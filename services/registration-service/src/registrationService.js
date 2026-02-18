const REGISTRATION_EVENTS = Object.freeze({
  STARTED: "RegistrationStarted",
  COMPLETED: "RegistrationCompleted",
  WAITLISTED: "RegistrationWaitlisted",
  CANCELLED: "RegistrationCancelled"
});

const ATTENDEE_STATES = Object.freeze({
  STARTED: "started",
  SUBMITTED: "submitted",
  APPROVED: "approved",
  WAITLISTED: "waitlisted",
  CANCELLED: "cancelled"
});

function assertAllowedTransition(current, next) {
  const allowed = {
    [ATTENDEE_STATES.STARTED]: new Set([
      ATTENDEE_STATES.SUBMITTED,
      ATTENDEE_STATES.CANCELLED
    ]),
    [ATTENDEE_STATES.SUBMITTED]: new Set([
      ATTENDEE_STATES.APPROVED,
      ATTENDEE_STATES.WAITLISTED,
      ATTENDEE_STATES.CANCELLED
    ]),
    [ATTENDEE_STATES.WAITLISTED]: new Set([
      ATTENDEE_STATES.APPROVED,
      ATTENDEE_STATES.CANCELLED
    ]),
    [ATTENDEE_STATES.APPROVED]: new Set([ATTENDEE_STATES.CANCELLED]),
    [ATTENDEE_STATES.CANCELLED]: new Set()
  };

  if (!allowed[current]?.has(next)) {
    throw new Error(`Invalid attendee state transition: ${current} -> ${next}`);
  }
}

function toEventAttendeeKey(eventId, attendeeId) {
  return `${eventId}:${attendeeId}`;
}

function toIsoOrUndefined(value) {
  return value ? new Date(value).toISOString() : undefined;
}

export class RegistrationService {
  constructor({ eventBus }) {
    this.eventBus = eventBus;
    this.forms = new Map();
    this.policies = new Map();
    this.registrations = new Map();
    this.registrationByEventAndAttendee = new Map();
    this.commandResults = new Map();
  }

  configureForm({ eventId, fields = [], conditionalQuestions = [] }) {
    for (const question of conditionalQuestions) {
      if (!fields.some((field) => field.id === question.when.fieldId)) {
        throw new Error(`Conditional question references unknown field: ${question.when.fieldId}`);
      }
    }

    const form = {
      eventId,
      fields,
      conditionalQuestions,
      updatedAt: new Date().toISOString()
    };

    this.forms.set(eventId, form);
    return form;
  }

  configurePolicy({
    eventId,
    capacity = Number.POSITIVE_INFINITY,
    approvalsRequired = false,
    inviteOnly = false,
    invitedAttendeeIds = [],
    registrationDeadline
  }) {
    const policy = {
      eventId,
      capacity,
      approvalsRequired,
      inviteOnly,
      invitedAttendeeIds: new Set(invitedAttendeeIds),
      registrationDeadline: toIsoOrUndefined(registrationDeadline),
      updatedAt: new Date().toISOString()
    };

    this.policies.set(eventId, policy);

    return {
      ...policy,
      invitedAttendeeIds: [...policy.invitedAttendeeIds]
    };
  }

  startRegistration({ commandId, registrationId, eventId, attendeeId, answers = {} }) {
    return this.executeIdempotent(commandId, () => {
      const existing = this.findByEventAndAttendee(eventId, attendeeId);
      if (existing && existing.state !== ATTENDEE_STATES.CANCELLED) {
        throw new Error(`Duplicate registration attempt for attendee ${attendeeId} on event ${eventId}`);
      }

      this.assertCanRegister({ eventId, attendeeId });

      const registration = {
        registrationId,
        eventId,
        attendeeId,
        answers,
        state: ATTENDEE_STATES.STARTED,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        submittedAt: undefined,
        approvedAt: undefined,
        cancelledAt: undefined
      };

      this.registrations.set(registrationId, registration);
      this.registrationByEventAndAttendee.set(
        toEventAttendeeKey(eventId, attendeeId),
        registrationId
      );

      this.eventBus.emit(REGISTRATION_EVENTS.STARTED, {
        registrationId,
        eventId,
        attendeeId,
        state: registration.state
      });

      return { ...registration };
    });
  }

  submitRegistration({ commandId, registrationId, answers = {} }) {
    return this.executeIdempotent(commandId, () => {
      const registration = this.getRegistrationOrThrow(registrationId);
      assertAllowedTransition(registration.state, ATTENDEE_STATES.SUBMITTED);
      this.assertRegistrationDeadline(registration.eventId);

      registration.answers = {
        ...registration.answers,
        ...answers
      };
      registration.state = ATTENDEE_STATES.SUBMITTED;
      registration.submittedAt = new Date().toISOString();
      registration.updatedAt = new Date().toISOString();

      const outcome = this.evaluatePostSubmissionState(registration);
      return { ...outcome };
    });
  }

  approveRegistration({ commandId, registrationId }) {
    return this.executeIdempotent(commandId, () => {
      const registration = this.getRegistrationOrThrow(registrationId);
      if (
        registration.state !== ATTENDEE_STATES.SUBMITTED &&
        registration.state !== ATTENDEE_STATES.WAITLISTED
      ) {
        throw new Error(`Registration cannot be approved from state ${registration.state}`);
      }

      const policy = this.getPolicy(registration.eventId);
      if (this.countApprovedForEvent(registration.eventId) >= policy.capacity) {
        return this.moveToWaitlist(registration);
      }

      return this.markApproved(registration);
    });
  }

  cancelRegistration({ commandId, registrationId, reason }) {
    return this.executeIdempotent(commandId, () => {
      const registration = this.getRegistrationOrThrow(registrationId);
      if (registration.state === ATTENDEE_STATES.CANCELLED) {
        return { ...registration };
      }

      assertAllowedTransition(registration.state, ATTENDEE_STATES.CANCELLED);

      registration.state = ATTENDEE_STATES.CANCELLED;
      registration.cancelReason = reason;
      registration.cancelledAt = new Date().toISOString();
      registration.updatedAt = new Date().toISOString();

      this.eventBus.emit(REGISTRATION_EVENTS.CANCELLED, {
        registrationId,
        eventId: registration.eventId,
        attendeeId: registration.attendeeId,
        reason
      });

      return { ...registration };
    });
  }

  getAnalyticsReport(eventId) {
    const rows = this.listRegistrationsForEvent(eventId);
    const byState = rows.reduce(
      (acc, row) => {
        acc[row.state] = (acc[row.state] ?? 0) + 1;
        return acc;
      },
      {
        [ATTENDEE_STATES.STARTED]: 0,
        [ATTENDEE_STATES.SUBMITTED]: 0,
        [ATTENDEE_STATES.APPROVED]: 0,
        [ATTENDEE_STATES.WAITLISTED]: 0,
        [ATTENDEE_STATES.CANCELLED]: 0
      }
    );

    return {
      eventId,
      totals: {
        registrations: rows.length,
        approved: byState[ATTENDEE_STATES.APPROVED],
        waitlisted: byState[ATTENDEE_STATES.WAITLISTED],
        cancelled: byState[ATTENDEE_STATES.CANCELLED]
      },
      byState,
      conversion: {
        startedToSubmitted:
          byState[ATTENDEE_STATES.STARTED] + byState[ATTENDEE_STATES.SUBMITTED] === 0
            ? 0
            : byState[ATTENDEE_STATES.SUBMITTED] /
              (byState[ATTENDEE_STATES.STARTED] + byState[ATTENDEE_STATES.SUBMITTED]),
        submittedToApproved:
          byState[ATTENDEE_STATES.SUBMITTED] + byState[ATTENDEE_STATES.APPROVED] === 0
            ? 0
            : byState[ATTENDEE_STATES.APPROVED] /
              (byState[ATTENDEE_STATES.SUBMITTED] + byState[ATTENDEE_STATES.APPROVED])
      }
    };
  }

  listRegistrationsForEvent(eventId) {
    return [...this.registrations.values()]
      .filter((registration) => registration.eventId === eventId)
      .map((registration) => ({ ...registration }));
  }

  executeIdempotent(commandId, executeFn) {
    if (!commandId) {
      throw new Error("commandId is required for idempotent command processing");
    }

    if (this.commandResults.has(commandId)) {
      return this.commandResults.get(commandId);
    }

    const result = executeFn();
    this.commandResults.set(commandId, result);
    return result;
  }

  evaluatePostSubmissionState(registration) {
    const policy = this.getPolicy(registration.eventId);

    if (policy.approvalsRequired) {
      return { ...registration };
    }

    if (this.countApprovedForEvent(registration.eventId) >= policy.capacity) {
      return this.moveToWaitlist(registration);
    }

    return this.markApproved(registration);
  }

  markApproved(registration) {
    assertAllowedTransition(registration.state, ATTENDEE_STATES.APPROVED);
    registration.state = ATTENDEE_STATES.APPROVED;
    registration.approvedAt = new Date().toISOString();
    registration.updatedAt = new Date().toISOString();

    this.eventBus.emit(REGISTRATION_EVENTS.COMPLETED, {
      registrationId: registration.registrationId,
      eventId: registration.eventId,
      attendeeId: registration.attendeeId,
      state: registration.state
    });

    return { ...registration };
  }

  moveToWaitlist(registration) {
    assertAllowedTransition(registration.state, ATTENDEE_STATES.WAITLISTED);
    registration.state = ATTENDEE_STATES.WAITLISTED;
    registration.updatedAt = new Date().toISOString();

    this.eventBus.emit(REGISTRATION_EVENTS.WAITLISTED, {
      registrationId: registration.registrationId,
      eventId: registration.eventId,
      attendeeId: registration.attendeeId,
      state: registration.state
    });

    return { ...registration };
  }

  assertCanRegister({ eventId, attendeeId }) {
    const policy = this.getPolicy(eventId);
    this.assertRegistrationDeadline(eventId);

    if (policy.inviteOnly && !policy.invitedAttendeeIds.has(attendeeId)) {
      throw new Error(`Attendee ${attendeeId} is not invited to event ${eventId}`);
    }
  }

  assertRegistrationDeadline(eventId) {
    const policy = this.getPolicy(eventId);
    if (!policy.registrationDeadline) {
      return;
    }

    if (new Date().toISOString() > policy.registrationDeadline) {
      throw new Error(`Registration deadline has passed for event ${eventId}`);
    }
  }

  countApprovedForEvent(eventId) {
    return [...this.registrations.values()].filter(
      (registration) =>
        registration.eventId === eventId && registration.state === ATTENDEE_STATES.APPROVED
    ).length;
  }

  findByEventAndAttendee(eventId, attendeeId) {
    const registrationId = this.registrationByEventAndAttendee.get(
      toEventAttendeeKey(eventId, attendeeId)
    );

    return registrationId ? this.registrations.get(registrationId) : undefined;
  }

  getPolicy(eventId) {
    return (
      this.policies.get(eventId) ?? {
        eventId,
        capacity: Number.POSITIVE_INFINITY,
        approvalsRequired: false,
        inviteOnly: false,
        invitedAttendeeIds: new Set(),
        registrationDeadline: undefined
      }
    );
  }

  getRegistrationOrThrow(registrationId) {
    const registration = this.registrations.get(registrationId);

    if (!registration) {
      throw new Error(`Registration not found: ${registrationId}`);
    }

    return registration;
  }
}

export { ATTENDEE_STATES, REGISTRATION_EVENTS };
