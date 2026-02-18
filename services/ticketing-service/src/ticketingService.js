const FINANCIAL_EVENT_TYPES = Object.freeze({
  TICKET_PURCHASED: "TicketPurchased",
  PAYMENT_CAPTURED: "PaymentCaptured",
  REFUND_ISSUED: "RefundIssued",
  CHARGE_FAILED: "ChargeFailed"
});

function toDate(value) {
  return value ? new Date(value).getTime() : null;
}

function isWithinWindow(now, startsAt, endsAt) {
  const nowMs = now.getTime();
  const startMs = toDate(startsAt);
  const endMs = toDate(endsAt);

  if (startMs && nowMs < startMs) {
    return false;
  }

  if (endMs && nowMs > endMs) {
    return false;
  }

  return true;
}

class TicketCatalog {
  constructor() {
    this.ticketTypes = new Map();
  }

  upsertTicketType(ticketType) {
    const normalized = {
      id: ticketType.id,
      eventId: ticketType.eventId,
      category: ticketType.category,
      currency: ticketType.currency ?? "USD",
      basePrice: ticketType.basePrice ?? 0,
      inventory: ticketType.inventory ?? Infinity,
      sold: ticketType.sold ?? 0,
      groupMinSize: ticketType.groupMinSize ?? null
    };

    this.ticketTypes.set(ticketType.id, normalized);
    return normalized;
  }

  getTicketType(ticketTypeId) {
    const ticketType = this.ticketTypes.get(ticketTypeId);
    if (!ticketType) {
      throw new Error(`Ticket type not found: ${ticketTypeId}`);
    }

    return ticketType;
  }

  reserve(ticketTypeId, quantity) {
    const ticketType = this.getTicketType(ticketTypeId);
    if (ticketType.sold + quantity > ticketType.inventory) {
      throw new Error(`Insufficient inventory for ticket type: ${ticketTypeId}`);
    }

    ticketType.sold += quantity;
    return ticketType;
  }

  restock(ticketTypeId, quantity) {
    const ticketType = this.getTicketType(ticketTypeId);
    ticketType.sold = Math.max(0, ticketType.sold - quantity);
    return ticketType;
  }
}

class DynamicPricingEngine {
  constructor() {
    this.pricingRules = new Map();
  }

  configure(ticketTypeId, { windows = [], tiers = [] }) {
    this.pricingRules.set(ticketTypeId, {
      windows,
      tiers: [...tiers].sort((a, b) => a.upTo - b.upTo)
    });
  }

  quote({ ticketType, quantity, now = new Date() }) {
    const rule = this.pricingRules.get(ticketType.id) ?? { windows: [], tiers: [] };
    let unitPrice = ticketType.basePrice;

    if (rule.tiers.length > 0) {
      const projectedSold = ticketType.sold + quantity;
      const tier = rule.tiers.find((candidate) => projectedSold <= candidate.upTo);
      if (tier) {
        unitPrice = tier.unitPrice;
      }
    }

    const activeWindows = rule.windows.filter((windowRule) =>
      isWithinWindow(now, windowRule.startsAt, windowRule.endsAt)
    );

    for (const windowRule of activeWindows) {
      if (windowRule.discountType === "percentage") {
        unitPrice -= unitPrice * (windowRule.value / 100);
      } else if (windowRule.discountType === "fixed") {
        unitPrice -= windowRule.value;
      }
    }

    return {
      unitPrice: Math.max(0, Number(unitPrice.toFixed(2))),
      appliedWindows: activeWindows.map((windowRule) => windowRule.name)
    };
  }
}

class PromoEngine {
  constructor() {
    this.codes = new Map();
  }

  registerPromo(promo) {
    this.codes.set(promo.code.toUpperCase(), {
      ...promo,
      redeemed: 0
    });
  }

  applyPromo({ code, ticketType, country, subtotal, now = new Date() }) {
    if (!code) {
      return { discountAmount: 0, promoCode: null };
    }

    const promo = this.codes.get(code.toUpperCase());
    if (!promo) {
      throw new Error(`Unknown promo code: ${code}`);
    }

    if (promo.maxRedemptions && promo.redeemed >= promo.maxRedemptions) {
      throw new Error(`Promo code exhausted: ${code}`);
    }

    if (!isWithinWindow(now, promo.startsAt, promo.endsAt)) {
      throw new Error(`Promo code inactive: ${code}`);
    }

    if (promo.ticketTypeIds && !promo.ticketTypeIds.includes(ticketType.id)) {
      throw new Error(`Promo code not valid for ticket type: ${ticketType.id}`);
    }

    if (promo.countries && !promo.countries.includes(country)) {
      throw new Error(`Promo code not valid for country: ${country}`);
    }

    if (promo.minSubtotal && subtotal < promo.minSubtotal) {
      throw new Error(`Promo code minimum subtotal not met: ${code}`);
    }

    const discountAmount = promo.discountType === "percentage"
      ? subtotal * (promo.value / 100)
      : promo.value;

    promo.redeemed += 1;

    return {
      promoCode: promo.code,
      discountAmount: Math.max(0, Number(Math.min(discountAmount, subtotal).toFixed(2)))
    };
  }
}

class ComplianceEngine {
  constructor({ countryRules = {}, taxRules = {} } = {}) {
    this.countryRules = countryRules;
    this.taxRules = taxRules;
  }

  assertCountryAllowed(country) {
    const rule = this.countryRules[country];
    if (rule?.blocked) {
      throw new Error(`Purchases are blocked in country: ${country}`);
    }
  }

  computeTax({ country, subtotal, vatId }) {
    const taxRule = this.taxRules[country] ?? { type: "none", rate: 0 };

    if (taxRule.type === "vat" && vatId) {
      return {
        taxType: "vat",
        taxRate: 0,
        taxAmount: 0,
        reason: "reverse-charge"
      };
    }

    const taxAmount = Number((subtotal * taxRule.rate).toFixed(2));

    return {
      taxType: taxRule.type,
      taxRate: taxRule.rate,
      taxAmount,
      reason: "standard"
    };
  }
}

export class TicketingService {
  constructor({ eventBus, paymentRegistry, complianceEngine } = {}) {
    this.eventBus = eventBus;
    this.paymentRegistry = paymentRegistry;
    this.catalog = new TicketCatalog();
    this.pricingEngine = new DynamicPricingEngine();
    this.promoEngine = new PromoEngine();
    this.complianceEngine = complianceEngine ?? new ComplianceEngine();
    this.orders = new Map();
    this.invoices = new Map();
    this.refunds = new Map();
  }

  upsertTicketType(ticketType) {
    return this.catalog.upsertTicketType(ticketType);
  }

  configureDynamicPricing(ticketTypeId, config) {
    this.pricingEngine.configure(ticketTypeId, config);
  }

  registerPromo(promo) {
    this.promoEngine.registerPromo(promo);
  }

  purchaseTickets({
    orderId,
    eventId,
    ticketTypeId,
    quantity,
    buyer,
    paymentProvider,
    paymentSource,
    promoCode,
    now = new Date()
  }) {
    const ticketType = this.catalog.getTicketType(ticketTypeId);
    if (ticketType.eventId !== eventId) {
      throw new Error(`Ticket type ${ticketTypeId} does not belong to event ${eventId}`);
    }

    if (ticketType.category === "group" && ticketType.groupMinSize && quantity < ticketType.groupMinSize) {
      throw new Error(`Group tickets require minimum quantity of ${ticketType.groupMinSize}`);
    }

    this.complianceEngine.assertCountryAllowed(buyer.country);

    const pricingQuote = this.pricingEngine.quote({ ticketType, quantity, now });
    const subtotal = Number((pricingQuote.unitPrice * quantity).toFixed(2));
    const promo = this.promoEngine.applyPromo({
      code: promoCode,
      ticketType,
      country: buyer.country,
      subtotal,
      now
    });
    const taxableAmount = Number((subtotal - promo.discountAmount).toFixed(2));
    const tax = this.complianceEngine.computeTax({
      country: buyer.country,
      subtotal: taxableAmount,
      vatId: buyer.vatId
    });

    const totalAmount = Number((taxableAmount + tax.taxAmount).toFixed(2));
    const paymentId = `${orderId}_payment`;
    let paymentResult = {
      status: "skipped",
      provider: paymentProvider,
      paymentId
    };

    if (totalAmount > 0) {
      const adapter = this.paymentRegistry.resolve(paymentProvider);
      paymentResult = adapter.capturePayment({
        paymentId,
        amount: totalAmount,
        currency: ticketType.currency,
        source: paymentSource,
        metadata: { orderId, eventId, ticketTypeId }
      });

      if (paymentResult.status !== "captured") {
        this.eventBus.emit(FINANCIAL_EVENT_TYPES.CHARGE_FAILED, {
          orderId,
          eventId,
          ticketTypeId,
          paymentProvider,
          paymentId,
          failureCode: paymentResult.failureCode
        });

        return {
          success: false,
          orderId,
          eventId,
          payment: paymentResult
        };
      }

      this.eventBus.emit(FINANCIAL_EVENT_TYPES.PAYMENT_CAPTURED, {
        orderId,
        eventId,
        ticketTypeId,
        paymentProvider,
        paymentId,
        amount: totalAmount,
        currency: ticketType.currency,
        providerTransactionId: paymentResult.providerTransactionId
      });
    }

    this.catalog.reserve(ticketTypeId, quantity);

    const invoice = {
      invoiceId: `${orderId}_invoice`,
      orderId,
      eventId,
      buyer,
      lines: [
        {
          description: `${ticketType.category} ticket`,
          quantity,
          unitPrice: pricingQuote.unitPrice,
          subtotal
        }
      ],
      pricing: {
        appliedWindows: pricingQuote.appliedWindows,
        promoCode: promo.promoCode,
        discountAmount: promo.discountAmount
      },
      tax,
      totalAmount,
      currency: ticketType.currency,
      paymentStatus: totalAmount === 0 ? "not-required" : "captured",
      payment: paymentResult,
      createdAt: new Date().toISOString(),
      reconciledAt: null
    };

    const order = {
      orderId,
      eventId,
      ticketTypeId,
      quantity,
      buyer,
      invoiceId: invoice.invoiceId,
      paymentId,
      status: "paid"
    };

    this.orders.set(orderId, order);
    this.invoices.set(invoice.invoiceId, invoice);

    this.eventBus.emit(FINANCIAL_EVENT_TYPES.TICKET_PURCHASED, {
      orderId,
      eventId,
      ticketTypeId,
      quantity,
      buyerId: buyer.id,
      totalAmount,
      currency: ticketType.currency
    });

    return {
      success: true,
      order,
      invoice,
      payment: paymentResult
    };
  }

  issueRefund({ orderId, amount, reason = "customer-request", paymentProvider }) {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    const invoice = this.invoices.get(order.invoiceId);
    if (!invoice) {
      throw new Error(`Invoice not found for order: ${orderId}`);
    }

    let refundResult = {
      status: "not-required",
      paymentId: order.paymentId,
      amount
    };

    if (amount > 0) {
      const adapter = this.paymentRegistry.resolve(paymentProvider);
      refundResult = adapter.refundPayment({
        paymentId: order.paymentId,
        amount,
        reason
      });

      if (refundResult.status !== "refunded") {
        throw new Error(`Refund failed for order ${orderId}: ${refundResult.failureCode}`);
      }
    }

    this.catalog.restock(order.ticketTypeId, order.quantity);
    order.status = "refunded";

    const record = {
      refundRequestId: `${orderId}_refund_${this.refunds.size + 1}`,
      orderId,
      invoiceId: invoice.invoiceId,
      amount,
      reason,
      status: refundResult.status,
      provider: paymentProvider,
      createdAt: new Date().toISOString(),
      payment: refundResult
    };

    this.refunds.set(record.refundRequestId, record);

    this.eventBus.emit(FINANCIAL_EVENT_TYPES.REFUND_ISSUED, {
      orderId,
      invoiceId: invoice.invoiceId,
      amount,
      paymentProvider,
      paymentId: order.paymentId,
      reason
    });

    return record;
  }

  runReconciliation({ paymentProvider }) {
    const adapter = this.paymentRegistry.resolve(paymentProvider);
    const settlements = adapter.listSettlements();
    const captureIndex = new Map(settlements.captures.map((capture) => [capture.paymentId, capture]));

    const results = [];

    for (const invoice of this.invoices.values()) {
      if (invoice.paymentStatus !== "captured") {
        continue;
      }

      const capture = captureIndex.get(invoice.payment.paymentId);
      const matched = Boolean(capture) && capture.amount === invoice.totalAmount;

      if (matched) {
        invoice.reconciledAt = new Date().toISOString();
      }

      results.push({
        invoiceId: invoice.invoiceId,
        paymentId: invoice.payment.paymentId,
        expectedAmount: invoice.totalAmount,
        settledAmount: capture?.amount ?? null,
        matched
      });
    }

    return {
      provider: paymentProvider,
      checkedInvoices: results.length,
      mismatches: results.filter((result) => !result.matched).length,
      results
    };
  }
}

export { FINANCIAL_EVENT_TYPES, ComplianceEngine };
