/**
 * Enterprise Business Policy Engine: SKU Oversell Allocation Guard
 * Configures per-SKU offline oversell permissions to prevent unrecoverable shrinkage on limited goods.
 */

export interface SkuOversellPolicy {
  readonly sku: string;
  readonly name: string;
  readonly allowOfflineOversell: boolean;
  readonly category: 'consumable' | 'limited_merchandise' | 'standard';
  readonly policyDescription: string;
}

export interface OversellEvaluationResult {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly policy: SkuOversellPolicy;
}

export const SKU_OVERSELL_POLICIES: Record<string, SkuOversellPolicy> = {
  COLD_BREW_01: {
    sku: 'COLD_BREW_01',
    name: 'Cold Brew 16oz',
    allowOfflineOversell: true,
    category: 'consumable',
    policyDescription: 'Consumable product. Offline oversell permitted; reconciled via backorder or safety stock.',
  },
  CROISSANT_02: {
    sku: 'CROISSANT_02',
    name: 'Artisan Croissant',
    allowOfflineOversell: true,
    category: 'consumable',
    policyDescription: 'Bakery consumable. Offline oversell permitted with auto-reconciliation.',
  },
  ORGANIC_OAT_03: {
    sku: 'ORGANIC_OAT_03',
    name: 'Organic Oat Milk Latte',
    allowOfflineOversell: true,
    category: 'consumable',
    policyDescription: 'Consumable product. Offline oversell permitted.',
  },
  LIMITED_EDITION_MUG: {
    sku: 'LIMITED_EDITION_MUG',
    name: 'Limited Ceramic Mug',
    allowOfflineOversell: false,
    category: 'limited_merchandise',
    policyDescription: 'High-value / strictly limited physical inventory. Strict offline oversell restriction.',
  },
};

export const STRICT_OVERSELL_REJECTION_MESSAGE =
  'Inventory Allocation Policy: This limited item cannot be oversold offline without central authority confirmation.';

/**
 * Evaluates whether an item can be added to the cart given current local stock and policy rules.
 */
export function evaluateOversellPolicy(
  sku: string,
  currentStock: number,
  requestedQuantity = 1
): OversellEvaluationResult {
  const policy = SKU_OVERSELL_POLICIES[sku] ?? {
    sku,
    name: `SKU ${sku}`,
    allowOfflineOversell: true,
    category: 'standard',
    policyDescription: 'Default standard SKU policy',
  };

  // If policy forbids offline oversell and current stock cannot fulfill requested quantity:
  if (!policy.allowOfflineOversell && (currentStock <= 0 || currentStock < requestedQuantity)) {
    return {
      allowed: false,
      reason: STRICT_OVERSELL_REJECTION_MESSAGE,
      policy,
    };
  }

  return {
    allowed: true,
    policy,
  };
}

/**
 * Checks whether an item's SKU is configured to allow offline overselling.
 */
export function isOversellAllowed(sku: string): boolean {
  return SKU_OVERSELL_POLICIES[sku]?.allowOfflineOversell ?? true;
}
