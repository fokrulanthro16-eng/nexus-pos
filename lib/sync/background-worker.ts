import { NexusClientDatabase } from '@/lib/db/client-db';
import { HybridLogicalClock } from '@/lib/hlc';
import { SyncPushRequest, SyncPushResponse } from '@/types/events';

export interface SyncWorkerState {
  isOnline: boolean;
  isSyncing: boolean;
  pendingOutboxCount: number;
  lastSyncAt: string | null;
  lastError: string | null;
  retryAttempt: number;
}

export type SyncPushHandler = (request: SyncPushRequest) => Promise<SyncPushResponse>;

export interface BackgroundWorkerOptions {
  pushHandler: SyncPushHandler;
  baseIntervalMs?: number; // Periodic polling interval when online
  minBackoffMs?: number;   // Initial retry backoff (e.g., 500ms)
  maxBackoffMs?: number;   // Ceiling for exponential backoff (e.g., 10000ms)
  jitterRatio?: number;    // Random jitter factor (0.0 to 1.0)
  maxRetries?: number;
}

/**
 * Production-Hardened Background Sync Worker with Exponential Backoff & Jitter
 *
 * Guarantees:
 * 1. Event-driven network listener: triggers instant synchronization on network restoration.
 * 2. Exponential backoff with randomized jitter (500ms, 1000ms, 2000ms...) to prevent retry storms.
 * 3. Strict transactional commitment: terminal updates outbox only upon authoritative server ACK.
 */
export class BackgroundSyncWorker {
  private readonly db: NexusClientDatabase;
  private readonly clock: HybridLogicalClock;
  private readonly terminalId: string;
  private readonly options: Required<BackgroundWorkerOptions>;

  private isRunning = false;
  private isSyncing = false;
  private isOnline = true;
  private timerId: NodeJS.Timeout | null = null;
  private backoffTimerId: NodeJS.Timeout | null = null;

  private retryAttempt = 0;
  private lastSyncAt: string | null = null;
  private lastError: string | null = null;

  private listeners: Set<(state: SyncWorkerState) => void> = new Set();

  constructor(
    db: NexusClientDatabase,
    clock: HybridLogicalClock,
    terminalId: string,
    options: BackgroundWorkerOptions
  ) {
    this.db = db;
    this.clock = clock;
    this.terminalId = terminalId;

    this.options = {
      pushHandler: options.pushHandler,
      baseIntervalMs: options.baseIntervalMs ?? 5000,
      minBackoffMs: options.minBackoffMs ?? 500,
      maxBackoffMs: options.maxBackoffMs ?? 10000,
      jitterRatio: options.jitterRatio ?? 0.25,
      maxRetries: options.maxRetries ?? 5,
    };

    if (typeof window !== 'undefined') {
      this.isOnline = navigator.onLine;
    }
  }

  /**
   * Starts the sync daemon and binds network change listeners.
   */
  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline);
      window.addEventListener('offline', this.handleOffline);
      this.isOnline = navigator.onLine;
    }

    // Initial check
    this.scheduleNextTick(100);
  }

  /**
   * Stops the daemon and cleans up timers and listeners.
   */
  public stop(): void {
    this.isRunning = false;

    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    if (this.backoffTimerId) {
      clearTimeout(this.backoffTimerId);
      this.backoffTimerId = null;
    }

    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline);
      window.removeEventListener('offline', this.handleOffline);
    }
  }

  private handleOnline = (): void => {
    this.isOnline = true;
    this.retryAttempt = 0;
    this.notifyState();
    // Flush outbox immediately upon connection recovery
    this.flush();
  };

  private handleOffline = (): void => {
    this.isOnline = false;
    this.notifyState();
  };

  /**
   * Computes next backoff delay with exponential scaling and randomized jitter:
   * delay = min(maxBackoff, minBackoff * 2^attempt) + jitter
   */
  public calculateBackoff(attempt: number): number {
    const exponential = this.options.minBackoffMs * Math.pow(2, attempt);
    const capped = Math.min(this.options.maxBackoffMs, exponential);
    const jitter = capped * this.options.jitterRatio * (Math.random() * 2 - 1);
    return Math.max(this.options.minBackoffMs, Math.round(capped + jitter));
  }

  /**
   * Flushes pending events from outbox with exponential backoff handling.
   */
  public async flush(): Promise<SyncPushResponse | null> {
    if (!this.isRunning || this.isSyncing) return null;
    if (!this.isOnline) return null;

    this.isSyncing = true;
    this.notifyState();

    try {
      const pending = await this.db.getPendingOutbox();
      if (pending.length === 0) {
        this.retryAttempt = 0;
        this.lastError = null;
        this.isSyncing = false;
        this.notifyState();
        return null;
      }

      const request: SyncPushRequest = {
        idempotencyKey: `sync_${this.terminalId}_${Date.now()}_batch_${pending.length}`,
        terminalId: this.terminalId,
        events: pending.map((p) => p.event),
        clientHLC: this.clock.peek(),
      };

      // Dispatch to authoritative handler / server endpoint
      const response = await this.options.pushHandler(request);

      if (response && response.success) {
        // Authoritative confirmation: advance causal clock & mark outbox as synced
        this.clock.update(response.serverHLC);
        await this.db.markOutboxSynced(response.acceptedEventIds as string[]);

        this.retryAttempt = 0;
        this.lastError = null;
        this.lastSyncAt = new Date().toISOString();
        this.isSyncing = false;
        this.notifyState();

        return response;
      } else {
        throw new Error(response?.message ?? 'Sync server rejected synchronization payload');
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.lastError = errorMsg;
      this.retryAttempt += 1;

      // Update failed attempt telemetry on outbox records
      try {
        const pending = await this.db.getPendingOutbox();
        for (const item of pending) {
          if (item.id !== undefined) {
            await this.db.recordOutboxFailure(item.id, errorMsg);
          }
        }
      } catch {
        // ignore telemetry update error
      }

      this.isSyncing = false;
      this.notifyState();

      // Schedule retry with exponential backoff if not exceeded maxRetries
      if (this.retryAttempt <= this.options.maxRetries) {
        const delay = this.calculateBackoff(this.retryAttempt - 1);
        this.backoffTimerId = setTimeout(() => {
          this.flush();
        }, delay);
      }

      return null;
    } finally {
      this.isSyncing = false;
      this.notifyState();
      this.scheduleNextTick(this.options.baseIntervalMs);
    }
  }

  private scheduleNextTick(delayMs: number): void {
    if (!this.isRunning) return;
    if (this.timerId) clearTimeout(this.timerId);

    this.timerId = setTimeout(() => {
      this.flush();
    }, delayMs);
  }

  public subscribe(listener: (state: SyncWorkerState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  public getState(): SyncWorkerState {
    return {
      isOnline: this.isOnline,
      isSyncing: this.isSyncing,
      pendingOutboxCount: 0, // dynamic
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      retryAttempt: this.retryAttempt,
    };
  }

  private async notifyState(): Promise<void> {
    const pending = await this.db.getPendingOutbox().catch(() => []);
    const state: SyncWorkerState = {
      isOnline: this.isOnline,
      isSyncing: this.isSyncing,
      pendingOutboxCount: pending.length,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      retryAttempt: this.retryAttempt,
    };
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  public setOnlineStatus(online: boolean): void {
    this.isOnline = online;
    if (online) {
      this.retryAttempt = 0;
      this.flush();
    }
    this.notifyState();
  }
}
