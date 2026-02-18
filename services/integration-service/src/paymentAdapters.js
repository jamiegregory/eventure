function buildProviderId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export class PaymentAdapterRegistry {
  constructor() {
    this.adapters = new Map();
  }

  register(provider, adapter) {
    this.adapters.set(provider, adapter);
  }

  resolve(provider) {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`Unknown payment provider: ${provider}`);
    }

    return adapter;
  }
}

class BaseMemoryPaymentAdapter {
  constructor(provider) {
    this.provider = provider;
    this.captures = [];
    this.refunds = [];
  }

  capturePayment({ paymentId, amount, currency, source, metadata = {} }) {
    if (source?.includes("decline") || amount < 0) {
      return {
        status: "failed",
        failureCode: "card_declined",
                provider: this.provider,
        paymentId
      };
    }

    const record = {
      providerTransactionId: buildProviderId(`${this.provider}_cap`),
      paymentId,
      amount,
      currency,
      metadata,
      capturedAt: new Date().toISOString()
    };

    this.captures.push(record);

    return {
      status: "captured",
      provider: this.provider,
      ...record
    };
  }

  refundPayment({ paymentId, amount, reason }) {
    const capture = this.captures.find((item) => item.paymentId === paymentId);
    if (!capture) {
      return {
        status: "failed",
        failureCode: "payment_not_found",
        provider: this.provider,
        paymentId
      };
    }

    const totalRefunded = this.refunds
      .filter((item) => item.paymentId === paymentId)
      .reduce((sum, item) => sum + item.amount, 0);

    if (totalRefunded + amount > capture.amount) {
      return {
        status: "failed",
        failureCode: "refund_exceeds_capture",
        provider: this.provider,
        paymentId
      };
    }

    const record = {
      refundId: buildProviderId(`${this.provider}_ref`),
      paymentId,
      amount,
      reason,
      refundedAt: new Date().toISOString()
    };

    this.refunds.push(record);

    return {
      status: "refunded",
      provider: this.provider,
      ...record
    };
  }

  listSettlements() {
    return {
      captures: [...this.captures],
      refunds: [...this.refunds]
    };
  }
}

export class StripePaymentAdapter extends BaseMemoryPaymentAdapter {
  constructor() {
    super("stripe");
  }
}

export class PayPalPaymentAdapter extends BaseMemoryPaymentAdapter {
  constructor() {
    super("paypal");
  }
}
