import Dexie, { type Table } from 'dexie';
import {
  NexusEvent,
  SaleCommittedEvent,
  InventoryInitializedEvent,
  StockAdjustedEvent,
  InventoryItem,
  OutboxRecord,
  InventorySnapshot,
  SalePayload,
  InventoryPayload,
  StockAdjustedPayload,
} from '@/types/events';
import { HybridLogicalClock } from '@/lib/hlc';
import { signEvent } from '@/lib/crypto/signer';

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

/**
 * NexusPOS Client IndexedDB Database using Dexie.js
 * Tracks:
 * 1. Immutable append-only domain event log (`events`)
 * 2. Instant zero-latency materialized inventory view (`inventory`)
 * 3. Durable offline-first sync queue with retry telemetry (`outbox`)
 * 4. Periodic materialized state snapshots (`snapshots`)
 *
 * Includes an automatic in-memory fallback store to guarantee uninterrupted operation
 * if IndexedDB is blocked, slow, or running in restricted browser modes.
 */
export class NexusClientDatabase extends Dexie {
  events!: Table<NexusEvent, string>;
  inventory!: Table<InventoryItem, string>;
  outbox!: Table<OutboxRecord, number>;
  snapshots!: Table<InventorySnapshot, string>;

  private isOpenResolved = false;
  private isFallbackMode = false;
  private fallbackInventory: Map<string, InventoryItem> = new Map();
  private fallbackEvents: NexusEvent[] = [];
  private fallbackOutbox: OutboxRecord[] = [];
  private fallbackSnapshots: InventorySnapshot[] = [];

  constructor(dbName = 'NexusPOS_Client_DB') {
    super(dbName);

    this.version(1).stores({
      // Primary key eventId, indexed by terminalId, hlc.millis, synced, type, createdAt
      events: 'eventId, terminalId, hlc.millis, synced, type, createdAt',
      // Primary key sku, indexed by stock, reorderThreshold, name
      inventory: 'sku, stock, reorderThreshold, name',
      // Primary key autoincrement id, indexed by eventId, idempotencyKey, attempts, createdAt
      outbox: '++id, eventId, idempotencyKey, attempts, createdAt',
      // Primary key snapshotId, indexed by terminalId, hlc.millis, createdAt
      snapshots: 'snapshotId, terminalId, hlc.millis, createdAt',
    });
  }

  /**
   * Safe asynchronous database initialization with timeout guard.
   * Guarantees resolution within timeoutMs and falls back to memory store if IndexedDB stalls.
   */
  async initClientDb(timeoutMs = 1500): Promise<boolean> {
    if (this.isOpenResolved) return !this.isFallbackMode;

    try {
      const openPromise = this.open();
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Dexie open timed out after ${timeoutMs}ms`)), timeoutMs);
      });

      await Promise.race([openPromise, timeoutPromise]);
      this.isOpenResolved = true;
      this.isFallbackMode = false;
      return true;
    } catch (err) {
      console.warn(`[NexusClientDatabase: ${this.name}] Falling back to in-memory store:`, err);
      this.isOpenResolved = true;
      this.isFallbackMode = true;
      return false;
    }
  }

  /**
   * Commits a customer sale with instant zero-latency local inventory decrement.
   * Atomically records the SALE_COMMITTED event, appends to the durable outbox,
   * and decrements stock inside a single Dexie transaction.
   */
  async commitSale(
    salePayload: SalePayload,
    clock: HybridLogicalClock,
    terminalId: string
  ): Promise<{ event: SaleCommittedEvent; updatedInventory: InventoryItem[] }> {
    const eventId = `evt_sale_${generateUUID()}`;
    const idempotencyKey = `idem_${eventId}`;
    const hlc = clock.now();
    const nowIso = new Date().toISOString();

    const rawSaleEvent: SaleCommittedEvent = {
      eventId,
      type: 'SALE_COMMITTED',
      payload: salePayload,
      hlc,
      terminalId,
      version: 1,
      synced: false,
      createdAt: nowIso,
    };

    const saleEvent = (await signEvent(rawSaleEvent, terminalId)) as SaleCommittedEvent;

    const outboxRecord: OutboxRecord = {
      eventId,
      idempotencyKey,
      event: saleEvent,
      attempts: 0,
      createdAt: nowIso,
    };

    const updatedInventoryList: InventoryItem[] = [];

    try {
      if (this.isFallbackMode) throw new Error('Fallback mode active');

      await this.transaction('rw', this.events, this.inventory, this.outbox, async () => {
        await this.events.add(saleEvent);
        await this.outbox.add(outboxRecord);

        for (const item of salePayload.items) {
          const existing = await this.inventory.get(item.sku);
          if (existing) {
            const newStock = existing.stock - item.quantity;
            const updated: InventoryItem = {
              ...existing,
              stock: newStock,
              updatedAt: nowIso,
            };
            await this.inventory.put(updated);
            updatedInventoryList.push(updated);
          } else {
            const fallbackItem: InventoryItem = {
              sku: item.sku,
              name: item.name,
              price: item.price,
              stock: -item.quantity,
              reorderThreshold: 5,
              updatedAt: nowIso,
            };
            await this.inventory.put(fallbackItem);
            updatedInventoryList.push(fallbackItem);
          }
        }
      });
    } catch {
      // In-memory fallback execution
      this.fallbackEvents.push(saleEvent);
      this.fallbackOutbox.push(outboxRecord);

      for (const item of salePayload.items) {
        const existing = this.fallbackInventory.get(item.sku);
        const updated: InventoryItem = existing
          ? { ...existing, stock: existing.stock - item.quantity, updatedAt: nowIso }
          : {
              sku: item.sku,
              name: item.name,
              price: item.price,
              stock: -item.quantity,
              reorderThreshold: 5,
              updatedAt: nowIso,
            };
        this.fallbackInventory.set(item.sku, updated);
        updatedInventoryList.push(updated);
      }
    }

    return { event: saleEvent, updatedInventory: updatedInventoryList };
  }

  /**
   * Initializes or seeds an inventory SKU with an authoritative baseline event.
   */
  async initializeInventoryItem(
    payload: InventoryPayload,
    clock: HybridLogicalClock,
    terminalId: string
  ): Promise<{ event: InventoryInitializedEvent; item: InventoryItem }> {
    const eventId = `evt_init_${payload.sku}_${generateUUID()}`;
    const idempotencyKey = `idem_${eventId}`;
    const hlc = clock.now();
    const nowIso = new Date().toISOString();

    const rawEvent: InventoryInitializedEvent = {
      eventId,
      type: 'INVENTORY_INITIALIZED',
      payload,
      hlc,
      terminalId,
      version: 1,
      synced: false,
      createdAt: nowIso,
    };

    const event = (await signEvent(rawEvent, terminalId)) as InventoryInitializedEvent;

    const item: InventoryItem = {
      sku: payload.sku,
      name: payload.name,
      price: payload.price,
      stock: payload.stock,
      reorderThreshold: payload.reorderThreshold,
      category: payload.category,
      updatedAt: nowIso,
    };

    try {
      if (this.isFallbackMode) throw new Error('Fallback mode active');
      await this.transaction('rw', this.events, this.inventory, this.outbox, async () => {
        await this.events.add(event);
        await this.outbox.add({
          eventId,
          idempotencyKey,
          event,
          attempts: 0,
          createdAt: nowIso,
        });
        await this.inventory.put(item);
      });
    } catch {
      this.fallbackEvents.push(event);
      this.fallbackOutbox.push({
        eventId,
        idempotencyKey,
        event,
        attempts: 0,
        createdAt: nowIso,
      });
      this.fallbackInventory.set(item.sku, item);
    }

    return { event, item };
  }

  /**
   * Adjusts stock quantity for restock, audit corrections, or damages.
   */
  async adjustStock(
    sku: string,
    quantityDelta: number,
    reason: StockAdjustedPayload['reason'],
    clock: HybridLogicalClock,
    terminalId: string
  ): Promise<{ event: StockAdjustedEvent; item: InventoryItem }> {
    const nowIso = new Date().toISOString();
    const eventId = `evt_adj_${sku}_${generateUUID()}`;
    const idempotencyKey = `idem_${eventId}`;
    const hlc = clock.now();

    let updatedItem!: InventoryItem;
    let event!: StockAdjustedEvent;

    try {
      if (this.isFallbackMode) throw new Error('Fallback mode active');
      await this.transaction('rw', this.events, this.inventory, this.outbox, async () => {
        const existing = await this.inventory.get(sku);
        const previousStock = existing ? existing.stock : 0;
        const newStock = previousStock + quantityDelta;

        updatedItem = {
          sku,
          name: existing ? existing.name : `SKU ${sku}`,
          price: existing ? existing.price : 0,
          stock: newStock,
          reorderThreshold: existing ? existing.reorderThreshold : 5,
          category: existing?.category,
          updatedAt: nowIso,
        };

        const payload: StockAdjustedPayload = {
          sku,
          quantityDelta,
          reason,
          previousStock,
          newStock,
        };

        event = {
          eventId,
          type: 'STOCK_ADJUSTED',
          payload,
          hlc,
          terminalId,
          version: 1,
          synced: false,
          createdAt: nowIso,
        };

        await this.events.add(event);
        await this.outbox.add({
          eventId,
          idempotencyKey,
          event,
          attempts: 0,
          createdAt: nowIso,
        });
        await this.inventory.put(updatedItem);
      });
    } catch {
      const existing = this.fallbackInventory.get(sku);
      const previousStock = existing ? existing.stock : 0;
      const newStock = previousStock + quantityDelta;

      updatedItem = {
        sku,
        name: existing ? existing.name : `SKU ${sku}`,
        price: existing ? existing.price : 0,
        stock: newStock,
        reorderThreshold: existing ? existing.reorderThreshold : 5,
        category: existing?.category,
        updatedAt: nowIso,
      };

      const payload: StockAdjustedPayload = {
        sku,
        quantityDelta,
        reason,
        previousStock,
        newStock,
      };

      event = {
        eventId,
        type: 'STOCK_ADJUSTED',
        payload,
        hlc,
        terminalId,
        version: 1,
        synced: false,
        createdAt: nowIso,
      };

      this.fallbackEvents.push(event);
      this.fallbackOutbox.push({
        eventId,
        idempotencyKey,
        event,
        attempts: 0,
        createdAt: nowIso,
      });
      this.fallbackInventory.set(sku, updatedItem);
    }

    return { event, item: updatedItem };
  }

  /**
   * Applies any domain event to update the local inventory materialized view.
   */
  async applyEventToInventory(event: NexusEvent): Promise<void> {
    const nowIso = new Date().toISOString();

    try {
      if (this.isFallbackMode) throw new Error('Fallback mode active');
      switch (event.type) {
        case 'SALE_COMMITTED': {
          for (const item of event.payload.items) {
            const current = await this.inventory.get(item.sku);
            if (current) {
              await this.inventory.update(item.sku, {
                stock: current.stock - item.quantity,
                updatedAt: nowIso,
              });
            } else {
              await this.inventory.put({
                sku: item.sku,
                name: item.name,
                price: item.price,
                stock: -item.quantity,
                reorderThreshold: 5,
                updatedAt: nowIso,
              });
            }
          }
          break;
        }
        case 'INVENTORY_INITIALIZED': {
          await this.inventory.put({
            sku: event.payload.sku,
            name: event.payload.name,
            price: event.payload.price,
            stock: event.payload.stock,
            reorderThreshold: event.payload.reorderThreshold,
            category: event.payload.category,
            updatedAt: nowIso,
          });
          break;
        }
        case 'STOCK_ADJUSTED': {
          const current = await this.inventory.get(event.payload.sku);
          if (current) {
            await this.inventory.update(event.payload.sku, {
              stock: current.stock + event.payload.quantityDelta,
              updatedAt: nowIso,
            });
          }
          break;
        }
        case 'DISCREPANCY_FLAGGED': {
          const current = await this.inventory.get(event.payload.sku);
          if (current && current.stock !== event.payload.actualStock) {
            await this.inventory.update(event.payload.sku, {
              stock: event.payload.actualStock,
              updatedAt: nowIso,
            });
          }
          break;
        }
      }
    } catch {
      // In-memory fallback reducer
      switch (event.type) {
        case 'SALE_COMMITTED': {
          for (const item of event.payload.items) {
            const current = this.fallbackInventory.get(item.sku);
            if (current) {
              current.stock -= item.quantity;
              current.updatedAt = nowIso;
            } else {
              this.fallbackInventory.set(item.sku, {
                sku: item.sku,
                name: item.name,
                price: item.price,
                stock: -item.quantity,
                reorderThreshold: 5,
                updatedAt: nowIso,
              });
            }
          }
          break;
        }
        case 'INVENTORY_INITIALIZED': {
          this.fallbackInventory.set(event.payload.sku, {
            sku: event.payload.sku,
            name: event.payload.name,
            price: event.payload.price,
            stock: event.payload.stock,
            reorderThreshold: event.payload.reorderThreshold,
            category: event.payload.category,
            updatedAt: nowIso,
          });
          break;
        }
        case 'STOCK_ADJUSTED': {
          const current = this.fallbackInventory.get(event.payload.sku);
          if (current) {
            current.stock += event.payload.quantityDelta;
            current.updatedAt = nowIso;
          }
          break;
        }
        case 'DISCREPANCY_FLAGGED': {
          const current = this.fallbackInventory.get(event.payload.sku);
          if (current) {
            current.stock = event.payload.actualStock;
            current.updatedAt = nowIso;
          }
          break;
        }
      }
    }
  }

  /**
   * Safe fetch of all inventory items (supporting in-memory fallback).
   */
  async getAllInventory(): Promise<InventoryItem[]> {
    try {
      if (this.isFallbackMode) return Array.from(this.fallbackInventory.values());
      const items = await this.inventory.toArray();
      return items.length > 0 ? items : Array.from(this.fallbackInventory.values());
    } catch {
      return Array.from(this.fallbackInventory.values());
    }
  }

  /**
   * Retrieves all recorded domain events (supporting in-memory fallback).
   */
  async getAllEvents(): Promise<NexusEvent[]> {
    try {
      if (this.isFallbackMode) return [...this.fallbackEvents];
      const evts = await this.events.toArray();
      return evts.length > 0 ? evts : [...this.fallbackEvents];
    } catch {
      return [...this.fallbackEvents];
    }
  }

  async getEvents(): Promise<NexusEvent[]> {
    return this.getAllEvents();
  }

  /**
   * Retrieves pending events waiting in outbox queue.
   */
  async getPendingOutbox(): Promise<OutboxRecord[]> {
    try {
      if (this.isFallbackMode) return [...this.fallbackOutbox];
      return await this.outbox.toArray();
    } catch {
      return [...this.fallbackOutbox];
    }
  }

  /**
   * Marks events as successfully synchronized and purges from outbox queue.
   */
  async markOutboxSynced(eventIds: string[]): Promise<void> {
    try {
      if (this.isFallbackMode) throw new Error('Fallback mode active');
      await this.transaction('rw', this.events, this.outbox, async () => {
        for (const eventId of eventIds) {
          await this.events.update(eventId, { synced: true });
          const outboxMatches = await this.outbox.where('eventId').equals(eventId).toArray();
          for (const match of outboxMatches) {
            if (match.id !== undefined) {
              await this.outbox.delete(match.id);
            }
          }
        }
      });
    } catch {
      for (const eventId of eventIds) {
        const evt = this.fallbackEvents.find((e) => e.eventId === eventId);
        if (evt) (evt as { synced: boolean }).synced = true;
        this.fallbackOutbox = this.fallbackOutbox.filter((o) => o.eventId !== eventId);
      }
    }
  }

  /**
   * Records a sync failure for outbox retry telemetry.
   */
  async recordOutboxFailure(outboxId: number, errorMessage: string): Promise<void> {
    try {
      if (this.isFallbackMode) throw new Error('Fallback mode active');
      const record = await this.outbox.get(outboxId);
      if (record) {
        await this.outbox.update(outboxId, {
          attempts: record.attempts + 1,
          lastAttemptAt: new Date().toISOString(),
          lastError: errorMessage,
        });
      }
    } catch {
      const match = this.fallbackOutbox.find((o) => o.id === outboxId);
      if (match) {
        match.attempts += 1;
        match.lastAttemptAt = new Date().toISOString();
        match.lastError = errorMessage;
      }
    }
  }

  /**
   * Persists an authoritative inventory snapshot.
   */
  async saveSnapshot(snapshot: InventorySnapshot): Promise<void> {
    try {
      if (this.isFallbackMode) throw new Error('Fallback mode active');
      await this.snapshots.put(snapshot);
    } catch {
      this.fallbackSnapshots.push(snapshot);
    }
  }

  /**
   * Retrieves the most recent inventory snapshot.
   */
  async getLatestSnapshot(): Promise<InventorySnapshot | null> {
    try {
      if (this.isFallbackMode) {
        return this.fallbackSnapshots[this.fallbackSnapshots.length - 1] ?? null;
      }
      const all = await this.snapshots.toArray();
      return all.length > 0 ? all[all.length - 1] : (this.fallbackSnapshots[this.fallbackSnapshots.length - 1] ?? null);
    } catch {
      return this.fallbackSnapshots[this.fallbackSnapshots.length - 1] ?? null;
    }
  }

  /**
   * Prunes synced events from active event log to reclaim storage.
   */
  async pruneSyncedEvents(eventIdsToPrune: string[]): Promise<number> {
    let prunedCount = 0;
    try {
      if (this.isFallbackMode) throw new Error('Fallback mode active');
      await this.transaction('rw', this.events, async () => {
        for (const id of eventIdsToPrune) {
          const evt = await this.events.get(id);
          if (evt && evt.synced) {
            await this.events.delete(id);
            prunedCount++;
          }
        }
      });
    } catch {
      const idSet = new Set(eventIdsToPrune);
      const before = this.fallbackEvents.length;
      this.fallbackEvents = this.fallbackEvents.filter((e) => !(idSet.has(e.eventId) && e.synced));
      prunedCount = before - this.fallbackEvents.length;
    }
    return prunedCount;
  }

  /**
   * Purges acknowledged items from outbox.
   */
  async purgeSyncedOutbox(): Promise<number> {
    let purgedCount = 0;
    try {
      if (this.isFallbackMode) throw new Error('Fallback mode active');
      const all = await this.outbox.toArray();
      for (const item of all) {
        if (item.event?.synced && item.id !== undefined) {
          await this.outbox.delete(item.id);
          purgedCount++;
        }
      }
    } catch {
      const before = this.fallbackOutbox.length;
      this.fallbackOutbox = this.fallbackOutbox.filter((o) => !o.event?.synced);
      purgedCount = before - this.fallbackOutbox.length;
    }
    return purgedCount;
  }

  /**
   * Safely clears all data (used during reset).
   */
  async clearAllData(): Promise<void> {
    this.fallbackInventory.clear();
    this.fallbackEvents = [];
    this.fallbackOutbox = [];
    try {
      if (!this.isFallbackMode) {
        await this.inventory.clear();
        await this.events.clear();
        await this.outbox.clear();
      }
    } catch {
      // ignore
    }
  }
}

// Default singleton instance for browser runtime
let defaultDbInstance: NexusClientDatabase | null = null;

export function getClientDb(dbName?: string): NexusClientDatabase {
  if (typeof window === 'undefined') {
    return new NexusClientDatabase(dbName ?? `NexusPOS_Server_${generateUUID()}`);
  }
  if (!defaultDbInstance) {
    defaultDbInstance = new NexusClientDatabase(dbName);
  }
  return defaultDbInstance;
}
