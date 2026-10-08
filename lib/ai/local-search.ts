/**
 * NexusPOS Offline Local AI Layer — Zero-Dependency Semantic & Typo Matcher
 * Executes 100% in-browser / edge with zero external network or cloud dependencies.
 * Combines Levenshtein edit distance, phonetic normalization, and n-gram overlap.
 */

export interface SearchableProduct {
  sku: string;
  name: string;
  price: number;
  stock: number;
  category?: string;
}

export interface SmartSearchResult<T extends SearchableProduct> {
  item: T;
  score: number; // Normalized 0.00 to 1.00
  isAiMatched: boolean;
  matchReason: string;
}

/**
 * Phonetic normalizer for noisy retail cashier input:
 * Maps common phonetic equivalences (e.g. 'ph' -> 'f', 'c'/'ck' -> 'k', 'oi' -> 'oy')
 * and collapses consecutive duplicate consonants.
 */
export function phoneticNormalize(str: string): string {
  let s = str.toLowerCase().trim();
  s = s.replace(/[^a-z0-9\s]/g, ''); // strip punctuation
  s = s.replace(/ph/g, 'f');
  s = s.replace(/ck/g, 'k');
  s = s.replace(/c(?=[eiy])/g, 's'); // soft c
  s = s.replace(/c/g, 'k'); // hard c
  s = s.replace(/oi/g, 'oy');
  s = s.replace(/qu/g, 'kw');
  s = s.replace(/x/g, 'ks');
  s = s.replace(/([b-df-hj-np-tv-z])\1+/g, '$1'); // collapse duplicate consonants
  return s;
}

/**
 * Computes standard Levenshtein edit distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  if (m === 0) return n;
  if (n === 0) return m;

  // Single-row memory optimization
  let prevRow = new Array(n + 1);
  let currRow = new Array(n + 1);

  for (let j = 0; j <= n; j++) {
    prevRow[j] = j;
  }

  for (let i = 1; i <= m; i++) {
    currRow[0] = i;
    const aChar = a[i - 1];

    for (let j = 1; j <= n; j++) {
      const cost = aChar === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        currRow[j - 1] + 1, // insertion
        prevRow[j] + 1, // deletion
        prevRow[j - 1] + cost // substitution
      );
    }

    [prevRow, currRow] = [currRow, prevRow];
  }

  return prevRow[n];
}

/**
 * Calculates normalized string similarity (0.00 to 1.00) from edit distance.
 */
export function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshteinDistance(a, b);
  return Math.max(0, 1 - dist / maxLen);
}

/**
 * Generates character n-grams from a token.
 */
function getNGrams(str: string, n = 2): Set<string> {
  const ngrams = new Set<string>();
  if (str.length < n) {
    ngrams.add(str);
    return ngrams;
  }
  for (let i = 0; i <= str.length - n; i++) {
    ngrams.add(str.slice(i, i + n));
  }
  return ngrams;
}

/**
 * Computes Dice coefficient based on character bigram overlap.
 */
export function nGramSimilarity(a: string, b: string, n = 2): number {
  if (a === b) return 1.0;
  const aGrams = getNGrams(a, n);
  const bGrams = getNGrams(b, n);

  let intersection = 0;
  for (const g of aGrams) {
    if (bGrams.has(g)) intersection++;
  }

  const total = aGrams.size + bGrams.size;
  return total === 0 ? 0 : (2 * intersection) / total;
}

/**
 * Evaluates semantic and phonetic match score between a user search query
 * and a target product record.
 */
export function scoreProductMatch(query: string, product: SearchableProduct): { score: number; reason: string } {
  const qClean = query.toLowerCase().trim();
  if (!qClean) return { score: 0, reason: '' };

  const targetName = product.name.toLowerCase();
  const targetSku = product.sku.toLowerCase();
  const targetCategory = (product.category ?? '').toLowerCase();

  // 1. Exact match / prefix match (Score: 1.0)
  if (targetSku === qClean || targetName === qClean) {
    return { score: 1.0, reason: 'Exact Match' };
  }
  if (targetSku.startsWith(qClean) || targetName.startsWith(qClean)) {
    return { score: 0.98, reason: 'Prefix Match' };
  }
  if (targetName.includes(qClean) || targetSku.includes(qClean)) {
    return { score: 0.95, reason: 'Substring Match' };
  }

  // 2. Tokenized multi-word comparison
  const queryTokens = qClean.split(/\s+/).filter(Boolean);
  const productTokens = `${targetName} ${targetSku} ${targetCategory}`.split(/\s+/).filter(Boolean);

  let tokenMatchSum = 0;
  const matchedTokens: string[] = [];

  for (const qTok of queryTokens) {
    let bestTokScore = 0;
    let bestMatchedWord = '';

    for (const pTok of productTokens) {
      // Substring check
      if (pTok.includes(qTok)) {
        bestTokScore = Math.max(bestTokScore, 0.92);
        bestMatchedWord = pTok;
        continue;
      }

      // Levenshtein similarity
      const levSim = stringSimilarity(qTok, pTok);

      // Phonetic normalized similarity
      const qPhone = phoneticNormalize(qTok);
      const pPhone = phoneticNormalize(pTok);
      const phoneSim = stringSimilarity(qPhone, pPhone);

      // Bigram Dice similarity
      const diceSim = nGramSimilarity(qTok, pTok, 2);

      const candidateScore = Math.max(levSim * 0.9, phoneSim * 0.95, diceSim * 0.85);

      if (candidateScore > bestTokScore) {
        bestTokScore = candidateScore;
        bestMatchedWord = pTok;
      }
    }

    if (bestTokScore > 0.65) {
      matchedTokens.push(bestMatchedWord);
    }
    tokenMatchSum += bestTokScore;
  }

  const averageTokenScore = queryTokens.length > 0 ? tokenMatchSum / queryTokens.length : 0;

  // Full-string phonetic fallback
  const fullQPhone = phoneticNormalize(qClean);
  const fullNPhone = phoneticNormalize(targetName);
  const fullPhoneSim = stringSimilarity(fullQPhone, fullNPhone);

  const finalScore = Number(Math.max(averageTokenScore, fullPhoneSim * 0.92).toFixed(3));

  let reason = 'Fuzzy AI Match';
  if (finalScore >= 0.88) {
    reason = matchedTokens.length > 0 ? `Phonetic & Typo Match (~${matchedTokens.join(', ')})` : 'Phonetic Match';
  } else if (finalScore >= 0.75) {
    reason = 'Partial Match';
  }

  return { score: finalScore, reason };
}

/**
 * Offline Smart Search:
 * Rapidly filters and ranks catalog items by fuzzy/phonetic AI match confidence.
 * Returns only candidates above minimum confidence threshold (default 0.70).
 */
export function offlineSmartSearch<T extends SearchableProduct>(
  query: string,
  catalog: T[],
  minConfidence = 0.7
): SmartSearchResult<T>[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return catalog.map((item) => ({
      item,
      score: 1.0,
      isAiMatched: false,
      matchReason: 'Catalog All',
    }));
  }

  const results: SmartSearchResult<T>[] = [];

  for (const item of catalog) {
    const { score, reason } = scoreProductMatch(trimmed, item);
    if (score >= minConfidence) {
      const isAi = score < 0.95 || reason.includes('Typo') || reason.includes('Phonetic');
      results.push({
        item,
        score,
        isAiMatched: isAi,
        matchReason: reason,
      });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}
