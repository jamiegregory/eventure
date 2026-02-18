import express from "express";
import { InMemoryEventBus } from "../../scheduling-service/src/eventBus.js";
import { CheckinService } from "./checkinService.js";

export function createCheckinApi() {
  const app = express();
  app.use(express.json());

  const checkinService = new CheckinService({ eventBus: new InMemoryEventBus() });

  app.post("/attendees", (req, res) => {
    const attendee = checkinService.registerAttendee(req.body);
    res.status(201).json(attendee);
  });

  app.get("/attendees/lookup", (req, res) => {
    const attendee = checkinService.lookupAttendee({
      qrCode: req.query.qrCode,
      barcode: req.query.barcode,
      manualQuery: {
        attendeeId: req.query.attendeeId,
        email: req.query.email,
        name: req.query.name
      }
    });

    if (!attendee) {
      res.status(404).json({ error: "Attendee not found" });
      return;
    }

    res.json(attendee);
  });

  app.post("/checkins/transactions", (req, res) => {
    try {
      const result = checkinService.recordCheckinTransaction(req.body);
      res.status(200).json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/checkins/reverse", (req, res) => {
    try {
      const result = checkinService.reverseCheckin(req.body);
      res.status(200).json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/badge-print/queue", (req, res) => {
    const job = checkinService.enqueueBadgePrint(req.body);
    res.status(202).json(job);
  });

  app.post("/badge-print/queue/:jobId/process", (req, res) => {
    try {
      const job = checkinService.processBadgePrintJob(req.params.jobId, req.body.printedAt);
      res.status(200).json(job);
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });

  app.post("/sync/offline", (req, res) => {
    const result = checkinService.applyOfflineSync(req.body);
    res.status(200).json(result);
  });

  app.get("/ops/dashboard", (_req, res) => {
    res.json(checkinService.getOperationalDashboard());
  });

  return { app, checkinService };
}
