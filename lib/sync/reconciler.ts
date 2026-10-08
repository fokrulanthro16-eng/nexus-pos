import {
  NexusEvent,
  DiscrepancyPayload,
  DiscrepancyFlaggedEvent,
  InventoryItem,
  SyncPushRequest,
  SyncPushResponse,
  HLCTimestamp,
} from '@/types/events';
import { HybridLogicalClock } from '@/lib/hlc';

function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export interface ReconciliationResult {
  readonly acceptedEventIds: readonly string[];
  readonly duplicateEventIds: readonly string[];
  readonly generatedDiscrepancyEvents: readonly DiscrepancyFlaggedEvent[];
  readonly updatedInventory: ReadonlyMap<string, InventoryItem>;
  readonly serverHLC: HLCTimestamp;
}

/**
 * NexusPOS Authoritative Central Reconciliation Engine
 *
 * Core Guarantees:
 * 1. Idempotency Guard: Filters duplicate event IDs across all sync attempts.
 * 2. Deterministic Causal Ordering: Orders events via Hybrid Logical Clock timestamps.
 * 3. Non-Repudiation of Physical Sales: Never rejects confirmed cash/card sales.
 * 4. Concurrent Sellout Detection: Detects negative stock drift (-1, -2, etc.) from concurrent offline
 *    terminals, accepts the physical sale, decrements stock to negative, and emits a DISCREPANCY_FLAGGED incident.
 */
export class NexusCentralReconciler {
  private readonly knownEventIds: Set<string> = new Set();
  private readonly inventory: Map<string, InventoryItem> = new Map();
  private readonly serverClock: HybridLogicalClock;
  private readonly discrepancyAuditLog: DiscrepancyPayload[] = [];

  constructor(
    nodeId = 'SERVER_CENTRAL_01',
    initialInventory: InventoryItem[] = []
  ) {
    this.serverClock = new HybridLogicalClock(nodeId);
    for (const item of initialInventory) {
      this.inventory.set(item.sku, { ...item });
    }
  }

  /**
   * Authoritatively reconciles a batch of events from any terminal.
   */
  public reconcileBatch(events: readonly NexusEvent[]): ReconciliationResult {
    const acceptedEventIds: string[] = [];
    const duplicateEventIds: string[] = [];
    const generatedDiscrepancyEvents: DiscrepancyFlaggedEvent[] = [];

    // 1. Separate duplicate events (Idempotency Guard)
    const freshEvents: NexusEvent[] = [];
    for (const evt of events) {
      if (this.knownEventIds.has(evt.eventId)) {
        duplicateEventIds.push(evt.eventId);
      } else {
        freshEvents.push(evt);
      }
    }

    // 2. Deterministic total ordering via HLC comparator
    freshEvents.sort((a, b) => HybridLogicalClock.compare(a.hlc, b.hlc));

    // 3. Process events in deterministic causal order
    for (const evt of freshEvents) {
      // Advance central server clock past client causality horizon
      this.serverClock.update(evt.hlc);

      switch (evt.type) {
        case 'INVENTORY_INITIALIZED': {
          const payload = evt.payload;
          this.inventory.set(payload.sku, {
            sku: payload.sku,
            name: payload.name,
            price: payload.price,
            stock: payload.stock,
            reorderThreshold: payload.reorderThreshold,
            category: payload.category,
            updatedAt: evt.createdAt,
          });
          break;
        }

        case 'STOCK_ADJUSTED': {
          const payload = evt.payload;
          const existing = this.inventory.get(payload.sku);
          if (existing) {
            existing.stock += payload.quantityDelta;
            existing.updatedAt = evt.createdAt;
          } else {
            this.inventory.set(payload.sku, {
              sku: payload.sku,
              name: `SKU ${payload.sku}`,
              price: 0,
              stock: payload.quantityDelta,
              reorderThreshold: 5,
              updatedAt: evt.createdAt,
            });
          }
          break;
        }

        case 'SALE_COMMITTED': {
          const sale = evt.payload;

          for (const item of sale.items) {
            let invItem = this.inventory.get(item.sku);
            if (!invItem) {
              invItem = {
                sku: item.sku,
                name: item.name,
                price: item.price,
                stock: 0,
                reorderThreshold: 5,
                updatedAt: evt.createdAt,
              };
              this.inventory.set(item.sku, invItem);
            }

            const previousStock = invItem.stock;
            const newStock = previousStock - item.quantity;
            invItem.stock = newStock;
            invItem.updatedAt = evt.createdAt;

            // Detect concurrent offline sellout: stock dips below 0
            if (newStock < 0) {
              const deficit = Math.abs(newStock);
              const discrepancyPayload: DiscrepancyPayload = {
                incidentId: `inc_${generateUUID()}`,
                sku: item.sku,
                saleEventId: evt.eventId,
                terminalId: evt.terminalId,
                expectedStock: previousStock,
                actualStock: newStock,
                deficit,
                reason: 'CONCURRENT_OFFLINE_SELLOUT',
                detectedAt: new Date().toISOString(),
                resolved: false,
              };

              this.discrepancyAuditLog.push(discrepancyPayload);

              // Server generates authoritative incident event
              const discrepancyEvent: DiscrepancyFlaggedEvent = {
                eventId: `evt_disc_${generateUUID()}`,
                type: 'DISCREPANCY_FLAGGED',
                payload: discrepancyPayload,
                hlc: this.serverClock.now(),
                terminalId: this.serverClock.getNodeId(),
                version: 1,
                synced: true,
                createdAt: new Date().toISOString(),
              };

              generatedDiscrepancyEvents.push(discrepancyEvent);
              this.knownEventIds.add(discrepancyEvent.eventId);
            }
          }
          break;
        }

        case 'DISCREPANCY_FLAGGED': {
          this.discrepancyAuditLog.push(evt.payload);
          break;
        }
      }

      this.knownEventIds.add(evt.eventId);
      acceptedEventIds.push(evt.eventId);
    }

    return {
      acceptedEventIds,
      duplicateEventIds,
      generatedDiscrepancyEvents,
      updatedInventory: new Map(this.inventory),
      serverHLC: this.serverClock.peek(),
    };
  }

  /**
   * Processes a standard SyncPushRequest payload from a client terminal.
   */
  public handleSyncPush(request: SyncPushRequest): SyncPushResponse {
    const reconciliation = this.reconcileBatch(request.events);

    const discrepancies = reconciliation.generatedDiscrepancyEvents.map((e) => e.payload);

    return {
      idempotencyKey: request.idempotencyKey,
      acceptedEventIds: reconciliation.acceptedEventIds,
      duplicateEventIds: reconciliation.duplicateEventIds,
      discrepancies,
      serverHLC: reconciliation.serverHLC,
      success: true,
      message: `Reconciled ${reconciliation.acceptedEventIds.length} events (${reconciliation.duplicateEventIds.length} duplicates). Flagged ${discrepancies.length} discrepancies.`,
    };
  }

  /**
   * Inspect current inventory snapshot
   */
  public getInventory(sku: string): InventoryItem | undefined {
    const item = this.inventory.get(sku);
    return item ? { ...item } : undefined;
  }

  /**
   * Return full inventory map
   */
  public getAllInventory(): Map<string, InventoryItem> {
    return new Map(this.inventory);
  }

  /**
   * Inspect discrepancy incident audit trail
   */
  public getDiscrepancies(): readonly DiscrepancyPayload[] {
    return [...this.discrepancyAuditLog];
  }

  /**
   * Check if event has already been registered
   */
  public hasEvent(eventId: string): boolean {
    return this.knownEventIds.has(eventId);
  }

  public getServerClock(): HybridLogicalClock {
    return this.serverClock;
  }
}
