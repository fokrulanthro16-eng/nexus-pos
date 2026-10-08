import fs from 'fs';
import path from 'path';
import { InventoryItem, DiscrepancyPayload, HLCTimestamp, SyncPushResponse } from '@/types/events';

export interface PersistedIdempotencyRecord {
  key: string;
  response: SyncPushResponse;
  processedAt: string;
}

export interface PersistedServerLedger {
  version: number;
  lastUpdated: string;
  idempotencyEntries: PersistedIdempotencyRecord[];
  inventory: InventoryItem[];
  knownEventIds: string[];
  discrepancies: DiscrepancyPayload[];
  serverHLC?: HLCTimestamp;
}

export const DEFAULT_LEDGER_FILENAME = '.nexus_ledger.json';

export function getDefaultLedgerPath(): string {
  try {
    return path.join(process.cwd(), DEFAULT_LEDGER_FILENAME);
  } catch {
    return DEFAULT_LEDGER_FILENAME;
  }
}

/**
 * Loads persisted server state from disk (.nexus_ledger.json).
 * Returns null if file does not exist, cannot be read, or parsing fails.
 */
export function loadServerLedger(filePath = getDefaultLedgerPath()): PersistedServerLedger | null {
  try {
    if (!fs.existsSync(/*turbopackIgnore: true*/ filePath)) {
      return null;
    }
    const raw = fs.readFileSync(/*turbopackIgnore: true*/ filePath, 'utf-8');
    const parsed = JSON.parse(raw) as PersistedServerLedger;
    if (parsed && Array.isArray(parsed.inventory)) {
      return parsed;
    }
    return null;
  } catch (err) {
    console.warn(`[ServerStorage] Notice: Could not read ledger from ${filePath}:`, err);
    return null;
  }
}

/**
 * Persists server state to disk (.nexus_ledger.json).
 * Uses atomic/direct file write with fallback to in-memory on error.
 */
export function saveServerLedger(ledger: PersistedServerLedger, filePath = getDefaultLedgerPath()): boolean {
  try {
    const payload = JSON.stringify(ledger, null, 2);
    fs.writeFileSync(/*turbopackIgnore: true*/ filePath, payload, 'utf-8');
    return true;
  } catch (err) {
    console.warn(`[ServerStorage] Notice: Could not write ledger to ${filePath}:`, err);
    return false;
  }
}

/**
 * Deletes or clears the persisted ledger file from disk.
 */
export function clearServerLedger(filePath = getDefaultLedgerPath()): boolean {
  try {
    if (fs.existsSync(/*turbopackIgnore: true*/ filePath)) {
      fs.unlinkSync(/*turbopackIgnore: true*/ filePath);
    }
    return true;
  } catch (err) {
    console.warn(`[ServerStorage] Notice: Could not clear ledger file ${filePath}:`, err);
    return false;
  }
}
