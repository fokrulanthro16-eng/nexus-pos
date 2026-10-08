import { describe, it, expect } from 'vitest';
import {
  EscPosEncoder,
  EscPosDecoder,
  generateEscPosReceipt,
} from '@/lib/hardware/escpos';
import { SalePayload } from '@/types/events';

describe('ESC/POS Command Encoder & Byte Decoder', () => {
  it('encodes init, align, bold, text, and paper cut into raw bytes', () => {
    const encoder = new EscPosEncoder();
    encoder
      .init()
      .align('center')
      .bold(true)
      .line('CAFE NEXUS')
      .bold(false)
      .align('left')
      .line('Order #1234')
      .cut(true);

    const binary = encoder.compile();
    expect(binary).toBeInstanceOf(Uint8Array);
    expect(binary.length).toBeGreaterThan(0);

    // Verify raw command byte signatures
    // Init: 0x1B, 0x40
    expect(binary[0]).toBe(0x1b);
    expect(binary[1]).toBe(0x40);

    // Paper Cut (Partial): 0x1D, 0x56, 0x01 appears at end
    const lastThree = Array.from(binary.slice(-3));
    expect(lastThree).toEqual([0x1d, 0x56, 0x01]);
  });

  it('decodes raw ESC/POS binary back into human-readable receipt lines for UI emulation', () => {
    const encoder = new EscPosEncoder();
    encoder
      .init()
      .align('center')
      .bold(true)
      .line('NEXUS SUPERMARKET')
      .bold(false)
      .align('left')
      .line('Item 1: Espresso   $3.50')
      .feed(1)
      .cut(true);

    const binary = encoder.compile();
    const decoded = EscPosDecoder.decode(binary);

    expect(decoded.hasCut).toBe(true);
    expect(decoded.lines.length).toBeGreaterThanOrEqual(2);

    const titleLine = decoded.lines.find((l) => l.text.includes('NEXUS SUPERMARKET'));
    expect(titleLine).toBeDefined();
    expect(titleLine?.align).toBe('center');
    expect(titleLine?.bold).toBe(true);

    const itemLine = decoded.lines.find((l) => l.text.includes('Item 1: Espresso'));
    expect(itemLine).toBeDefined();
    expect(itemLine?.align).toBe('left');
    expect(itemLine?.bold).toBe(false);
  });

  it('generates complete thermal receipt from SalePayload', () => {
    const sale: SalePayload = {
      saleId: 'sale_998877',
      terminalId: 'POS_TERM_01',
      cashierId: 'cashier_alice',
      items: [
        { sku: 'COFFEE_01', name: 'Cold Brew Coffee', price: 4.5, quantity: 2, subtotal: 9.0 },
        { sku: 'BAKERY_02', name: 'Almond Croissant', price: 3.75, quantity: 1, subtotal: 3.75 },
      ],
      subtotal: 12.75,
      tax: 1.02,
      total: 13.77,
      paymentMethod: 'CASH',
      paymentDetails: {
        amountTendered: 20.0,
        changeDue: 6.23,
      },
    };

    const receiptBytes = generateEscPosReceipt(sale, { storeName: 'NEXUS COFFEE SHOP' });
    const decoded = EscPosDecoder.decode(receiptBytes);

    expect(decoded.hasCut).toBe(true);
    expect(decoded.rawText).toContain('NEXUS COFFEE SHOP');
    expect(decoded.rawText).toContain('COLD BREW COFFEE');
    expect(decoded.rawText).toContain('$13.77');
    expect(decoded.rawText).toContain('CASH TENDERED:');
    expect(decoded.rawText).toContain('CHANGE DUE:');
  });
});
