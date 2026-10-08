import { describe, it, expect } from 'vitest';
import { NexusCentralReconciler } from '@/lib/sync/reconciler';
import {
  SaleCommittedEvent,
  InventoryInitializedEvent,
  NexusEvent,
  SyncPushRequest,
} from '@/types/events';
import { HybridLogicalClock } from '@/lib/hlc';

describe('NexusPOS Central Reconciliation Engine', () => {
  it('enforces idempotency guard by filtering duplicate events', () => {
    const reconciler = new NexusCentralReconciler('CENTRAL_HUB');
    const clock = new HybridLogicalClock('TERM_1');

    const initEvent: InventoryInitializedEvent = {
      eventId: 'evt_init_001',
      type: 'INVENTORY_INITIALIZED',
      payload: {
        sku: 'LAPTOP_X',
        name: 'NexusBook Pro',
        price: 1200,
        stock: 10,
        reorderThreshold: 2,
      },
      hlc: clock.now(),
      terminalId: 'TERM_1',
      version: 1,
      synced: false,
      createdAt: new Date().toISOString(),
    };

    // First reconciliation
    const result1 = reconciler.reconcileBatch([initEvent]);
    expect(result1.acceptedEventIds).toContain('evt_init_001');
    expect(result1.duplicateEventIds).toHaveLength(0);
    expect(reconciler.getInventory('LAPTOP_X')?.stock).toBe(10);

    // Second reconciliation with identical event ID
    const result2 = reconciler.reconcileBatch([initEvent]);
    expect(result2.acceptedEventIds).toHaveLength(0);
    expect(result2.duplicateEventIds).toContain('evt_init_001');
    // Stock must not be double applied
    expect(reconciler.getInventory('LAPTOP_X')?.stock).toBe(10);
  });

  it('orders incoming events causally using HLC timestamps', () => {
    const reconciler = new NexusCentralReconciler('CENTRAL_HUB');

    // Create events with out-of-order arrival
    const eventEarlier: InventoryInitializedEvent = {
      eventId: 'evt_001',
      type: 'INVENTORY_INITIALIZED',
      payload: { sku: 'MOUSE_01', name: 'Optical Mouse', price: 20, stock: 5, reorderThreshold: 1 },
      hlc: { millis: 1000, counter: 0, nodeId: 'TERM_A' },
      terminalId: 'TERM_A',
      version: 1,
      synced: false,
      createdAt: new Date().toISOString(),
    };

    const eventLater: SaleCommittedEvent = {
      eventId: 'evt_002',
      type: 'SALE_COMMITTED',
      payload: {
        saleId: 'sale_1',
        terminalId: 'TERM_B',
        cashierId: 'c1',
        items: [{ sku: 'MOUSE_01', name: 'Optical Mouse', price: 20, quantity: 2, subtotal: 40 }],
        subtotal: 40,
        tax: 0,
        total: 40,
        paymentMethod: 'CARD',
      },
      hlc: { millis: 1000, counter: 1, nodeId: 'TERM_B' },
      terminalId: 'TERM_B',
      version: 1,
      synced: false,
      createdAt: new Date().toISOString(),
    };

    // Arrive in reverse order [eventLater, eventEarlier]
    const result = reconciler.reconcileBatch([eventLater, eventEarlier]);

    expect(result.acceptedEventIds).toEqual(['evt_001', 'evt_002']);
    // Mouse stock: initialized to 5, then sold 2 = 3 remaining
    expect(reconciler.getInventory('MOUSE_01')?.stock).toBe(3);
  });

  it('never rejects confirmed sales and flags DISCREPANCY_FLAGGED when concurrent offline sales cause negative stock', () => {
    const reconciler = new NexusCentralReconciler('CENTRAL_HUB', [
      {
        sku: 'HEADPHONE_01',
        name: 'Nexus Wireless Headphones',
        price: 99.0,
        stock: 1, // Only 1 physical unit in store!
        reorderThreshold: 1,
        updatedAt: new Date().toISOString(),
      },
    ]);

    const clockA = new HybridLogicalClock('TERM_OFFLINE_A', { getPhysicalTime: () => 2000 });
    const clockB = new HybridLogicalClock('TERM_OFFLINE_B', { getPhysicalTime: () => 2005 });

    // Both terminals are offline during network outage. Both sell the last remaining unit!
    const saleA: SaleCommittedEvent = {
      eventId: 'sale_evt_terminal_A',
      type: 'SALE_COMMITTED',
      payload: {
        saleId: 's_01',
        terminalId: 'TERM_OFFLINE_A',
        cashierId: 'cashier_1',
        items: [{ sku: 'HEADPHONE_01', name: 'Nexus Wireless Headphones', price: 99, quantity: 1, subtotal: 99 }],
        subtotal: 99,
        tax: 0,
        total: 99,
        paymentMethod: 'CASH',
      },
      hlc: clockA.now(),
      terminalId: 'TERM_OFFLINE_A',
      version: 1,
      synced: false,
      createdAt: new Date().toISOString(),
    };

    const saleB: SaleCommittedEvent = {
      eventId: 'sale_evt_terminal_B',
      type: 'SALE_COMMITTED',
      payload: {
        saleId: 's_02',
        terminalId: 'TERM_OFFLINE_B',
        cashierId: 'cashier_2',
        items: [{ sku: 'HEADPHONE_01', name: 'Nexus Wireless Headphones', price: 99, quantity: 1, subtotal: 99 }],
        subtotal: 99,
        tax: 0,
        total: 99,
        paymentMethod: 'CARD',
      },
      hlc: clockB.now(),
      terminalId: 'TERM_OFFLINE_B',
      version: 1,
      synced: false,
      createdAt: new Date().toISOString(),
    };

    // Terminal A reconnects and syncs
    const pushA: SyncPushRequest = {
      idempotencyKey: 'sync_req_A',
      terminalId: 'TERM_OFFLINE_A',
      events: [saleA],
      clientHLC: clockA.peek(),
    };
    const resA = reconciler.handleSyncPush(pushA);
    expect(resA.success).toBe(true);
    expect(resA.acceptedEventIds).toContain('sale_evt_terminal_A');
    expect(resA.discrepancies).toHaveLength(0);
    expect(reconciler.getInventory('HEADPHONE_01')?.stock).toBe(0);

    // Terminal B reconnects and syncs
    const pushB: SyncPushRequest = {
      idempotencyKey: 'sync_req_B',
      terminalId: 'TERM_OFFLINE_B',
      events: [saleB],
      clientHLC: clockB.peek(),
    };
    const resB = reconciler.handleSyncPush(pushB);

    // CRITICAL: Sale is NEVER rejected!
    expect(resB.success).toBe(true);
    expect(resB.acceptedEventIds).toContain('sale_evt_terminal_B');

    // Stock has decremented to negative -1
    const inventoryItem = reconciler.getInventory('HEADPHONE_01');
    expect(inventoryItem?.stock).toBe(-1);

    // Incident flagged for audit and inventory restock
    expect(resB.discrepancies).toHaveLength(1);
    const discrepancy = resB.discrepancies[0];
    expect(discrepancy.sku).toBe('HEADPHONE_01');
    expect(discrepancy.reason).toBe('CONCURRENT_OFFLINE_SELLOUT');
    expect(discrepancy.actualStock).toBe(-1);
    expect(discrepancy.deficit).toBe(1);
    expect(discrepancy.saleEventId).toBe('sale_evt_terminal_B');
    expect(discrepancy.terminalId).toBe('TERM_OFFLINE_B');
  });
});
