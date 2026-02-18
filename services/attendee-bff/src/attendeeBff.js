function toLookup(list, key = "id") {
  return new Map(list.map((item) => [item[key], item]));
}

function composeAttendeeView({ attendeeId, registrations, tickets, schedules, rooms }) {
  const registration = registrations.find((entry) => entry.attendeeId === attendeeId) ?? null;
  const ticket = tickets.find((entry) => entry.attendeeId === attendeeId) ?? null;
  const roomById = toLookup(rooms);

  const sessions = schedules
    .filter((session) => session.attendeeIds?.includes(attendeeId))
    .map((session) => ({
      ...session,
      room: roomById.get(session.roomId) ?? null
    }));

  return {
    attendeeId,
    registration,
    ticket,
    schedule: sessions
  };
}

const defaultData = {
  registrations: [
    { id: "reg-1", attendeeId: "a-1", eventId: "ev-1", status: "confirmed" }
  ],
  tickets: [
    { id: "ticket-1", attendeeId: "a-1", tier: "vip", qrCode: "QR-a-1" }
  ],
  schedules: [
    {
      id: "session-1",
      attendeeIds: ["a-1"],
      title: "Opening Keynote",
      roomId: "room-1",
      startTime: "2026-01-10T09:00:00.000Z"
    }
  ],
  rooms: [{ id: "room-1", name: "Main Hall", capacity: 400 }],
  notifications: [{ id: "n-1", attendeeId: "a-1", message: "Schedule updated" }],
  checkIns: []
};

export function createAttendeeBff(seed = defaultData) {
  const data = {
    registrations: [...seed.registrations],
    tickets: [...seed.tickets],
    schedules: [...seed.schedules],
    rooms: [...seed.rooms],
    notifications: [...seed.notifications],
    checkIns: [...seed.checkIns]
  };

  return {
    handle(request) {
      const attendeeId = request.params?.attendeeId ?? request.query?.attendeeId ?? "a-1";

      if (request.method === "GET" && request.path === "/agenda") {
        const sessions = data.schedules.filter((session) => session.attendeeIds?.includes(attendeeId));
        return {
          status: 200,
          traceId: request.meta?.traceId,
          authToken: request.meta?.token ?? null,
          data: { attendeeId, sessions }
        };
      }

      if (request.method === "GET" && request.path === "/tickets") {
        return {
          status: 200,
          traceId: request.meta?.traceId,
          authToken: request.meta?.token ?? null,
          data: data.tickets.filter((ticket) => ticket.attendeeId === attendeeId)
        };
      }

      if (request.method === "POST" && request.path === "/check-in") {
        const record = {
          id: `check-in-${data.checkIns.length + 1}`,
          attendeeId,
          qrCode: request.body?.qrCode,
          checkedInAt: new Date().toISOString()
        };

        data.checkIns.push(record);
        return {
          status: 201,
          traceId: request.meta?.traceId,
          authToken: request.meta?.token ?? null,
          data: record
        };
      }

      if (request.method === "GET" && request.path === "/notifications") {
        return {
          status: 200,
          traceId: request.meta?.traceId,
          authToken: request.meta?.token ?? null,
          data: data.notifications.filter((notification) => notification.attendeeId === attendeeId)
        };
      }

      if (request.method === "GET" && request.path === "/overview") {
        return {
          status: 200,
          traceId: request.meta?.traceId,
          authToken: request.meta?.token ?? null,
          data: composeAttendeeView({
            attendeeId,
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
          message: "Attendee BFF route not found"
        }
      };
    }
  };
}

export { composeAttendeeView };
