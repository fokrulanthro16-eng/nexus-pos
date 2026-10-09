import { NextRequest, NextResponse } from 'next/server';
import { NexusCentralReconciler } from '@/lib/sync/reconciler';
import { SyncPushRequest, SyncPushResponse, InventoryItem } from '@/types/events';
import { verifyEventSignature } from '@/lib/crypto/signer';
import {
  loadServerLedger,
  saveServerLedger,
  getDefaultLedgerPath,
  PersistedServerLedger,
} from '@/lib/sync/server-storage';

const DEFAULT_CATALOG: InventoryItem[] = [
  {
    sku: 'COLD_BREW_01',
    name: 'Cold Brew 16oz',
    price: 4.5,
    stock: 12,
    reorderThreshold: 2,
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    sku: 'CROISSANT_02',
    name: 'Artisan Croissant',
    price: 3.75,
    stock: 8,
    reorderThreshold: 2,
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    sku: 'ORGANIC_OAT_03',
    name: 'Organic Oat Milk Latte',
    price: 5.25,
    stock: 10,
    reorderThreshold: 2,
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    sku: 'LIMITED_EDITION_MUG',
    name: 'Limited Ceramic Mug',
    price: 18.0,
    stock: 1, // Only 1 physical unit in central inventory for race condition testing
    reorderThreshold: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

// Persistent file-backed store with in-memory fast cache
export const idempotencyLedger = new Map<string, { response: SyncPushResponse; processedAt: string }>();
export const serverReconciler = new NexusCentralReconciler('SERVER_CLOUD_AUTHORITY', DEFAULT_CATALOG);

let isLedgerInitialized = false;

/**
 * Loads persisted ledger state from disk (.nexus_ledger.json).
 * Preserves authoritative inventory counters and processed idempotency keys across server reboots.
 */
export function syncLedgerFromDisk(customPath?: string): void {
  const persisted = loadServerLedger(customPath);
  if (persisted) {
    serverReconciler.restoreState({
      knownEventIds: persisted.knownEventIds,
      inventory: persisted.inventory,
      discrepancyAuditLog: persisted.discrepancies,
      serverClock: persisted.serverHLC,
    });
    idempotencyLedger.clear();
    for (const entry of persisted.idempotencyEntries) {
      idempotencyLedger.set(entry.key, {
        response: entry.response,
        processedAt: entry.processedAt,
      });
    }
  } else {
    // Initial bootstrap: persist baseline catalog to disk
    syncLedgerToDisk(customPath);
  }
  isLedgerInitialized = true;
}

/**
 * Commits current authoritative inventory and idempotency transactions to disk.
 */
export function syncLedgerToDisk(customPath?: string): boolean {
  const state = serverReconciler.exportState();
  const payload: PersistedServerLedger = {
    version: 1,
    lastUpdated: new Date().toISOString(),
    idempotencyEntries: Array.from(idempotencyLedger.entries()).map(([key, val]) => ({
      key,
      response: val.response,
      processedAt: val.processedAt,
    })),
    inventory: state.inventory,
    knownEventIds: state.knownEventIds,
    discrepancies: state.discrepancyAuditLog,
    serverHLC: state.serverClock,
  };
  return saveServerLedger(payload, customPath);
}

// Initial bootstrap load from disk
try {
  syncLedgerFromDisk();
} catch (e) {
  console.warn('[API /api/sync] Ledger initialization notice:', e);
}

/**
 * POST /api/sync
 * Enterprise Idempotent Sync Push Gateway with Persistent Storage
 *
 * Guarantees:
 * - Immediate deduplication via idempotencyKey.
 * - Prevents double deduction of inventory on repeated network retries.
 * - Preserves transactions & inventory across server restarts or container reboots.
 * - Returns cached response with HTTP 200 and X-Cache-Lookup: HIT.
 */
export async function POST(req: NextRequest) {
  try {
    if (!isLedgerInitialized) {
      syncLedgerFromDisk();
    }

    const body = (await req.json()) as SyncPushRequest;
    const idempotencyKey = body.idempotencyKey || req.headers.get('x-idempotency-key') || '';

    if (!idempotencyKey) {
      return NextResponse.json(
        { success: false, error: 'Missing required idempotencyKey in request body or X-Idempotency-Key header' },
        { status: 400 }
      );
    }

    // 1. Idempotency Guard: return cached result without duplicate execution
    if (idempotencyLedger.has(idempotencyKey)) {
      const cached = idempotencyLedger.get(idempotencyKey)!;
      return NextResponse.json(
        {
          ...cached.response,
          cached: true,
          message: `Cached idempotent response returned (Originally processed at ${cached.processedAt})`,
        },
        {
          status: 200,
          headers: {
            'X-Cache-Lookup': 'HIT',
            'X-Idempotency-Key': idempotencyKey,
            'X-Storage-Backend': 'FILE_PERSISTED',
          },
        }
      );
    }

    // 2. Cryptographic Non-Repudiation Guard: Verify event signatures
    if (body.events && body.events.length > 0) {
      for (const event of body.events) {
        const hasSignature = Boolean(
          event.signature || (event.payload as Record<string, unknown>)?.signature
        );
        if (hasSignature) {
          const isValid = await verifyEventSignature(event);
          if (!isValid) {
            return NextResponse.json(
              {
                success: false,
                error: 'TAMPERED_EVENT',
                message: `Cryptographic signature verification failed for event ${event.eventId}. The payload has been tampered with or signature is invalid.`,
                tamperedEventId: event.eventId,
              },
              { status: 403 }
            );
          }
        }
      }
    }

    // 3. Authoritative Reconciler Execution
    const response = serverReconciler.handleSyncPush(body);

    // 4. Commit to server transaction ledger
    idempotencyLedger.set(idempotencyKey, {
      response,
      processedAt: new Date().toISOString(),
    });

    // 4. Persist updated authoritative state to disk (.nexus_ledger.json)
    syncLedgerToDisk();

    return NextResponse.json(response, {
      status: 200,
      headers: {
        'X-Cache-Lookup': 'MISS',
        'X-Idempotency-Key': idempotencyKey,
        'X-Storage-Backend': 'FILE_PERSISTED',
      },
    });
  } catch (err: unknown) {
    console.error('[API /api/sync] Exception in sync handler:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Internal Server Error' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/sync
 * Inspect gateway health, authoritative stock matrix, persistent storage metrics, and idempotency ledger
 */
export async function GET() {
  if (!isLedgerInitialized) {
    syncLedgerFromDisk();
  }

  const inventory = Array.from(serverReconciler.getAllInventory().values());
  const discrepancies = serverReconciler.getDiscrepancies();

  return NextResponse.json({
    service: 'NexusPOS Central Reconciler Sync Gateway',
    status: 'HEALTHY',
    serverHLC: serverReconciler.getServerClock().peek(),
    metrics: {
      cachedIdempotencyKeys: idempotencyLedger.size,
      totalInventorySkus: inventory.length,
      discrepanciesFlagged: discrepancies.length,
      storageEngine: 'FILE_BACKED_JSON',
      storageFile: getDefaultLedgerPath(),
    },
    inventory,
    discrepancies,
  });
}
