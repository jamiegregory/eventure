export class InMemoryEventBus {
  constructor() {
    this.events = [];
  }

  emit(type, payload) {
    const event = {
      type,
      payload,
      emittedAt: new Date().toISOString()
    };

    this.events.push(event);
    return event;
  }

  allEvents() {
    return [...this.events];
  }
}
