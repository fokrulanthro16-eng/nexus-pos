import { SalePayload } from '@/types/events';

/**
 * Standard ESC/POS Command Byte Constants
 */
export const ESCPOS_COMMANDS = {
  // Initialize printer
  INIT: new Uint8Array([0x1b, 0x40]),
  // Text alignment
  ALIGN_LEFT: new Uint8Array([0x1b, 0x61, 0x00]),
  ALIGN_CENTER: new Uint8Array([0x1b, 0x61, 0x01]),
  ALIGN_RIGHT: new Uint8Array([0x1b, 0x61, 0x02]),
  // Emphasize (Bold)
  BOLD_ON: new Uint8Array([0x1b, 0x45, 0x01]),
  BOLD_OFF: new Uint8Array([0x1b, 0x45, 0x00]),
  // Paper Cut (GS V 0x01: Partial cut)
  PAPER_CUT_PARTIAL: new Uint8Array([0x1d, 0x56, 0x01]),
  // Paper Cut (GS V 0x00: Full cut)
  PAPER_CUT_FULL: new Uint8Array([0x1d, 0x56, 0x00]),
  // Line Feed
  LF: new Uint8Array([0x0a]),
} as const;

export type ReceiptAlignment = 'left' | 'center' | 'right';

export interface DecodedReceiptLine {
  text: string;
  align: ReceiptAlignment;
  bold: boolean;
}

export interface DecodedReceipt {
  lines: DecodedReceiptLine[];
  hasCut: boolean;
  rawText: string;
}

/**
 * Fluent builder to encode raw binary ESC/POS streams for 58mm / 80mm thermal printers.
 */
export class EscPosEncoder {
  private chunks: Uint8Array[] = [];
  private encoder: TextEncoder = new TextEncoder();

  constructor() {
    this.init();
  }

  /**
   * ESC @ : Initialize printer
   */
  public init(): this {
    this.chunks.push(ESCPOS_COMMANDS.INIT);
    return this;
  }

  /**
   * ESC a n : Select justification (0: Left, 1: Center, 2: Right)
   */
  public align(alignment: ReceiptAlignment): this {
    switch (alignment) {
      case 'center':
        this.chunks.push(ESCPOS_COMMANDS.ALIGN_CENTER);
        break;
      case 'right':
        this.chunks.push(ESCPOS_COMMANDS.ALIGN_RIGHT);
        break;
      case 'left':
      default:
        this.chunks.push(ESCPOS_COMMANDS.ALIGN_LEFT);
        break;
    }
    return this;
  }

  /**
   * ESC E n : Turn emphasized (bold) mode on/off
   */
  public bold(enable: boolean = true): this {
    this.chunks.push(enable ? ESCPOS_COMMANDS.BOLD_ON : ESCPOS_COMMANDS.BOLD_OFF);
    return this;
  }

  /**
   * Writes raw text string (UTF-8 encoded)
   */
  public text(str: string): this {
    this.chunks.push(this.encoder.encode(str));
    return this;
  }

  /**
   * Writes text followed by a Line Feed (0x0A)
   */
  public line(str: string = ''): this {
    if (str.length > 0) {
      this.chunks.push(this.encoder.encode(str));
    }
    this.chunks.push(ESCPOS_COMMANDS.LF);
    return this;
  }

  /**
   * Emits multiple empty lines
   */
  public feed(count: number = 1): this {
    for (let i = 0; i < count; i++) {
      this.chunks.push(ESCPOS_COMMANDS.LF);
    }
    return this;
  }

  /**
   * Writes a full-width dashed line separator (e.g. 32 chars for 58mm, 42 chars for 80mm)
   */
  public rule(char: string = '-', width: number = 32): this {
    this.line(char.repeat(width));
    return this;
  }

  /**
   * Formats a two-column line with left-aligned label and right-aligned value
   */
  public twoColumn(left: string, right: string, width: number = 32): this {
    const spaceCount = Math.max(1, width - left.length - right.length);
    const lineStr = `${left}${' '.repeat(spaceCount)}${right}`;
    return this.line(lineStr);
  }

  /**
   * GS V m : Cut paper (0x01 = partial cut, 0x00 = full cut)
   */
  public cut(partial: boolean = true): this {
    this.chunks.push(partial ? ESCPOS_COMMANDS.PAPER_CUT_PARTIAL : ESCPOS_COMMANDS.PAPER_CUT_FULL);
    return this;
  }

  /**
   * Compiles the command stream into a single contiguous Uint8Array.
   */
  public compile(): Uint8Array {
    const totalLength = this.chunks.reduce((acc, curr) => acc + curr.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
}

/**
 * ESC/POS Byte Decoder
 * Parses raw binary thermal printer byte streams back into human-readable lines
 * and state metadata for UI preview emulation.
 */
export class EscPosDecoder {
  private static decoder: TextDecoder = new TextDecoder('utf-8');

  public static decode(bytes: Uint8Array): DecodedReceipt {
    const lines: DecodedReceiptLine[] = [];
    let currentAlign: ReceiptAlignment = 'left';
    let isBold = false;
    let hasCut = false;
    let lineByteAccumulator: number[] = [];

    const flushLine = () => {
      const lineStr = this.decoder.decode(new Uint8Array(lineByteAccumulator));
      lines.push({
        text: lineStr,
        align: currentAlign,
        bold: isBold,
      });
      lineByteAccumulator = [];
    };

    let i = 0;
    while (i < bytes.length) {
      const b = bytes[i];

      // ESC prefix (0x1B)
      if (b === 0x1b && i + 1 < bytes.length) {
        const next = bytes[i + 1];

        // ESC @ : Initialize (0x1B 0x40)
        if (next === 0x40) {
          currentAlign = 'left';
          isBold = false;
          i += 2;
          continue;
        }

        // ESC a n : Alignment (0x1B 0x61 n)
        if (next === 0x61 && i + 2 < bytes.length) {
          const alignCode = bytes[i + 2];
          if (alignCode === 0x01) {
            currentAlign = 'center';
          } else if (alignCode === 0x02) {
            currentAlign = 'right';
          } else {
            currentAlign = 'left';
          }
          i += 3;
          continue;
        }

        // ESC E n : Bold (0x1B 0x45 n)
        if (next === 0x45 && i + 2 < bytes.length) {
          isBold = bytes[i + 2] === 0x01;
          i += 3;
          continue;
        }

        // ESC d n : Feed n lines (0x1B 0x64 n)
        if (next === 0x64 && i + 2 < bytes.length) {
          const count = bytes[i + 2];
          for (let f = 0; f < count; f++) {
            flushLine();
          }
          i += 3;
          continue;
        }

        // Unknown ESC command sequence: skip ESC and continue
        i += 2;
        continue;
      }

      // GS prefix (0x1D)
      if (b === 0x1d && i + 1 < bytes.length) {
        const next = bytes[i + 1];

        // GS V : Cut paper
        if (next === 0x56) {
          hasCut = true;
          // Could be GS V m (3 bytes) or GS V m n (4 bytes)
          if (i + 2 < bytes.length && (bytes[i + 2] === 0x00 || bytes[i + 2] === 0x01)) {
            i += 3;
            continue;
          } else if (i + 3 < bytes.length) {
            i += 4;
            continue;
          }
          i += 2;
          continue;
        }

        i += 2;
        continue;
      }

      // LF (0x0A): Line feed
      if (b === 0x0a) {
        flushLine();
        i++;
        continue;
      }

      // CR (0x0D): Ignore carriage return
      if (b === 0x0d) {
        i++;
        continue;
      }

      // Regular character byte
      lineByteAccumulator.push(b);
      i++;
    }

    // Flush any trailing text without trailing LF
    if (lineByteAccumulator.length > 0) {
      flushLine();
    }

    const rawText = lines.map((l) => l.text).join('\n');

    return {
      lines,
      hasCut,
      rawText,
    };
  }
}

/**
 * High-level helper: Generates complete binary ESC/POS thermal receipt from a SalePayload.
 */
export function generateEscPosReceipt(
  sale: SalePayload,
  options: {
    storeName?: string;
    storeAddress?: string;
    storeTaxId?: string;
    cashierName?: string;
    printerWidth?: number;
  } = {}
): Uint8Array {
  const width = options.printerWidth ?? 32;
  const storeName = options.storeName ?? 'NEXUS RETAIL CO.';
  const storeAddress = options.storeAddress ?? '100 DOWNTOWN AVE, METROPOLIS';

  const builder = new EscPosEncoder();

  // Header
  builder
    .align('center')
    .bold(true)
    .line(storeName)
    .bold(false)
    .line(storeAddress)
    if (options.storeTaxId) {
      builder.line(`TAX ID: ${options.storeTaxId}`);
    }
  builder
    .feed(1)
    .twoColumn(`TERMINAL: ${sale.terminalId}`, `SALE #${sale.saleId.slice(-6)}`, width)
    .twoColumn(
      `CASHIER: ${options.cashierName ?? sale.cashierId}`,
      new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      width
    )
    .rule('=', width);

  // Line Items
  builder.align('left');
  for (const item of sale.items) {
    builder.line(item.name.toUpperCase());
    const qtyPrice = `${item.quantity} x $${item.price.toFixed(2)}`;
    const subtotal = `$${item.subtotal.toFixed(2)}`;
    builder.twoColumn(`  ${qtyPrice}`, subtotal, width);
  }

  // Totals
  builder
    .rule('-', width)
    .twoColumn('SUBTOTAL:', `$${sale.subtotal.toFixed(2)}`, width)
    .twoColumn('TAX:', `$${sale.tax.toFixed(2)}`, width)
    .bold(true)
    .twoColumn('TOTAL DUE:', `$${sale.total.toFixed(2)}`, width)
    .bold(false)
    .twoColumn('PAYMENT METHOD:', sale.paymentMethod, width);

  if (sale.paymentDetails?.amountTendered !== undefined) {
    builder.twoColumn('CASH TENDERED:', `$${sale.paymentDetails.amountTendered.toFixed(2)}`, width);
  }
  if (sale.paymentDetails?.changeDue !== undefined) {
    builder.twoColumn('CHANGE DUE:', `$${sale.paymentDetails.changeDue.toFixed(2)}`, width);
  }
  if (sale.paymentDetails?.cardAuthCode) {
    builder.twoColumn('AUTH CODE:', sale.paymentDetails.cardAuthCode, width);
  }

  // Footer
  builder
    .feed(1)
    .align('center')
    .line('THANK YOU FOR SHOPPING WITH US!')
    .line('PLEASE KEEP RECEIPT FOR RETURNS')
    .feed(2)
    .cut(true);

  return builder.compile();
}
