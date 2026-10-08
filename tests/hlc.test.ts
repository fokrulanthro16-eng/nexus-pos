import { describe, it, expect } from 'vitest';
import { HybridLogicalClock } from '@/lib/hlc';

describe('Hybrid Logical Clock (HLC)', () => {
  it('generates monotonically increasing timestamps on the same node', () => {
    let mockTime = 1000;
    const clock = new HybridLogicalClock('term_A', {
      getPhysicalTime: () => mockTime,
    });

    const t1 = clock.now();
    expect(t1.millis).toBe(1000);
    expect(t1.counter).toBe(0);
    expect(t1.nodeId).toBe('term_A');

    // Same physical millisecond -> counter increments
    const t2 = clock.now();
    expect(t2.millis).toBe(1000);
    expect(t2.counter).toBe(1);

    // Wall clock moves forward -> counter resets to 0
    mockTime = 1050;
    const t3 = clock.now();
    expect(t3.millis).toBe(1050);
    expect(t3.counter).toBe(0);

    expect(HybridLogicalClock.compare(t1, t2)).toBe(-1);
    expect(HybridLogicalClock.compare(t2, t3)).toBe(-1);
  });

  it('advances causally when updating with remote timestamp ahead in logical time', () => {
    let mockTime = 1000;
    const clockA = new HybridLogicalClock('term_A', {
      getPhysicalTime: () => mockTime,
    });

    // Remote clock is ahead at 1500ms
    const remoteTimestamp = {
      millis: 1500,
      counter: 4,
      nodeId: 'term_B',
    };

    const updated = clockA.update(remoteTimestamp);
    expect(updated.millis).toBe(1500);
    expect(updated.counter).toBe(5);
    expect(updated.nodeId).toBe('term_A');

    // Next local event must be causally after remoteTimestamp
    const nextLocal = clockA.now();
    expect(HybridLogicalClock.compare(remoteTimestamp, nextLocal)).toBe(-1);
  });

  it('statically deterministically compares timestamps', () => {
    const a = { millis: 1000, counter: 0, nodeId: 'term_A' };
    const b = { millis: 1000, counter: 1, nodeId: 'term_A' };
    const c = { millis: 1000, counter: 1, nodeId: 'term_B' };
    const d = { millis: 1001, counter: 0, nodeId: 'term_A' };

    expect(HybridLogicalClock.compare(a, b)).toBe(-1);
    expect(HybridLogicalClock.compare(b, a)).toBe(1);
    expect(HybridLogicalClock.compare(b, c)).toBe(-1);
    expect(HybridLogicalClock.compare(c, b)).toBe(1);
    expect(HybridLogicalClock.compare(c, d)).toBe(-1);
    expect(HybridLogicalClock.compare(a, a)).toBe(0);
  });

  it('correctly serializes and parses HLC string representation', () => {
    const ts = { millis: 1728400000000, counter: 42, nodeId: 'term_pos_01' };
    const str = HybridLogicalClock.toString(ts);
    const parsed = HybridLogicalClock.fromString(str);

    expect(parsed.millis).toBe(ts.millis);
    expect(parsed.counter).toBe(ts.counter);
    expect(parsed.nodeId).toBe(ts.nodeId);
    expect(HybridLogicalClock.compare(ts, parsed)).toBe(0);
  });
});
