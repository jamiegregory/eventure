import express from "express";
import { InMemoryPubSubEventBus } from "./eventBus.js";
import { RoomSchedulingService } from "./roomSchedulingService.js";

export function createRoomSchedulingApi({ eventBus = new InMemoryPubSubEventBus() } = {}) {
  const app = express();
  app.use(express.json());

  const roomSchedulingService = new RoomSchedulingService({ eventBus });

  app.post("/rooms", (req, res) => {
    const room = roomSchedulingService.upsertRoom(req.body);
    res.status(201).json(room);
  });

  app.post("/rooms/:roomId/availability", (req, res) => {
    const room = roomSchedulingService.addAvailabilityWindow(req.params.roomId, req.body);
    res.status(201).json(room);
  });

  app.post("/rooms/:roomId/blackouts", (req, res) => {
    const room = roomSchedulingService.addBlackoutPeriod(req.params.roomId, req.body);
    res.status(201).json(room);
  });

  app.post("/assignments/solve", (req, res) => {
    const result = roomSchedulingService.solveAssignments(req.body);
    res.status(result.success ? 200 : 409).json(result);
  });

  app.post("/diagnostics/conflicts", (req, res) => {
    const diagnostics = roomSchedulingService.getConflictDiagnostics(req.body);
    res.json(diagnostics);
  });

  app.post("/assignments/override", (req, res) => {
    try {
      const result = roomSchedulingService.overrideAssignment(req.body);
      res.status(200).json(result);
    } catch (error) {
      res.status(409).json({ error: error.message });
    }
  });

  app.get("/assignments/:scheduleId", (req, res) => {
    const assignments = roomSchedulingService.getAssignments(req.params.scheduleId);
    if (!assignments) {
      res.status(404).json({ error: "assignment schedule not found" });
      return;
    }

    res.json(assignments);
  });

  app.get("/assignments/:scheduleId/audit", (req, res) => {
    const audit = roomSchedulingService.getAuditTrail(req.params.scheduleId);
    res.json({ scheduleId: req.params.scheduleId, audit });
  });

  return { app, roomSchedulingService, eventBus };
}
