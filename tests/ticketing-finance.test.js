import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryEventBus } from "../services/scheduling-service/src/eventBus.js";
import {
  PaymentAdapterRegistry,
  StripePaymentAdapter,
  PayPalPaymentAdapter
} from "../services/integration-service/src/paymentAdapters.js";
import {
  ComplianceEngine,
  FINANCIAL_EVENT_TYPES,
  TicketingService
} from "../services/ticketing-service/src/ticketingService.js";

test("ticket catalog supports free paid vip and group categories", () => {
  const registry = new PaymentAdapterRegistry();
  registry.register("stripe", new StripePaymentAdapter());

  const service = new TicketingService({
    eventBus: new InMemoryEventBus(),
    paymentRegistry: registry
  });

  service.upsertTicketType({ id: "t-free", eventId: "ev-pay", category: "free", basePrice: 0, inventory: 1000 });
  service.upsertTicketType({ id: "t-paid", eventId: "ev-pay", category: "paid", basePrice: 120, inventory: 300 });
  service.upsertTicketType({ id: "t-vip", eventId: "ev-pay", category: "vip", basePrice: 400, inventory: 40 });
  service.upsertTicketType({
    id: "t-group",
    eventId: "ev-pay",
    category: "group",
    basePrice: 80,
    inventory: 200,
    groupMinSize: 4
  });

  const free = service.catalog.getTicketType("t-free");
  const group = service.catalog.getTicketType("t-group");

  assert.equal(free.basePrice, 0);
  assert.equal(group.groupMinSize, 4);
});

test("dynamic pricing promo taxes invoice reconciliation and refund workflows", () => {
  const eventBus = new InMemoryEventBus();
  const registry = new PaymentAdapterRegistry();
  registry.register("stripe", new StripePaymentAdapter());

  const service = new TicketingService({
    eventBus,
    paymentRegistry: registry,
    complianceEngine: new ComplianceEngine({
      countryRules: { KP: { blocked: true } },
      taxRules: {
        US: { type: "sales-tax", rate: 0.08 },
        DE: { type: "vat", rate: 0.19 }
      }
    })
  });

  service.upsertTicketType({
    id: "vip-tiered",
    eventId: "ev-fin",
    category: "vip",
    basePrice: 500,
    inventory: 100,
    sold: 5,
    currency: "USD"
  });

  service.configureDynamicPricing("vip-tiered", {
    windows: [
      {
        name: "early-bird",
        discountType: "percentage",
        value: 10,
        startsAt: "2026-01-01T00:00:00.000Z",
        endsAt: "2026-04-01T00:00:00.000Z"
      }
    ],
    tiers: [
      { upTo: 10, unitPrice: 350 },
      { upTo: 30, unitPrice: 420 }
    ]
  });

  service.registerPromo({
    code: "SAVE20",
    discountType: "percentage",
    value: 20,
    maxRedemptions: 3,
    ticketTypeIds: ["vip-tiered"],
    startsAt: "2026-01-01T00:00:00.000Z",
    endsAt: "2026-05-01T00:00:00.000Z"
  });

  const purchase = service.purchaseTickets({
    orderId: "ord-1",
    eventId: "ev-fin",
    ticketTypeId: "vip-tiered",
    quantity: 2,
    buyer: { id: "buyer-1", country: "DE" },
    paymentProvider: "stripe",
    paymentSource: "card_ok",
    promoCode: "SAVE20",
    now: new Date("2026-02-15T00:00:00.000Z")
  });

  assert.equal(purchase.success, true);
  assert.equal(purchase.invoice.lines[0].unitPrice, 315);
  assert.equal(purchase.invoice.pricing.discountAmount, 126);
  assert.equal(purchase.invoice.tax.taxAmount, 95.76);

  const reconciliation = service.runReconciliation({ paymentProvider: "stripe" });
  assert.equal(reconciliation.mismatches, 0);

  const refund = service.issueRefund({
    orderId: "ord-1",
    amount: purchase.invoice.totalAmount,
    reason: "customer-request",
    paymentProvider: "stripe"
  });

  assert.equal(refund.status, "refunded");

  const eventTypes = eventBus.allEvents().map((event) => event.type);
  assert.deepEqual(eventTypes, [
    FINANCIAL_EVENT_TYPES.PAYMENT_CAPTURED,
    FINANCIAL_EVENT_TYPES.TICKET_PURCHASED,
    FINANCIAL_EVENT_TYPES.REFUND_ISSUED
  ]);
});

test("failed charge and blocked country compliance emit expected failures", () => {
  const eventBus = new InMemoryEventBus();
  const registry = new PaymentAdapterRegistry();
  registry.register("paypal", new PayPalPaymentAdapter());

  const service = new TicketingService({
    eventBus,
    paymentRegistry: registry,
    complianceEngine: new ComplianceEngine({
      countryRules: { KP: { blocked: true } },
      taxRules: { US: { type: "sales-tax", rate: 0.07 } }
    })
  });

  service.upsertTicketType({ id: "paid-1", eventId: "ev-sec", category: "paid", basePrice: 50, inventory: 100 });

  assert.throws(
    () =>
      service.purchaseTickets({
        orderId: "ord-blocked",
        eventId: "ev-sec",
        ticketTypeId: "paid-1",
        quantity: 1,
        buyer: { id: "buyer-2", country: "KP" },
        paymentProvider: "paypal",
        paymentSource: "card_ok"
      }),
    /blocked in country/
  );

  const failed = service.purchaseTickets({
    orderId: "ord-failed",
    eventId: "ev-sec",
    ticketTypeId: "paid-1",
    quantity: 1,
    buyer: { id: "buyer-3", country: "US" },
    paymentProvider: "paypal",
    paymentSource: "card_decline"
  });

  assert.equal(failed.success, false);

  const events = eventBus.allEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, FINANCIAL_EVENT_TYPES.CHARGE_FAILED);
});
