import { describe, it, expect, vi } from 'vitest';
import { BackgroundSyncWorker } from '../lib/sync/background-worker';
import { NexusClientDatabase } from '../lib/db/client-db';
import { HybridLogicalClock } from '../lib/hlc';
import { hardwarePrinterBridge } from '../lib/hardware/webusb-bridge';
import { NexusCentralReconciler } from '../lib/sync/reconciler';
import { SyncPushRequest, SalePayload } from '../types/events';

describe('Level 2: Background Sync Worker with Exponential Backoff & Jitter', () => {
  it('calculates exponential backoff delay correctly with jitter bounds', () => {
    const db = new NexusClientDatabase('TestSyncDb_Backoff');
    const clock = new HybridLogicalClock('TERM_TEST');
    const worker = new BackgroundSyncWorker(db, clock, 'TERM_TEST', {
      pushHandler: async () => ({
        idempotencyKey: 'key',
        acceptedEventIds: [],
        duplicateEventIds: [],
        discrepancies: [],
        serverHLC: { millis: 1000, counter: 0, nodeId: 'SERVER' },
        success: true,
      }),
      minBackoffMs: 500,
      maxBackoffMs: 8000,
      jitterRatio: 0.2,
    });

    // Attempt 0: base 500ms ± 20% (400ms - 600ms, but clamped to >= minBackoff 500ms)
    const delay0 = worker.calculateBackoff(0);
    expect(delay0).toBeGreaterThanOrEqual(400);
    expect(delay0).toBeLessThanOrEqual(650);

    // Attempt 1: 500 * 2^1 = 1000ms ± 20% (800ms - 1200ms)
    const delay1 = worker.calculateBackoff(1);
    expect(delay1).toBeGreaterThanOrEqual(750);
    expect(delay1).toBeLessThanOrEqual(1250);

    // Attempt 2: 500 * 2^2 = 2000ms ± 20% (1600ms - 2400ms)
    const delay2 = worker.calculateBackoff(2);
    expect(delay2).toBeGreaterThanOrEqual(1550);
    expect(delay2).toBeLessThanOrEqual(2450);

    // Attempt 5: 500 * 2^5 = 16000ms, capped at maxBackoff 8000ms ± 20% (6400ms - 9600ms)
    const delay5 = worker.calculateBackoff(5);
    expect(delay5).toBeLessThanOrEqual(10000);

    worker.stop();
    db.close();
  });

  it('flushes pending outbox events and transitions to SYNCED upon server confirmation', async () => {
    const dbName = `TestSyncDb_Flush_${Date.now()}`;
    const db = new NexusClientDatabase(dbName);
    const clock = new HybridLogicalClock('TERM_TEST_SYNC');

    await db.initClientDb();

    // Commit a local sale to populate the outbox
    const salePayload: SalePayload = {
      saleId: 'sale_sync_01',
      terminalId: 'TERM_TEST_SYNC',
      cashierId: 'cashier_test',
      items: [{ sku: 'ITEM_1', name: 'Item One', price: 10, quantity: 1, subtotal: 10 }],
      subtotal: 10,
      tax: 0,
      total: 10,
      paymentMethod: 'CASH',
    };
    await db.commitSale(salePayload, clock, 'TERM_TEST_SYNC');

    const pendingBefore = await db.getPendingOutbox();
    expect(pendingBefore.length).toBe(1);

    const mockPushHandler = vi.fn(async (req: SyncPushRequest) => {
      return {
        idempotencyKey: req.idempotencyKey,
        acceptedEventIds: req.events.map((e) => e.eventId),
        duplicateEventIds: [],
        discrepancies: [],
        serverHLC: { millis: 2000, counter: 5, nodeId: 'SERVER' },
        success: true,
      };
    });

    const worker = new BackgroundSyncWorker(db, clock, 'TERM_TEST_SYNC', {
      pushHandler: mockPushHandler,
      minBackoffMs: 200,
    });

    worker.start();
    const result = await worker.flush();

    expect(result).not.toBeNull();
    expect(result?.success).toBe(true);
    expect(mockPushHandler).toHaveBeenCalledTimes(1);

    // Outbox should now be emptied
    const pendingAfter = await db.getPendingOutbox();
    expect(pendingAfter.length).toBe(0);

    worker.stop();
    db.close();
  });
});

describe('Level 2: WebUSB & WebSerial Hardware Bridge Fallback', () => {
  it('seamlessly falls back to virtual emulator when no physical printer is connected', async () => {
    // In node/test environment, no physical USB device is connected
    const testBytes = new Uint8Array([0x1b, 0x40, 0x48, 0x45, 0x4c, 0x4c, 0x4f, 0x0a, 0x1d, 0x56, 0x01]);

    const result = await hardwarePrinterBridge.printRaw(testBytes);

    expect(result.success).toBe(true);
    expect(result.physicalPrinted).toBe(false);
    expect(result.connectionType).toBe('NONE');
    expect(result.bytesWritten).toBe(testBytes.length);
    expect(result.message).toContain('Virtual Canvas Emulator');
  });

  it('correctly provides vendor filters and status structure', () => {
    const status = hardwarePrinterBridge.getStatus();
    expect(status.connected).toBe(false);
    expect(status.fallbackActive).toBe(true);
    expect(status.type).toBe('NONE');
  });
});

describe('Level 2: Server-Side Idempotency Store', () => {
  it('prevents double balance deductions on repeated sync attempts with the same idempotencyKey', () => {
    const reconciler = new NexusCentralReconciler('SERVER_TEST_IDEM', [
      {
        sku: 'TEST_SKU_1',
        name: 'Test Product',
        price: 50,
        stock: 5,
        reorderThreshold: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const clock = new HybridLogicalClock('TERM_CLIENT');
    const saleEvent = {
      eventId: 'evt_sale_unique_99',
      type: 'SALE_COMMITTED' as const,
      payload: {
        saleId: 's_99',
        terminalId: 'TERM_CLIENT',
        cashierId: 'c1',
        items: [{ sku: 'TEST_SKU_1', name: 'Test Product', price: 50, quantity: 2, subtotal: 100 }],
        subtotal: 100,
        tax: 0,
        total: 100,
        paymentMethod: 'CASH' as const,
      },
      hlc: clock.now(),
      terminalId: 'TERM_CLIENT',
      version: 1,
      synced: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    const request: SyncPushRequest = {
      idempotencyKey: 'idem_key_9999',
      terminalId: 'TERM_CLIENT',
      events: [saleEvent],
      clientHLC: clock.peek(),
    };

    // First attempt
    const res1 = reconciler.handleSyncPush(request);
    expect(res1.acceptedEventIds).toContain('evt_sale_unique_99');
    expect(reconciler.getInventory('TEST_SKU_1')?.stock).toBe(3); // 5 - 2 = 3

    // Repeated attempt (simulating network retry storm with identical event)
    const res2 = reconciler.handleSyncPush(request);
    expect(res2.duplicateEventIds).toContain('evt_sale_unique_99');
    expect(res2.acceptedEventIds).not.toContain('evt_sale_unique_99');
    // Stock MUST remain 3 and not decrement again to 1!
    expect(reconciler.getInventory('TEST_SKU_1')?.stock).toBe(3);
  });
});
