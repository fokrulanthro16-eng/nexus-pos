import { HLCTimestamp } from '@/types/events';

/**
 * Production-Grade Hybrid Logical Clock (HLC)
 *
 * Implements the Kulkarni et al. Hybrid Logical Clock algorithm.
 * Guarantees monotonic ordering, bounded drift from physical wall-clock time,
 * causal consistency across distributed terminals, and deterministic total ordering.
 */
export class HybridLogicalClock {
  private latest: HLCTimestamp;
  private readonly nodeId: string;
  private readonly getPhysicalTime: () => number;
  private readonly maxDriftMillis: number;

  constructor(
    nodeId: string,
    options: {
      getPhysicalTime?: () => number;
      maxDriftMillis?: number;
      initialTimestamp?: HLCTimestamp;
    } = {}
  ) {
    if (!nodeId || nodeId.trim() === '') {
      throw new Error('HLC: nodeId cannot be empty.');
    }

    this.nodeId = nodeId;
    this.getPhysicalTime = options.getPhysicalTime ?? (() => Date.now());
    this.maxDriftMillis = options.maxDriftMillis ?? 60_000; // 60s default max skew guard
    this.latest = options.initialTimestamp
      ? { ...options.initialTimestamp }
      : {
          millis: 0,
          counter: 0,
          nodeId: this.nodeId,
        };
  }

  /**
   * Generates the next local HLC timestamp for a new domain event.
   */
  public now(): HLCTimestamp {
    const pt = this.getPhysicalTime();
    const lOld = this.latest.millis;

    if (pt > lOld) {
      this.latest = {
        millis: pt,
        counter: 0,
        nodeId: this.nodeId,
      };
    } else {
      this.latest = {
        millis: lOld,
        counter: this.latest.counter + 1,
        nodeId: this.nodeId,
      };
    }

    return { ...this.latest };
  }

  /**
   * Updates local clock upon receiving a remote HLC timestamp (e.g. sync push/pull).
   * Ensures local clock advances beyond the remote causality horizon.
   */
  public update(remoteHLC: HLCTimestamp): HLCTimestamp {
    if (!remoteHLC || typeof remoteHLC.millis !== 'number' || typeof remoteHLC.counter !== 'number') {
      throw new Error('HLC: Invalid remote timestamp provided to update().');
    }

    const pt = this.getPhysicalTime();
    const lOld = this.latest.millis;
    const lRemote = remoteHLC.millis;

    // Check clock drift against physical clock
    if (lRemote - pt > this.maxDriftMillis) {
      console.warn(
        `[HLC] Remote timestamp exceeds max drift threshold: remote=${lRemote}, localPt=${pt}, drift=${lRemote - pt}ms`
      );
    }

    const maxMillis = Math.max(lOld, lRemote, pt);

    let nextCounter: number;
    if (maxMillis === lOld && maxMillis === lRemote) {
      nextCounter = Math.max(this.latest.counter, remoteHLC.counter) + 1;
    } else if (maxMillis === lOld) {
      nextCounter = this.latest.counter + 1;
    } else if (maxMillis === lRemote) {
      nextCounter = remoteHLC.counter + 1;
    } else {
      nextCounter = 0;
    }

    this.latest = {
      millis: maxMillis,
      counter: nextCounter,
      nodeId: this.nodeId,
    };

    return { ...this.latest };
  }

  /**
   * Deterministic total comparator for any two HLC timestamps.
   * Returns:
   *  -1 if a < b
   *   1 if a > b
   *   0 if a == b
   */
  public static compare(a: HLCTimestamp, b: HLCTimestamp): number {
    if (a.millis !== b.millis) {
      return a.millis < b.millis ? -1 : 1;
    }
    if (a.counter !== b.counter) {
      return a.counter < b.counter ? -1 : 1;
    }
    if (a.nodeId !== b.nodeId) {
      return a.nodeId < b.nodeId ? -1 : 1;
    }
    return 0;
  }

  /**
   * Formats an HLC timestamp into a deterministic sortable canonical string.
   * Format: <hexMillis>-<hexCounter>-<nodeId>
   */
  public static toString(hlc: HLCTimestamp): string {
    const hexMillis = hlc.millis.toString(16).padStart(12, '0');
    const hexCounter = hlc.counter.toString(16).padStart(6, '0');
    return `${hexMillis}-${hexCounter}-${hlc.nodeId}`;
  }

  /**
   * Parses a canonical HLC string representation back to an HLCTimestamp object.
   */
  public static fromString(str: string): HLCTimestamp {
    const parts = str.split('-');
    if (parts.length < 3) {
      throw new Error(`HLC: Malformed timestamp string "${str}"`);
    }
    const millis = parseInt(parts[0], 16);
    const counter = parseInt(parts[1], 16);
    const nodeId = parts.slice(2).join('-');
    return { millis, counter, nodeId };
  }

  /**
   * Current snapshot of the clock without advancing counter.
   */
  public peek(): HLCTimestamp {
    return { ...this.latest };
  }

  public getNodeId(): string {
    return this.nodeId;
  }
}
