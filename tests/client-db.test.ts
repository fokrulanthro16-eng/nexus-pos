import { describe, it, expect } from 'vitest';
import { NexusClientDatabase } from '@/lib/db/client-db';

describe('NexusClientDatabase Schema & Contract', () => {
  it('initializes with correct Dexie table schemas and indices', () => {
    const db = new NexusClientDatabase('NexusTestDB');

    // Verify tables are defined
    expect(db.events).toBeDefined();
    expect(db.inventory).toBeDefined();
    expect(db.outbox).toBeDefined();

    // Verify table names
    const tableNames = db.tables.map((t) => t.name);
    expect(tableNames).toContain('events');
    expect(tableNames).toContain('inventory');
    expect(tableNames).toContain('outbox');

    // Verify primary keys and schema definitions
    const eventsTable = db.table('events');
    expect(eventsTable.schema.primKey.name).toBe('eventId');

    const inventoryTable = db.table('inventory');
    expect(inventoryTable.schema.primKey.name).toBe('sku');

    const outboxTable = db.table('outbox');
    expect(outboxTable.schema.primKey.name).toBe('id');
    expect(outboxTable.schema.primKey.auto).toBe(true);

    db.close();
  });
});
