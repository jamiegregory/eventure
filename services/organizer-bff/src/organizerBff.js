function toLookup(list, key = "id") {
  return new Map(list.map((item) => [item[key], item]));
}

function composeOrganizerView({ eventId, registrations, tickets, schedules, rooms }) {
  const eventRegistrations = registrations.filter((entry) => entry.eventId === eventId);
  const ticketsByAttendee = toLookup(tickets, "attendeeId");
  const roomsById = toLookup(rooms);

  const roster = eventRegistrations.map((registration) => ({
    attendeeId: registration.attendeeId,
    registration,
    ticket: ticketsByAttendee.get(registration.attendeeId) ?? null
  }));

  return {
    eventId,
    roster,
    sessions: schedules
      .filter((session) => session.eventId === eventId)
      .map((session) => ({ ...session, room: roomsById.get(session.roomId) ?? null }))
  };
}

const defaultData = {
  registrations: [
    { id: "reg-1", attendeeId: "a-1", eventId: "ev-1", status: "confirmed" },
    { id: "reg-2", attendeeId: "a-2", eventId: "ev-1", status: "waitlisted" }
  ],
  tickets: [
    { id: "ticket-1", attendeeId: "a-1", tier: "vip" },
    { id: "ticket-2", attendeeId: "a-2", tier: "standard" }
  ],
  schedules: [
    { id: "session-1", eventId: "ev-1", roomId: "room-1", title: "Opening Keynote" },
    { id: "session-2", eventId: "ev-1", roomId: "room-2", title: "Product Roadmap" }
  ],
  rooms: [
    { id: "room-1", name: "Main Hall" },
    { id: "room-2", name: "Workshop A" }
  ]
};

export function createOrganizerBff(seed = defaultData) {
  const data = {
    registrations: [...seed.registrations],
    tickets: [...seed.tickets],
    schedules: [...seed.schedules],
    rooms: [...seed.rooms]
  };

  return {
    handle(request) {
      const eventId = request.params?.eventId ?? request.query?.eventId ?? "ev-1";

      if (request.method === "GET" && request.path === "/registrations") {
        return {
          status: 200,
          traceId: request.meta?.traceId,
          authToken: request.meta?.token ?? null,
          data: data.registrations.filter((registration) => registration.eventId === eventId)
        };
      }

      if (request.method === "POST" && request.path === "/registrations/approve") {
        const registrationId = request.body?.registrationId;
        const registration = data.registrations.find((entry) => entry.id === registrationId);

        if (!registration) {
          return {
            status: 404,
            traceId: request.meta?.traceId,
            error: { code: "not_found", message: "Registration not found" }
          };
        }

        registration.status = "confirmed";
        return {
          status: 200,
          traceId: request.meta?.traceId,
          authToken: request.meta?.token ?? null,
          data: registration
        };
      }

      if (request.method === "GET" && request.path === "/overview") {
        return {
          status: 200,
          traceId: request.meta?.traceId,
          authToken: request.meta?.token ?? null,
          data: composeOrganizerView({
            eventId,
            registrations: data.registrations,
            tickets: data.tickets,
            schedules: data.schedules,
            rooms: data.rooms
          })
        };
      }

      return {
        status: 404,
        traceId: request.meta?.traceId,
        error: {
          code: "route_not_found",
          message: "Organizer BFF route not found"
        }
      };
    }
  };
}

export { composeOrganizerView };
