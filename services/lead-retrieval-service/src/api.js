import { LeadRetrievalService } from "./leadRetrievalService.js";
import { InMemoryEventBus } from "../../scheduling-service/src/eventBus.js";

export function createLeadRetrievalApi() {
  const leadRetrievalService = new LeadRetrievalService({
    eventBus: new InMemoryEventBus()
  });

  return {
    leadRetrievalService,
    registerOwnershipPolicy: (payload) => leadRetrievalService.registerOwnershipPolicy(payload),
    captureBadgeLead: (payload) => leadRetrievalService.captureBadgeLead(payload),
    qualifyLead: (payload) => leadRetrievalService.qualifyLead(payload),
    exportLead: (payload) => leadRetrievalService.exportLead(payload)
  };
}
