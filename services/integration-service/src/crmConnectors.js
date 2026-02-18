function baseLeadFields(lead) {
  return {
    external_id: lead.leadId,
    event_id: lead.eventId,
    attendee_id: lead.attendeeId,
    company_id: lead.companyId,
    booth_id: lead.boothId,
    source: "badge-scan",
    consent_granted: lead.consent.granted,
    consent_policy_version: lead.consent.policyVersion,
    consent_granted_at: lead.consent.grantedAt,
    qualification_interest_level: lead.qualification.interestLevel,
    qualification_product_interest: lead.qualification.productInterest,
    qualification_notes: lead.qualification.notes,
    captured_at: lead.capturedAt,
    qualified_at: lead.qualifiedAt,
    exported_at: lead.exportedAt
  };
}

export class SalesforceConnector {
  mapLead(lead) {
    const fields = baseLeadFields(lead);
    return {
      object: "Lead",
      attributes: {
        External_Id__c: fields.external_id,
        Event_Id__c: fields.event_id,
        Attendee_Id__c: fields.attendee_id,
        Company_Id__c: fields.company_id,
        Booth_Id__c: fields.booth_id,
        LeadSource: fields.source,
        Consent_Granted__c: fields.consent_granted,
        Consent_Policy_Version__c: fields.consent_policy_version,
        Consent_Granted_At__c: fields.consent_granted_at,
        Interest_Level__c: fields.qualification_interest_level,
        Product_Interest__c: fields.qualification_product_interest.join(";"),
        Notes__c: fields.qualification_notes,
        Captured_At__c: fields.captured_at,
        Qualified_At__c: fields.qualified_at,
        Exported_At__c: fields.exported_at
      }
    };
  }
}

export class HubSpotConnector {
  mapLead(lead) {
    const fields = baseLeadFields(lead);
    return {
      objectType: "contacts",
      properties: {
        eventure_external_id: fields.external_id,
        eventure_event_id: fields.event_id,
        eventure_attendee_id: fields.attendee_id,
        eventure_company_id: fields.company_id,
        eventure_booth_id: fields.booth_id,
        lifecyclestage: "lead",
        lead_source: fields.source,
        eventure_consent_granted: String(fields.consent_granted),
        eventure_consent_policy_version: fields.consent_policy_version,
        eventure_consent_granted_at: fields.consent_granted_at,
        eventure_interest_level: fields.qualification_interest_level,
        eventure_product_interest: fields.qualification_product_interest.join(","),
        notes_last_contacted: fields.qualification_notes,
        eventure_captured_at: fields.captured_at,
        eventure_qualified_at: fields.qualified_at,
        eventure_exported_at: fields.exported_at
      }
    };
  }
}

export class IntegrationService {
  constructor({ salesforceConnector = new SalesforceConnector(), hubSpotConnector = new HubSpotConnector() } = {}) {
    this.salesforceConnector = salesforceConnector;
    this.hubSpotConnector = hubSpotConnector;
  }

  mapLeadForCrm({ lead, provider }) {
    if (provider === "salesforce") {
      return this.salesforceConnector.mapLead(lead);
    }

    if (provider === "hubspot") {
      return this.hubSpotConnector.mapLead(lead);
    }

    throw new Error(`Unsupported CRM provider: ${provider}`);
  }
}
