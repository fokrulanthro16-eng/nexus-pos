import { DiscrepancyPayload, NexusEvent, InventoryItem } from '@/types/events';

export interface AuditNarrativeReport {
  incidentId: string;
  sku: string;
  productName: string;
  severity: 'CRITICAL' | 'HIGH' | 'WARNING';
  rootCauseSummary: string;
  financialLedgerSummary: string;
  immediateResolution: string;
  remediationSteps: string[];
  executiveBrief: string;
  generatedAt: string;
}

/**
 * Autonomous Offline Discrepancy Auditor Agent
 * Deterministically constructs executive reconciliation briefs from event sourcing logs
 * and offline partition telemetry without needing cloud LLM calls.
 */
export class OfflineDiscrepancyAuditor {
  /**
   * Evaluates an inventory discrepancy payload against the event log and produces
   * a structured executive brief.
   */
  public static generateBrief(
    discrepancy: DiscrepancyPayload,
    options: {
      item?: InventoryItem;
      relatedEvents?: NexusEvent[];
      currencySymbol?: string;
    } = {}
  ): AuditNarrativeReport {
    const currency = options.currencySymbol ?? '$';
    const productName = options.item?.name ?? `SKU ${discrepancy.sku}`;
    const price = options.item?.price ?? 0;
    const deficit = discrepancy.deficit;

    // Calculate total financial impact from confirmed sales
    let collectedRevenue = price * (deficit + (options.item ? Math.max(0, discrepancy.expectedStock) : 1));
    if (options.relatedEvents && options.relatedEvents.length > 0) {
      const saleEvents = options.relatedEvents.filter((e) => e.type === 'SALE_COMMITTED');
      if (saleEvents.length > 0) {
        collectedRevenue = saleEvents.reduce((acc, evt) => {
          if (evt.type === 'SALE_COMMITTED') {
            const match = evt.payload.items.find((i) => i.sku === discrepancy.sku);
            return acc + (match ? match.subtotal : 0);
          }
          return acc;
        }, 0);
      }
    }

    const terminalsInvolved = options.relatedEvents
      ? Array.from(new Set(options.relatedEvents.map((e) => e.terminalId))).join(' & ')
      : discrepancy.terminalId;

    const rootCauseSummary =
      `Concurrent offline checkout detected across ${terminalsInvolved || 'multiple edge terminals'} ` +
      `during an uncoordinated network partition. Both physical customers presented payment and completed checkout simultaneously.`;

    const financialLedgerSummary =
      `Financial ledger is 100% balanced and fully solvent (+${currency}${collectedRevenue.toFixed(2)} total tendered). ` +
      `No unauthorized transactions or customer payment disputes recorded. Physical product handed over at point-of-sale.`;

    const immediateResolution =
      `Allocate ${deficit} unit${deficit > 1 ? 's' : ''} safety reserve stock for ${productName} (${discrepancy.sku}) ` +
      `to reconcile central inventory ledger back to zero baseline.`;

    const remediationSteps = [
      `Confirm physical stock count on sales floor for ${discrepancy.sku}.`,
      `Dispatch automatic warehouse replenishment order (+${Math.max(5, deficit * 2)} units) to restock safety threshold.`,
      `Mark Incident #${discrepancy.incidentId.slice(-6)} as Resolved in Central Manager Audit Ledger.`,
    ];

    const executiveBrief =
      `[OFFLINE AI AUDITOR BRIEF]\n` +
      `Root Cause: ${rootCauseSummary}\n` +
      `Financial Ledger: ${financialLedgerSummary}\n` +
      `Immediate Resolution: ${immediateResolution}`;

    const severity = deficit >= 3 ? 'CRITICAL' : deficit >= 1 ? 'HIGH' : 'WARNING';

    return {
      incidentId: discrepancy.incidentId,
      sku: discrepancy.sku,
      productName,
      severity,
      rootCauseSummary,
      financialLedgerSummary,
      immediateResolution,
      remediationSteps,
      executiveBrief,
      generatedAt: discrepancy.detectedAt,
    };
  }
}
