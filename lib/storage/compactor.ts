/**
 * Enterprise Event Sourcing Snapshotting & Storage Compactor
 * Prevents long-term IndexedDB event log bloat by creating periodic authoritative
 * snapshots of materialized inventory views and pruning acknowledged event history.
 */

import { NexusClientDatabase } from '@/lib/db/client-db';
import { HybridLogicalClock } from '@/lib/hlc';
import { InventorySnapshot, InventoryItem } from '@/types/events';

export interface CompactionReport {
  readonly compacted: boolean;
  readonly snapshot: InventorySnapshot | null;
  readonly prunedSyncedEventsCount: number;
  readonly purgedOutboxRecordsCount: number;
  readonly totalEventsBefore: number;
  readonly totalEventsAfter: number;
  readonly reason: string;
}

export class EventLogCompactor {
  private readonly threshold: number;

  /**
   * @param threshold Number of synced events required to trigger compaction (default: 20)
   */
  constructor(threshold = 20) {
    this.threshold = threshold;
  }

  /**
   * Inspects client database state and compacts if synced events threshold is reached.
   */
  public async checkAndCompact(
    db: NexusClientDatabase,
    clock: HybridLogicalClock,
    terminalId: string,
    force = false
  ): Promise<CompactionReport> {
    const allEvents = await db.getAllEvents();
    const syncedEvents = allEvents.filter((e) => e.synced);
    const totalEventsBefore = allEvents.length;

    if (!force && syncedEvents.length < this.threshold) {
      return {
        compacted: false,
        snapshot: null,
        prunedSyncedEventsCount: 0,
        purgedOutboxRecordsCount: 0,
        totalEventsBefore,
        totalEventsAfter: totalEventsBefore,
        reason: `Compaction threshold not met (${syncedEvents.length}/${this.threshold} synced events).`,
      };
    }

    // 1. Capture current materialized inventory view for snapshot
    const currentInventory: InventoryItem[] = await db.getAllInventory();

    const lastSyncedEvent = syncedEvents[syncedEvents.length - 1];
    const lastEventId = lastSyncedEvent ? lastSyncedEvent.eventId : 'initial_horizon';

    const snapshot: InventorySnapshot = {
      snapshotId: `snap_${terminalId}_${Date.now()}`,
      terminalId,
      hlc: clock.peek(),
      inventory: currentInventory.map((i) => ({ ...i })),
      eventsCoveredCount: syncedEvents.length,
      lastEventId,
      createdAt: new Date().toISOString(),
    };

    // 2. Persist snapshot
    await db.saveSnapshot(snapshot);

    // 3. Prune old synced events (except un-synced events which must remain in outbox)
    const eventIdsToPrune = syncedEvents.map((e) => e.eventId);
    const prunedCount = await db.pruneSyncedEvents(eventIdsToPrune);

    // 4. Purge successfully acknowledged entries from outbox queue
    const purgedOutboxCount = await db.purgeSyncedOutbox();

    const remainingEvents = await db.getAllEvents();

    return {
      compacted: true,
      snapshot,
      prunedSyncedEventsCount: prunedCount,
      purgedOutboxRecordsCount: purgedOutboxCount,
      totalEventsBefore,
      totalEventsAfter: remainingEvents.length,
      reason: `Compacted ${prunedCount} synced events into snapshot ${snapshot.snapshotId}. Storage pruned.`,
    };
  }
}

export const defaultCompactor = new EventLogCompactor(20);
