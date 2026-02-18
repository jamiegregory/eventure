export class InMemoryPubSubEventBus {
  constructor() {
    this.events = [];
    this.subscribers = new Map();
  }

  emit(type, payload) {
    const event = {
      type,
      payload,
      emittedAt: new Date().toISOString()
    };

    this.events.push(event);

    const handlers = this.subscribers.get(type) ?? [];
    for (const handler of handlers) {
      handler(payload, event);
    }

    return event;
  }

  subscribe(type, handler) {
    const handlers = this.subscribers.get(type) ?? [];
    handlers.push(handler);
    this.subscribers.set(type, handlers);

    return () => {
      const next = (this.subscribers.get(type) ?? []).filter((registered) => registered !== handler);
      this.subscribers.set(type, next);
    };
  }

  allEvents() {
    return [...this.events];
  }
}
