function average(values) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

export class AnalyticsService {
  constructor() {
    this.attendanceHistory = new Map();
    this.checkInHistory = new Map();
  }

  recordAttendance({ tenantId, eventId, timeslot, attendeeCount }) {
    const key = `${tenantId}:${eventId}:${timeslot}`;
    const entries = this.attendanceHistory.get(key) ?? [];
    entries.push(attendeeCount);
    this.attendanceHistory.set(key, entries);
  }

  getHistoricalAttendanceByTimeslot({ tenantId, eventId }) {
    const prefix = `${tenantId}:${eventId}:`;
    const results = [];

    for (const [key, counts] of this.attendanceHistory.entries()) {
      if (!key.startsWith(prefix)) {
        continue;
      }

      const timeslot = key.slice(prefix.length);
      results.push({
        timeslot,
        averageAttendance: Math.round(average(counts)),
        samples: counts.length
      });
    }

    return results;
  }

  recordCheckInOutcome({ tenantId, eventId, timeslot, attendeesCheckedIn, laneCount }) {
    const key = `${tenantId}:${eventId}:${timeslot}`;
    this.checkInHistory.set(key, {
      attendeesCheckedIn,
      laneCount
    });
  }

  getCheckInThroughput({ tenantId, eventId }) {
    const prefix = `${tenantId}:${eventId}:`;
    const output = [];

    for (const [key, value] of this.checkInHistory.entries()) {
      if (!key.startsWith(prefix)) {
        continue;
      }

      const timeslot = key.slice(prefix.length);
      output.push({
        timeslot,
        attendeesCheckedIn: value.attendeesCheckedIn,
        laneCount: value.laneCount,
        attendeesPerLane: value.laneCount === 0 ? 0 : Math.round(value.attendeesCheckedIn / value.laneCount)
      });
    }

    return output;
  }

  forecastAttendance({ tenantId, eventId, baselineAttendance, growthRate = 0 }) {
    const historical = this.getHistoricalAttendanceByTimeslot({ tenantId, eventId });
    if (historical.length === 0) {
      return {
        expectedTotalAttendance: Math.round(baselineAttendance * (1 + growthRate)),
        confidence: 0.45,
        basis: "baseline-only"
      };
    }

    const historicalAverage = average(historical.map((entry) => entry.averageAttendance));
    const forecast = Math.round(historicalAverage * (1 + growthRate));

    return {
      expectedTotalAttendance: Math.max(forecast, baselineAttendance),
      confidence: 0.72,
      basis: "historical-plus-growth"
    };
  }
}
