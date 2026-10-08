import { NextRequest, NextResponse } from 'next/server';
import { NexusCentralReconciler } from '@/lib/sync/reconciler';
import { SyncPushRequest, SyncPushResponse } from '@/types/events';

// In-memory idempotency transaction ledger across API requests
const idempotencyLedger = new Map<string, { response: SyncPushResponse; processedAt: string }>();

// Authoritative central reconciler instance for cloud gateway
const serverReconciler = new NexusCentralReconciler('SERVER_CLOUD_AUTHORITY', [
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
]);

/**
 * POST /api/sync
 * Enterprise Idempotent Sync Push Gateway
 *
 * Guarantees:
 * - Immediate deduplication via idempotencyKey.
 * - Prevents double deduction of inventory on repeated network retries.
 * - Returns cached response with HTTP 200 and X-Cache-Lookup: HIT.
 */
export async function POST(req: NextRequest) {
  try {
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
          },
        }
      );
    }

    // 2. Authoritative Reconciler Execution
    const response = serverReconciler.handleSyncPush(body);

    // 3. Commit to server transaction ledger
    idempotencyLedger.set(idempotencyKey, {
      response,
      processedAt: new Date().toISOString(),
    });

    return NextResponse.json(response, {
      status: 200,
      headers: {
        'X-Cache-Lookup': 'MISS',
        'X-Idempotency-Key': idempotencyKey,
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
 * Inspect gateway health, authoritative stock matrix, and idempotency ledger metrics
 */
export async function GET() {
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
    },
    inventory,
    discrepancies,
  });
}
