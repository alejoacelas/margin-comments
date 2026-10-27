/*
 * Vendored from hypothesis/client (BSD-2-Clause, see ./LICENSE),
 * src/annotator/anchoring/match-quote.ts at commit a7b7400d0d706d4357ec37c2a3610b25dcca89d5.
 * Local changes are marked with "margin-comments:" comments.
 */
import approxSearch from 'approx-string-match';
import type { Match as StringMatch } from 'approx-string-match';

// margin-comments: most candidates scored per quote.
const MAX_CANDIDATES = 2000;

type Match = {
  /** Start offset of match in text */
  start: number;
  /** End offset of match in text */
  end: number;

  /**
   * Score for the match between 0 and 1.0, where 1.0 indicates a perfect match
   * for the quote and context.
   */
  score: number;

  // margin-comments: expose the component scores so callers can apply an
  // acceptance threshold (orphan rather than mis-anchor).
  quoteScore: number;
  prefixScore: number;
  suffixScore: number;
};

/**
 * Find the best approximate matches for `str` in `text` allowing up to
 * `maxErrors` errors.
 */
function search(text: string, str: string, maxErrors: number, alsoFuzzy = false): StringMatch[] {
  // Do a fast search for exact matches. The `approx-string-match` library
  // doesn't currently incorporate this optimization itself.
  let matchPos = 0;
  const exactMatches: StringMatch[] = [];
  while (matchPos !== -1) {
    matchPos = text.indexOf(str, matchPos);
    if (matchPos !== -1) {
      exactMatches.push({
        start: matchPos,
        end: matchPos + str.length,
        errors: 0,
      });
      matchPos += 1;
    }
  }
  if (exactMatches.length > 0 && !alsoFuzzy) {
    return exactMatches;
  }
  // margin-comments: optionally also consider the best near match when exact
  // ones exist (an exact repeat elsewhere vs. the edited passage itself).
  // approx-string-match keeps only the closest matches, so the exact
  // occurrences are masked out (same length: offsets don't move) first.
  if (exactMatches.length > 0) {
    let masked = '';
    let at = 0;
    for (const m of exactMatches) {
      if (m.start < at) continue;
      masked += text.slice(at, m.start) + '\u0000'.repeat(m.end - m.start);
      at = m.end;
    }
    masked += text.slice(at);
    return [...exactMatches, ...approxSearch(masked, str, maxErrors)];
  }

  // If there are no exact matches, do a more expensive search for matches
  // with errors.
  return approxSearch(text, str, maxErrors);
}

/**
 * Compute a score between 0 and 1.0 for the similarity between `text` and `str`.
 */
function textMatchScore(text: string, str: string) {
  // `search` will return no matches if either the text or pattern is empty,
  // otherwise it will return at least one match if the max allowed error count
  // is at least `str.length`.
  if (str.length === 0 || text.length === 0) {
    return 0.0;
  }

  const matches = search(text, str, str.length);

  // prettier-ignore
  return 1 - (matches[0].errors / str.length);
}

type Context = {
  /** Expected text before the quote */
  prefix?: string;
  /** Expected text after the quote */
  suffix?: string;
  /** Expected offset of match within text */
  hint?: number;
};

/**
 * Find the best approximate match for `quote` in `text`.
 *
 * @param text - Document text to search
 * @param quote - String to find within `text`
 * @param context - Context in which the quote originally appeared. This is
 *        used to choose the best match.
 * @return `null` if no match exceeding the minimum quality threshold was found.
 */
export function matchQuote(
  text: string,
  quote: string,
  context: Context = {},
): Match | null {
  return matchQuoteCandidates(text, quote, context)[0] ?? null;
}

/**
 * margin-comments: same as `matchQuote` but returns every candidate, best
 * first, so callers can prefer e.g. a visible match among near-ties.
 */
export function matchQuoteCandidates(
  text: string,
  quote: string,
  context: Context = {},
  alsoFuzzy = false,
): Match[] {
  if (quote.length === 0) {
    return [];
  }

  // Choose the maximum number of errors to allow for the initial search.
  // This choice involves a tradeoff between:
  //
  //  - Recall (proportion of "good" matches found)
  //  - Precision (proportion of matches found which are "good")
  //  - Cost of the initial search and of processing the candidate matches [1]
  //
  // [1] Specifically, the expected-time complexity of the initial search is
  //     `O((maxErrors / 32) * text.length)`. See `approx-string-match` docs.
  const maxErrors = Math.min(256, quote.length / 2);

  // Find the closest matches for `quote` in `text` based on edit distance.
  let matches = search(text, quote, maxErrors, alsoFuzzy);
  // margin-comments: a short quote can occur thousands of times on a big
  // page; scoring each one's context has a cost, so only the ones nearest
  // the expected position are scored.
  if (matches.length > MAX_CANDIDATES) {
    const hint = context.hint ?? 0;
    matches = [...matches].sort((a, b) => Math.abs(a.start - hint) - Math.abs(b.start - hint)).slice(0, MAX_CANDIDATES);
  }

  if (matches.length === 0) {
    return [];
  }

  /**
   * Compute a score between 0 and 1.0 for a match candidate.
   */
  const scoreMatch = (match: StringMatch) => {
    const quoteWeight = 50; // Similarity of matched text to quote.
    const prefixWeight = 20; // Similarity of text before matched text to `context.prefix`.
    const suffixWeight = 20; // Similarity of text after matched text to `context.suffix`.
    const posWeight = 2; // Proximity to expected location. Used as a tie-breaker.

    const quoteScore = 1 - match.errors / quote.length;

    const prefixScore = context.prefix
      ? textMatchScore(
          text.slice(
            Math.max(0, match.start - context.prefix.length),
            match.start,
          ),
          context.prefix,
        )
      : 1.0;
    const suffixScore = context.suffix
      ? textMatchScore(
          text.slice(match.end, match.end + context.suffix.length),
          context.suffix,
        )
      : 1.0;

    let posScore = 1.0;
    if (typeof context.hint === 'number') {
      const offset = Math.abs(match.start - context.hint);
      posScore = 1.0 - offset / text.length;
    }

    const rawScore =
      quoteWeight * quoteScore +
      prefixWeight * prefixScore +
      suffixWeight * suffixScore +
      posWeight * posScore;
    const maxScore = quoteWeight + prefixWeight + suffixWeight + posWeight;
    const normalizedScore = rawScore / maxScore;

    return { score: normalizedScore, quoteScore, prefixScore, suffixScore };
  };

  // Rank matches based on similarity of actual and expected surrounding text
  // and actual/expected offset in the document text.
  const scoredMatches = matches.map(m => ({
    start: m.start,
    end: m.end,
    ...scoreMatch(m),
  }));

  // Choose match with the highest score.
  scoredMatches.sort((a, b) => b.score - a.score);
  return scoredMatches;
}
