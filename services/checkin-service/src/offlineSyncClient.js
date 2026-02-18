export class OfflineCheckinClient {
  constructor({ deviceId }) {
    this.deviceId = deviceId;
    this.localQueue = [];
    this.synced = [];
  }

  enqueueOperation(operation) {
    this.localQueue.push({
      ...operation,
      clientOperationId: operation.clientOperationId ?? `op-${this.localQueue.length + 1}`,
      occurredAt: operation.occurredAt ?? new Date().toISOString()
    });
  }

  pendingQueue() {
    return [...this.localQueue];
  }

  syncWith(service) {
    const operations = this.pendingQueue();
    const result = service.applyOfflineSync({ deviceId: this.deviceId, operations });

    const appliedIds = new Set(result.applied.map((item) => item.clientOperationId));
    const duplicateIds = new Set(result.duplicates.map((item) => item.clientOperationId));

    this.localQueue = this.localQueue.filter(
      (operation) => !appliedIds.has(operation.clientOperationId) && !duplicateIds.has(operation.clientOperationId)
    );

    this.synced.push(result);
    return result;
  }
}
