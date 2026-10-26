/*
 * Vendored from hypothesis/client (BSD-2-Clause, see ./LICENSE),
 * src/annotator/anchoring/html.ts at commit a7b7400d0d706d4357ec37c2a3610b25dcca89d5.
 * Local changes are marked with "margin-comments:" comments.
 *
 * margin-comments: this file is reduced to `describe`, made synchronous, and
 * MediaTime support is removed. The anchoring strategy (range selector, then
 * position selector, each verified against the quote, then fuzzy quote
 * matching) lives in ../anchor.ts, which reuses the anchor classes below.
 */
import type { Selector } from '../../../../shared/types';
import { RangeAnchor, TextPositionAnchor, TextQuoteAnchor } from './types';

export function describe(root: Element, range: Range): Selector[] {
  const types = [RangeAnchor, TextPositionAnchor, TextQuoteAnchor];
  const result: Selector[] = [];
  for (const type of types) {
    try {
      const anchor = type.fromRange(root, range);
      if (anchor) {
        result.push(anchor.toSelector());
      }
    } catch {
      // If resolving some anchor fails, we just want to skip it silently
    }
  }
  return result;
}
