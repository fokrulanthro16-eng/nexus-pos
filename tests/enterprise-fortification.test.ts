import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  signEvent,
  verifyEventSignature,
  getOrGenerateTerminalKeyPair,
  getCanonicalEventBytes,
} from '../lib/crypto/signer';
import {
  evaluateOversellPolicy,
  isOversellAllowed,
  SKU_OVERSELL_POLICIES,
  STRICT_OVERSELL_REJECTION_MESSAGE,
} from '../lib/policy/oversell-rules';
import { EventLogCompactor } from '../lib/storage/compactor';
import { NexusClientDatabase } from '../lib/db/client-db';
import { HybridLogicalClock } from '../lib/hlc';
import { POST } from '../app/api/sync/route';
import { SalePayload, NexusEvent, SyncPushRequest } from '../types/events';

describe('Enterprise Level-3 Fortification Suite', () => {
  describe('1. WebCrypto Asymmetric Signatures for Non-Repudiation', () => {
    it('generates cryptographic keypair and signs events with deterministic canonical serialization', async () => {
      const clock = new HybridLogicalClock('TERM_CRYPTO_ALPHA');
      const baseEvent: NexusEvent = {
        eventId: 'evt_crypto_001',
        type: 'SALE_COMMITTED',
        payload: {
          saleId: 'sale_sec_01',
          terminalId: 'TERM_CRYPTO_ALPHA',
          cashierId: 'cashier_alice',
          items: [{ sku: 'COLD_BREW_01', name: 'Cold Brew 16oz', price: 4.5, quantity: 2, subtotal: 9.0 }],
          subtotal: 9.0,
          tax: 0.74,
          total: 9.74,
          paymentMethod: 'CASH',
        },
        hlc: clock.now(),
        terminalId: 'TERM_CRYPTO_ALPHA',
        version: 1,
        synced: false,
        createdAt: new Date().toISOString(),
      };

      const signedEvent = await signEvent(baseEvent, 'TERM_CRYPTO_ALPHA');

      expect(signedEvent.signature).toBeDefined();
      expect(typeof signedEvent.signature).toBe('string');
      expect(signedEvent.signature!.length).toBeGreaterThan(16);
      expect(signedEvent.publicKey).toBeDefined();
      expect(typeof signedEvent.publicKey).toBe('string');

      // Canonical bytes should be stable
      const bytes1 = getCanonicalEventBytes(signedEvent);
      const bytes2 = getCanonicalEventBytes(signedEvent);
      expect(Buffer.from(bytes1).toString('hex')).toBe(Buffer.from(bytes2).toString('hex'));
    });

    it('verifies untampered signed events successfully and rejects tampered payloads', async () => {
      const clock = new HybridLogicalClock('TERM_CRYPTO_BETA');
      const validEvent: NexusEvent = {
        eventId: 'evt_crypto_002',
        type: 'SALE_COMMITTED',
        payload: {
          saleId: 'sale_sec_02',
          terminalId: 'TERM_CRYPTO_BETA',
          cashierId: 'cashier_bob',
          items: [{ sku: 'LIMITED_EDITION_MUG', name: 'Limited Ceramic Mug', price: 18.0, quantity: 1, subtotal: 18.0 }],
          subtotal: 18.0,
          tax: 1.48,
          total: 19.48,
          paymentMethod: 'CARD',
        },
        hlc: clock.now(),
        terminalId: 'TERM_CRYPTO_BETA',
        version: 1,
        synced: false,
        createdAt: new Date().toISOString(),
      };

      const signedEvent = await signEvent(validEvent, 'TERM_CRYPTO_BETA');

      // 1. Untampered event must pass verification
      const isValid = await verifyEventSignature(signedEvent);
      expect(isValid).toBe(true);

      // 2. Tampered payload (e.g. quantity silently altered to 5, total changed to 90.0)
      const tamperedEvent: NexusEvent = {
        ...signedEvent,
        payload: {
          ...(signedEvent.payload as any),
          total: 90.0,
          items: [{ sku: 'LIMITED_EDITION_MUG', name: 'Limited Ceramic Mug', price: 18.0, quantity: 5, subtotal: 90.0 }],
        },
      };

      const isTamperedValid = await verifyEventSignature(tamperedEvent);
      expect(isTamperedValid).toBe(false);

      // 3. Signature forgery with corrupted signature bytes
      const corruptedSigEvent: NexusEvent = {
        ...signedEvent,
        signature: 'deadbeef' + signedEvent.signature!.slice(8),
      };
      const isCorruptedSigValid = await verifyEventSignature(corruptedSigEvent);
      expect(isCorruptedSigValid).toBe(false);
    });

    it('POST /api/sync rejects tampered events with HTTP 403 TAMPERED_EVENT', async () => {
      const clock = new HybridLogicalClock('TERM_GATEWAY_TEST');
      const rawEvent: NexusEvent = {
        eventId: `evt_tamper_guard_${Date.now()}`,
        type: 'SALE_COMMITTED',
        payload: {
          saleId: 'sale_tamper_01',
          terminalId: 'TERM_GATEWAY_TEST',
          cashierId: 'cashier_malicious',
          items: [{ sku: 'COLD_BREW_01', name: 'Cold Brew 16oz', price: 4.5, quantity: 1, subtotal: 4.5 }],
          subtotal: 4.5,
          tax: 0,
          total: 4.5,
          paymentMethod: 'CASH',
        },
        hlc: clock.now(),
        terminalId: 'TERM_GATEWAY_TEST',
        version: 1,
        synced: false,
        createdAt: new Date().toISOString(),
      };

      const signed = await signEvent(rawEvent, 'TERM_GATEWAY_TEST');

      // Tamper with the event payload
      const tampered: NexusEvent = {
        ...signed,
        payload: {
          ...(signed.payload as any),
          total: 999.99, // tampered amount
        },
      };

      const syncReq: SyncPushRequest = {
        idempotencyKey: `idem_tamper_test_${Date.now()}`,
        terminalId: 'TERM_GATEWAY_TEST',
        events: [tampered],
        clientHLC: clock.peek(),
      };

      const request = new NextRequest('http://localhost:3000/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(syncReq),
      });

      const response = await POST(request);
      expect(response.status).toBe(403);

      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error).toBe('TAMPERED_EVENT');
      expect(json.tamperedEventId).toBe(rawEvent.eventId);
    });
  });

  describe('2. Business Policy Engine: SKU Oversell Guard', () => {
    it('allows offline oversell for consumable products when stock is zero or negative', () => {
      expect(isOversellAllowed('COLD_BREW_01')).toBe(true);
      expect(isOversellAllowed('CROISSANT_02')).toBe(true);
      expect(isOversellAllowed('ORGANIC_OAT_03')).toBe(true);

      // Stock is zero: consumable still allowed to sell offline
      const evalZero = evaluateOversellPolicy('COLD_BREW_01', 0, 1);
      expect(evalZero.allowed).toBe(true);
      expect(evalZero.policy.allowOfflineOversell).toBe(true);

      // Stock is negative (-3 deficit): still allowed to record sale
      const evalDeficit = evaluateOversellPolicy('CROISSANT_02', -3, 2);
      expect(evalDeficit.allowed).toBe(true);
    });

    it('strictly forbids offline oversell for limited merchandise when stock is zero or insufficient', () => {
      expect(isOversellAllowed('LIMITED_EDITION_MUG')).toBe(false);

      // 1. Stock available (1 in stock, requesting 1) -> Allowed
      const evalAvailable = evaluateOversellPolicy('LIMITED_EDITION_MUG', 1, 1);
      expect(evalAvailable.allowed).toBe(true);

      // 2. Stock exhausted (0 in stock, requesting 1) -> Blocked with strict message
      const evalSoldOut = evaluateOversellPolicy('LIMITED_EDITION_MUG', 0, 1);
      expect(evalSoldOut.allowed).toBe(false);
      expect(evalSoldOut.reason).toBe(STRICT_OVERSELL_REJECTION_MESSAGE);

      // 3. Stock negative (-1 deficit, requesting 1) -> Blocked
      const evalDeficit = evaluateOversellPolicy('LIMITED_EDITION_MUG', -1, 1);
      expect(evalDeficit.allowed).toBe(false);
      expect(evalDeficit.reason).toBe(STRICT_OVERSELL_REJECTION_MESSAGE);

      // 4. Stock insufficient (1 in stock, requesting 2 units) -> Blocked
      const evalInsufficient = evaluateOversellPolicy('LIMITED_EDITION_MUG', 1, 2);
      expect(evalInsufficient.allowed).toBe(false);
      expect(evalInsufficient.reason).toBe(STRICT_OVERSELL_REJECTION_MESSAGE);
    });
  });

  describe('3. Event Sourcing Snapshotting & Storage Compactor', () => {
    it('snapshots materialized inventory, saves to db, and prunes acknowledged events', async () => {
      const dbName = `TestDb_Compactor_${Date.now()}`;
      const db = new NexusClientDatabase(dbName);
      const clock = new HybridLogicalClock('TERM_COMPACT');

      await db.initClientDb();

      // Seed inventory
      await db.initializeInventoryItem(
        { sku: 'COLD_BREW_01', name: 'Cold Brew 16oz', price: 4.5, stock: 20, reorderThreshold: 2 },
        clock,
        'TERM_COMPACT'
      );

      // Generate 22 sales (exceeding standard 20-event threshold)
      for (let i = 1; i <= 22; i++) {
        const sale: SalePayload = {
          saleId: `sale_c_${i}`,
          terminalId: 'TERM_COMPACT',
          cashierId: 'cashier_c',
          items: [{ sku: 'COLD_BREW_01', name: 'Cold Brew 16oz', price: 4.5, quantity: 1, subtotal: 4.5 }],
          subtotal: 4.5,
          tax: 0,
          total: 4.5,
          paymentMethod: 'CASH',
        };
        await db.commitSale(sale, clock, 'TERM_COMPACT');
      }

      const allEventsBefore = await db.getAllEvents();
      expect(allEventsBefore.length).toBeGreaterThanOrEqual(22);

      // All events are initially unsynced
      const compactor = new EventLogCompactor(20);
      const reportUnsynced = await compactor.checkAndCompact(db, clock, 'TERM_COMPACT');
      // Should not compact because 0 events are synced yet
      expect(reportUnsynced.compacted).toBe(false);

      // Mark first 20 events as synced
      const eventIdsToSync = allEventsBefore.slice(0, 20).map((e) => e.eventId);
      await db.markOutboxSynced(eventIdsToSync);

      // Now run compactor - threshold (20) is met
      const reportCompacted = await compactor.checkAndCompact(db, clock, 'TERM_COMPACT');
      expect(reportCompacted.compacted).toBe(true);
      expect(reportCompacted.snapshot).not.toBeNull();
      expect(reportCompacted.prunedSyncedEventsCount).toBe(20);
      expect(reportCompacted.snapshot?.terminalId).toBe('TERM_COMPACT');

      // Verify snapshot was stored in database
      const latestSnapshot = await db.getLatestSnapshot();
      expect(latestSnapshot).not.toBeNull();
      expect(latestSnapshot?.snapshotId).toBe(reportCompacted.snapshot?.snapshotId);

      // Verify un-synced events remain intact
      const remainingEvents = await db.getAllEvents();
      expect(remainingEvents.length).toBe(allEventsBefore.length - 20);
      for (const rem of remainingEvents) {
        expect(eventIdsToSync).not.toContain(rem.eventId);
      }
    });
  });
});
