import express from "express";
import { SchedulingService } from "./schedulingService.js";
import { InMemoryEventBus } from "./eventBus.js";
import { NotificationService } from "../../notification-service/src/notificationService.js";

export function createSchedulingApi() {
  const app = express();
  app.use(express.json());

  const schedulingService = new SchedulingService({
    eventBus: new InMemoryEventBus(),
    notificationService: new NotificationService()
  });

  app.post("/proposals", (req, res) => {
    const proposal = schedulingService.createProposal(req.body);
    res.status(201).json(proposal);
  });

  app.post("/validate", (req, res) => {
    const result = schedulingService.validateProposal(req.body);
    res.json(result);
  });

  app.post("/publish", (req, res) => {
    const result = schedulingService.publishSchedule(req.body);
    const status = result.published ? 200 : 409;
    res.status(status).json(result);
  });

  app.get("/attendees/:attendeeId/agenda", (req, res) => {
    const agenda = schedulingService.getPersonalizedAgenda(
      req.params.attendeeId,
      req.query.scheduleId
    );

    res.json(agenda);
  });

  return { app, schedulingService };
}
