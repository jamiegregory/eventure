import express from "express";
import { AiPlannerService } from "./aiPlannerService.js";
import { AnalyticsContextAdapter, DomainContextAdapter } from "./contextAdapters.js";
import { AnalyticsService } from "../../analytics-service/src/analyticsService.js";
import { EventCoreService } from "../../event-core-service/src/eventCoreService.js";
import { SchedulingService } from "../../scheduling-service/src/schedulingService.js";
import { InMemoryEventBus } from "../../scheduling-service/src/eventBus.js";
import { NotificationService } from "../../notification-service/src/notificationService.js";

export function createAiPlannerApi({
  analyticsService = new AnalyticsService(),
  eventCoreService = new EventCoreService(),
  schedulingService = new SchedulingService({
    eventBus: new InMemoryEventBus(),
    notificationService: new NotificationService()
  })
} = {}) {
  const app = express();
  app.use(express.json());

  const aiPlannerService = new AiPlannerService({
    analyticsAdapter: new AnalyticsContextAdapter({ analyticsService }),
    domainAdapter: new DomainContextAdapter({ eventCoreService, schedulingService })
  });

  app.get("/capabilities", (_req, res) => {
    res.json({ capabilities: aiPlannerService.capabilities() });
  });

  app.post("/assistant/chat", (req, res) => {
    const payload = aiPlannerService.chat(req.body);
    res.json(payload);
  });

  app.post("/assistant/proposals", (req, res) => {
    const recommendation = aiPlannerService.generateRecommendation(req.body);
    res.status(201).json(recommendation);
  });

  app.post("/assistant/recommendations/:recommendationId/decision", (req, res) => {
    const feedback = aiPlannerService.submitDecision({
      ...req.body,
      recommendationId: req.params.recommendationId
    });
    res.status(201).json(feedback);
  });

  app.post("/assistant/recommendations/:recommendationId/outcomes", (req, res) => {
    const outcome = aiPlannerService.captureOutcome({
      ...req.body,
      recommendationId: req.params.recommendationId
    });
    res.status(201).json(outcome);
  });

  return {
    app,
    aiPlannerService,
    analyticsService,
    eventCoreService,
    schedulingService
  };
}
