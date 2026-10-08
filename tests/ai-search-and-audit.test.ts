import { describe, it, expect } from 'vitest';
import {
  offlineSmartSearch,
  phoneticNormalize,
  levenshteinDistance,
  scoreProductMatch,
} from '../lib/ai/local-search';
import { OfflineDiscrepancyAuditor } from '../lib/ai/audit-agent';
import { DiscrepancyPayload } from '../types/events';

const MOCK_CATALOG = [
  { sku: 'COLD_BREW_01', name: 'Nitro Cold Brew 16oz', price: 4.75, stock: 12, category: 'Beverage' },
  { sku: 'CROISSANT_02', name: 'Artisan Butter Croissant', price: 3.5, stock: 8, category: 'Bakery' },
  { sku: 'ORGANIC_OAT_03', name: 'Organic Oat Milk Latte', price: 5.25, stock: 10, category: 'Beverage' },
  { sku: 'LIMITED_EDITION_MUG', name: 'Limited Edition Titanium Mug', price: 29.0, stock: 1, category: 'Merchandise' },
];

describe('Offline AI Smart Search', () => {
  it('accurately calculates Levenshtein distance', () => {
    expect(levenshteinDistance('croissant', 'kroisant')).toBe(2);
    expect(levenshteinDistance('latte', 'late')).toBe(1);
    expect(levenshteinDistance('brew', 'brew')).toBe(0);
  });

  it('phonetically normalizes cashier misspellings', () => {
    expect(phoneticNormalize('kroissant')).toBe('kroysant');
    expect(phoneticNormalize('croissant')).toBe('kroysant');
    expect(phoneticNormalize('phone')).toBe('fone');
  });

  it('matches common noisy cashier queries with confidence > 0.85', () => {
    // Typo: "kroisant" -> Artisan Butter Croissant
    const resCroissant = offlineSmartSearch('kroisant', MOCK_CATALOG);
    expect(resCroissant.length).toBeGreaterThan(0);
    expect(resCroissant[0].item.sku).toBe('CROISSANT_02');
    expect(resCroissant[0].score).toBeGreaterThan(0.85);

    // Phonetic / partial: "nitro"
    const resColdBrew = offlineSmartSearch('nitro', MOCK_CATALOG);
    expect(resColdBrew.length).toBeGreaterThan(0);
    expect(resColdBrew[0].item.sku).toBe('COLD_BREW_01');
    expect(resColdBrew[0].score).toBeGreaterThan(0.85);

    // Typo: "titanum mug" -> Limited Edition Titanium Mug
    const resMug = offlineSmartSearch('titanum mug', MOCK_CATALOG);
    expect(resMug.length).toBeGreaterThan(0);
    expect(resMug[0].item.sku).toBe('LIMITED_EDITION_MUG');
    expect(resMug[0].score).toBeGreaterThan(0.85);
  });
});

describe('Offline AI Discrepancy Auditor Agent', () => {
  it('generates executive brief with balanced ledger confirmation and immediate resolution', () => {
    const discrepancy: DiscrepancyPayload = {
      incidentId: 'inc_race_123',
      sku: 'LIMITED_EDITION_MUG',
      saleEventId: 'evt_sale_beta_99',
      terminalId: 'TERM_BETA',
      expectedStock: 0,
      actualStock: -1,
      deficit: 1,
      reason: 'CONCURRENT_OFFLINE_SELLOUT',
      detectedAt: '2026-10-08T18:00:00.000Z',
      resolved: false,
    };

    const brief = OfflineDiscrepancyAuditor.generateBrief(discrepancy, {
      item: {
        sku: 'LIMITED_EDITION_MUG',
        name: 'Limited Edition Titanium Mug',
        price: 29.0,
        stock: -1,
        reorderThreshold: 1,
        updatedAt: '2026-10-08T18:00:00.000Z',
      },
    });

    expect(brief.severity).toBe('HIGH');
    expect(brief.rootCauseSummary).toContain('Concurrent offline checkout detected');
    expect(brief.financialLedgerSummary).toContain('Financial ledger is 100% balanced');
    expect(brief.financialLedgerSummary).toContain('+$29.00');
    expect(brief.immediateResolution).toContain('Allocate 1 unit safety reserve stock');
    expect(brief.remediationSteps.length).toBeGreaterThanOrEqual(3);
  });
});
