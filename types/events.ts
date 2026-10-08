/**
 * NexusPOS Engine — Core Event Sourcing & Distributed Synchronization Types
 * Strict immutable event definitions, HLC timestamps, and sync contracts.
 */

export interface HLCTimestamp {
  /** Physical wall clock timestamp in milliseconds */
  readonly millis: number;
  /** Monotonic logical counter for sub-millisecond causal events */
  readonly counter: number;
  /** Unique terminal / node identifier providing deterministic tie-breaking */
  readonly nodeId: string;
}

export interface CartItem {
  readonly sku: string;
  readonly name: string;
  readonly price: number;
  readonly quantity: number;
  readonly subtotal: number;
}

export type PaymentMethod = 'CASH' | 'CARD' | 'SPLIT' | 'OTHER';

export interface PaymentDetails {
  readonly amountTendered?: number;
  readonly changeDue?: number;
  readonly cardAuthCode?: string;
  readonly last4?: string;
}

export interface SalePayload {
  readonly saleId: string;
  readonly terminalId: string;
  readonly cashierId: string;
  readonly items: readonly CartItem[];
  readonly subtotal: number;
  readonly tax: number;
  readonly total: number;
  readonly paymentMethod: PaymentMethod;
  readonly paymentDetails?: PaymentDetails;
  readonly notes?: string;
}

export interface InventoryPayload {
  readonly sku: string;
  readonly name: string;
  readonly stock: number;
  readonly price: number;
  readonly reorderThreshold: number;
  readonly category?: string;
}

export interface StockAdjustedPayload {
  readonly sku: string;
  readonly quantityDelta: number;
  readonly reason: 'RESTOCK' | 'AUDIT_CORRECTION' | 'DAMAGE' | 'MANUAL_OVERRIDE';
  readonly previousStock: number;
  readonly newStock: number;
}

export interface DiscrepancyPayload {
  readonly incidentId: string;
  readonly sku: string;
  readonly saleEventId: string;
  readonly terminalId: string;
  readonly expectedStock: number;
  /** Can be negative (e.g. -1) when concurrent offline terminals sell out */
  readonly actualStock: number;
  readonly deficit: number;
  readonly reason: 'CONCURRENT_OFFLINE_SELLOUT' | 'UNRECORDED_SHRINKAGE' | string;
  readonly detectedAt: string;
  readonly resolved: boolean;
}

export type EventType =
  | 'SALE_COMMITTED'
  | 'INVENTORY_INITIALIZED'
  | 'STOCK_ADJUSTED'
  | 'DISCREPANCY_FLAGGED';

export interface BaseEvent<TType extends EventType, TPayload> {
  readonly eventId: string;
  readonly type: TType;
  readonly payload: Readonly<TPayload>;
  readonly hlc: HLCTimestamp;
  readonly terminalId: string;
  readonly version: number;
  readonly synced: boolean;
  readonly createdAt: string;
}

export type SaleCommittedEvent = BaseEvent<'SALE_COMMITTED', SalePayload>;
export type InventoryInitializedEvent = BaseEvent<'INVENTORY_INITIALIZED', InventoryPayload>;
export type StockAdjustedEvent = BaseEvent<'STOCK_ADJUSTED', StockAdjustedPayload>;
export type DiscrepancyFlaggedEvent = BaseEvent<'DISCREPANCY_FLAGGED', DiscrepancyPayload>;

/**
 * Strict immutable closed union of all NexusPOS engine domain events
 */
export type NexusEvent =
  | SaleCommittedEvent
  | InventoryInitializedEvent
  | StockAdjustedEvent
  | DiscrepancyFlaggedEvent;

// --------------------------------------------------------------------------
// Database Materialized View & Outbox Models
// --------------------------------------------------------------------------

export interface InventoryItem {
  sku: string;
  name: string;
  price: number;
  stock: number;
  reorderThreshold: number;
  category?: string;
  updatedAt: string;
}

export interface OutboxRecord {
  id?: number;
  eventId: string;
  idempotencyKey: string;
  event: NexusEvent;
  attempts: number;
  lastAttemptAt?: string;
  lastError?: string;
  createdAt: string;
}

// --------------------------------------------------------------------------
// Sync Protocol Payloads (Push / Pull)
// --------------------------------------------------------------------------

export interface SyncPushRequest {
  readonly idempotencyKey: string;
  readonly terminalId: string;
  readonly events: readonly NexusEvent[];
  readonly clientHLC: HLCTimestamp;
}

export interface SyncPushResponse {
  readonly idempotencyKey: string;
  readonly acceptedEventIds: readonly string[];
  readonly duplicateEventIds: readonly string[];
  readonly discrepancies: readonly DiscrepancyPayload[];
  readonly serverHLC: HLCTimestamp;
  readonly success: boolean;
  readonly message?: string;
}

export interface SyncPullRequest {
  readonly terminalId: string;
  readonly lastKnownHlcMillis: number;
  readonly limit?: number;
}

export interface SyncPullResponse {
  readonly events: readonly NexusEvent[];
  readonly serverHLC: HLCTimestamp;
  readonly hasMore: boolean;
}
