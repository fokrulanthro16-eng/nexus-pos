import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { BackgroundSyncWorker } from '../lib/sync/background-worker';
import { NexusClientDatabase } from '../lib/db/client-db';
import { HybridLogicalClock } from '../lib/hlc';
import { NexusCentralReconciler } from '../lib/sync/reconciler';
import { hardwarePrinterBridge } from '../lib/hardware/webusb-bridge';
import { EscPosDecoder, generateEscPosReceipt } from '../lib/hardware/escpos';
import {
  saveServerLedger,
  loadServerLedger,
  clearServerLedger,
  PersistedServerLedger,
} from '../lib/sync/server-storage';
import { SalePayload, SyncPushRequest } from '../types/events';

describe('Edge-Case Fortification Suite', () => {
  const TEST_LEDGER_PATH = path.join(process.cwd(), '.test_edge_ledger.json');

  beforeEach(() => {
    clearServerLedger(TEST_LEDGER_PATH);
  });

  afterEach(() => {
    clearServerLedger(TEST_LEDGER_PATH);
  });

  describe('1. Persistent Storage Adapter (.nexus_ledger.json)', () => {
    it('persists and restores authoritative inventory, idempotency keys, and discrepancies across simulated reboot', () => {
      // 1. Initial server instance with authoritative stock
      const initialReconciler = new NexusCentralReconciler('SERVER_CLOUD_01', [
        {
          sku: 'LIMITED_EDITION_MUG',
          name: 'Limited Ceramic Mug',
          price: 18.0,
          stock: 1,
          reorderThreshold: 1,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);

      const clientClock = new HybridLogicalClock('TERM_EDGE');
      const saleEvent = {
        eventId: 'evt_edge_sale_01',
        type: 'SALE_COMMITTED' as const,
        payload: {
          saleId: 'sale_edge_1',
          terminalId: 'TERM_EDGE',
          cashierId: 'cashier_1',
          items: [{ sku: 'LIMITED_EDITION_MUG', name: 'Limited Ceramic Mug', price: 18.0, quantity: 1, subtotal: 18.0 }],
          subtotal: 18.0,
          tax: 0,
          total: 18.0,
          paymentMethod: 'CASH' as const,
        },
        hlc: clientClock.now(),
        terminalId: 'TERM_EDGE',
        version: 1,
        synced: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      };

      const syncReq: SyncPushRequest = {
        idempotencyKey: 'idem_edge_unique_key_01',
        terminalId: 'TERM_EDGE',
        events: [saleEvent],
        clientHLC: clientClock.peek(),
      };

      // Handle sync push and decrement stock 1 -> 0
      const response = initialReconciler.handleSyncPush(syncReq);
      expect(response.acceptedEventIds).toContain('evt_edge_sale_01');
      expect(initialReconciler.getInventory('LIMITED_EDITION_MUG')?.stock).toBe(0);

      // 2. Persist state to disk
      const exported = initialReconciler.exportState();
      const ledgerToSave: PersistedServerLedger = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        idempotencyEntries: [
          {
            key: syncReq.idempotencyKey,
            response,
            processedAt: new Date().toISOString(),
          },
        ],
        inventory: exported.inventory,
        knownEventIds: exported.knownEventIds,
        discrepancies: exported.discrepancyAuditLog,
        serverHLC: exported.serverClock,
      };

      const saveOk = saveServerLedger(ledgerToSave, TEST_LEDGER_PATH);
      expect(saveOk).toBe(true);
      expect(fs.existsSync(TEST_LEDGER_PATH)).toBe(true);

      // 3. Simulate Complete Server Reboot (Instantiate clean new reconciler and restore from file)
      const restoredLedger = loadServerLedger(TEST_LEDGER_PATH);
      expect(restoredLedger).not.toBeNull();
      expect(restoredLedger?.idempotencyEntries.length).toBe(1);
      expect(restoredLedger?.idempotencyEntries[0].key).toBe('idem_edge_unique_key_01');

      const rebootedReconciler = new NexusCentralReconciler('SERVER_CLOUD_01', []);
      rebootedReconciler.restoreState({
        knownEventIds: restoredLedger!.knownEventIds,
        inventory: restoredLedger!.inventory,
        discrepancyAuditLog: restoredLedger!.discrepancies,
        serverClock: restoredLedger!.serverHLC,
      });

      // Verify stock survived reboot as 0 (not reset to baseline 1)
      expect(rebootedReconciler.getInventory('LIMITED_EDITION_MUG')?.stock).toBe(0);

      // 4. Repeated retry storm after reboot with identical idempotencyKey
      // Re-running sync with same event ID should be recognized as duplicate
      const retryResponse = rebootedReconciler.handleSyncPush(syncReq);
      expect(retryResponse.duplicateEventIds).toContain('evt_edge_sale_01');
      expect(retryResponse.acceptedEventIds).not.toContain('evt_edge_sale_01');
      expect(rebootedReconciler.getInventory('LIMITED_EDITION_MUG')?.stock).toBe(0);
    });
  });

  describe('2. Fine-Grained Batch Ack & Retry Ledger', () => {
    it('purges only acceptedEventIds from outbox, leaves unacknowledged events queued, and retries with backoff', async () => {
      const dbName = `TestDb_Edge_PartialAck_${Date.now()}`;
      const db = new NexusClientDatabase(dbName);
      const clock = new HybridLogicalClock('TERM_PARTIAL');

      await db.initClientDb();

      // Commit 3 distinct sales locally
      const makeSale = (id: string, sku: string): SalePayload => ({
        saleId: `sale_${id}`,
        terminalId: 'TERM_PARTIAL',
        cashierId: 'cashier_p',
        items: [{ sku, name: `Product ${sku}`, price: 10, quantity: 1, subtotal: 10 }],
        subtotal: 10,
        tax: 0,
        total: 10,
        paymentMethod: 'CASH',
      });

      const { event: evt1 } = await db.commitSale(makeSale('1', 'SKU_1'), clock, 'TERM_PARTIAL');
      const { event: evt2 } = await db.commitSale(makeSale('2', 'SKU_2'), clock, 'TERM_PARTIAL');
      const { event: evt3 } = await db.commitSale(makeSale('3', 'SKU_3'), clock, 'TERM_PARTIAL');

      const pendingInitial = await db.getPendingOutbox();
      expect(pendingInitial.length).toBe(3);

      // Mock push handler that simulates partial acceptance (accepts only evt1 and evt2, drops evt3)
      let attemptCount = 0;
      const mockPushHandler = vi.fn(async (req: SyncPushRequest) => {
        attemptCount++;
        if (attemptCount === 1) {
          return {
            idempotencyKey: req.idempotencyKey,
            acceptedEventIds: [evt1.eventId, evt2.eventId], // Only 2 accepted!
            duplicateEventIds: [],
            discrepancies: [],
            serverHLC: { millis: 3000, counter: 1, nodeId: 'SERVER' },
            success: true,
          };
        } else {
          // On second attempt, accept remaining event (evt3)
          return {
            idempotencyKey: req.idempotencyKey,
            acceptedEventIds: [evt3.eventId],
            duplicateEventIds: [],
            discrepancies: [],
            serverHLC: { millis: 3000, counter: 2, nodeId: 'SERVER' },
            success: true,
          };
        }
      });

      const worker = new BackgroundSyncWorker(db, clock, 'TERM_PARTIAL', {
        pushHandler: mockPushHandler,
        minBackoffMs: 200,
        maxRetries: 3,
      });

      worker.start();

      // First flush: partial batch acknowledgment
      const firstResult = await worker.flush();
      expect(firstResult).not.toBeNull();
      expect(firstResult?.acceptedEventIds).toHaveLength(2);

      // Verify fine-grained outbox state: exactly 1 unacknowledged event (evt3) remains queued
      const remainingAfterFirst = await db.getPendingOutbox();
      expect(remainingAfterFirst.length).toBe(1);
      expect(remainingAfterFirst[0].eventId).toBe(evt3.eventId);

      // Verify worker registered partial ack retry attempt
      const workerState = worker.getState();
      expect(workerState.retryAttempt).toBe(1);
      expect(workerState.lastError).toContain('Partial batch ack: 2/3 accepted');

      // Second flush: retry resolves the remaining unacknowledged event
      const secondResult = await worker.flush();
      expect(secondResult).not.toBeNull();
      expect(secondResult?.acceptedEventIds).toContain(evt3.eventId);

      // Outbox must now be fully cleared
      const remainingFinal = await db.getPendingOutbox();
      expect(remainingFinal.length).toBe(0);
      expect(worker.getState().retryAttempt).toBe(0);
      expect(worker.getState().lastError).toBeNull();

      worker.stop();
      db.close();
    });
  });

  describe('3. Hardware Fault Simulator & Idempotent Non-Fiscal Reprint', () => {
    it('executes ESC/POS byte sequence reprint idempotently with zero financial ledger mutation', async () => {
      const db = new NexusClientDatabase(`TestDb_Reprint_${Date.now()}`);
      const clock = new HybridLogicalClock('TERM_REPRINT');
      await db.initClientDb();

      // Commit one sale
      const salePayload: SalePayload = {
        saleId: 'sale_reprint_test_99',
        terminalId: 'TERM_REPRINT',
        cashierId: 'cashier_rep',
        items: [{ sku: 'COLD_BREW_01', name: 'Cold Brew 16oz', price: 4.5, quantity: 2, subtotal: 9.0 }],
        subtotal: 9.0,
        tax: 0.74,
        total: 9.74,
        paymentMethod: 'CARD',
      };

      await db.commitSale(salePayload, clock, 'TERM_REPRINT');

      // Check baseline financial state
      const initialEvents = await db.getEvents();
      expect(initialEvents.length).toBe(1);
      const initialInventory = await db.getAllInventory();
      const initialStock = initialInventory.find((i) => i.sku === 'COLD_BREW_01')?.stock;

      // Generate ESC/POS byte stream for this sale
      const receiptBytes = generateEscPosReceipt(salePayload, {
        storeName: 'NEXUS COFFEE LAB',
        storeAddress: '123 TECH BOULEVARD',
      });

      // Verify binary ESC/POS formatting
      expect(receiptBytes.length).toBeGreaterThan(50);
      const decodedOriginal = EscPosDecoder.decode(receiptBytes);
      expect(decodedOriginal.hasCut).toBe(true);
      expect(decodedOriginal.rawText.toUpperCase()).toContain('COLD BREW 16OZ');

      // Perform 3 consecutive simulated reprints (e.g. after customer paper tear or jam recovery)
      for (let i = 1; i <= 3; i++) {
        const reprintDispatch = await hardwarePrinterBridge.printRaw(receiptBytes);
        expect(reprintDispatch.success).toBe(true);
        expect(reprintDispatch.bytesWritten).toBe(receiptBytes.length);

        // Crucial Enterprise Invariant:
        // No new financial events must be written to DB, and inventory stock must not decrement
        const eventsAfterReprint = await db.getEvents();
        expect(eventsAfterReprint.length).toBe(1); // STILL 1!

        const inventoryAfterReprint = await db.getAllInventory();
        const stockAfterReprint = inventoryAfterReprint.find((it) => it.sku === 'COLD_BREW_01')?.stock;
        expect(stockAfterReprint).toBe(initialStock);
      }

      db.close();
    });

    it('decodes ESC/POS commands accurately and flags hardware opcodes', () => {
      const samplePayload: SalePayload = {
        saleId: 's_quick',
        terminalId: 'T1',
        cashierId: 'c1',
        items: [{ sku: 'A', name: 'Croissant', price: 3.75, quantity: 1, subtotal: 3.75 }],
        subtotal: 3.75,
        tax: 0.31,
        total: 4.06,
        paymentMethod: 'CASH',
      };

      const bytes = generateEscPosReceipt(samplePayload, {
        storeName: 'BAKERY',
        storeAddress: 'AVENUE',
      });

      const decoded = EscPosDecoder.decode(bytes);
      expect(decoded.hasCut).toBe(true);
      expect(decoded.lines.length).toBeGreaterThan(5);

      // Verify cut opcode is present at end
      expect(bytes[bytes.length - 3]).toBe(0x1d); // GS
      expect(bytes[bytes.length - 2]).toBe(0x56); // V
      expect(bytes[bytes.length - 1]).toBe(0x01); // Cut mode
    });
  });
});
