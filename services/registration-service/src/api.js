import express from "express";
import { InMemoryEventBus } from "../../scheduling-service/src/eventBus.js";
import { RegistrationService } from "./registrationService.js";

export function createRegistrationApi() {
  const app = express();
  app.use(express.json());

  const registrationService = new RegistrationService({
    eventBus: new InMemoryEventBus()
  });

  app.put("/events/:eventId/form", (req, res) => {
    const form = registrationService.configureForm({
      eventId: req.params.eventId,
      ...req.body
    });

    res.json(form);
  });

  app.put("/events/:eventId/policy", (req, res) => {
    const policy = registrationService.configurePolicy({
      eventId: req.params.eventId,
      ...req.body
    });

    res.json(policy);
  });

  app.post("/commands/start", (req, res) => {
    const result = registrationService.startRegistration(req.body);
    res.status(201).json(result);
  });

  app.post("/commands/submit", (req, res) => {
    const result = registrationService.submitRegistration(req.body);
    res.json(result);
  });

  app.post("/commands/approve", (req, res) => {
    const result = registrationService.approveRegistration(req.body);
    res.json(result);
  });

  app.post("/commands/cancel", (req, res) => {
    const result = registrationService.cancelRegistration(req.body);
    res.json(result);
  });

  // Reporting API for analytics-service consumers.
  app.get("/reporting/events/:eventId/summary", (req, res) => {
    res.json(registrationService.getAnalyticsReport(req.params.eventId));
  });

  app.get("/reporting/events/:eventId/registrations", (req, res) => {
    res.json({
      eventId: req.params.eventId,
      rows: registrationService.listRegistrationsForEvent(req.params.eventId)
    });
  });

  return {
    app,
    registrationService
  };
}
