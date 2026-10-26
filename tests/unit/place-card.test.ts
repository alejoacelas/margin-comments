import { describe, expect, it } from 'vitest';

// placeCard reads window size; give it a 1280x860 viewport.
(globalThis as any).window = { innerWidth: 1280, innerHeight: 860 };
const { placeCard } = await import('../../src/extension/content/ui/app');

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;

describe('placeCard', () => {
  it('docks in the margin next to the text column', () => {
    const pos = placeCard({ rects: [rect(300, 200, 400, 20)], columnRight: 900 }, 160, false)!;
    expect(pos.left).toBe(915);
    expect(pos.top).toBe(194);
  });
  it('never extends below the viewport (comment near the bottom of a short page)', () => {
    const pos = placeCard({ rects: [rect(300, 800, 400, 20)], columnRight: 900 }, 160, false)!;
    expect(pos.top + 160).toBeLessThanOrEqual(860 - 8);
  });
  it('falls back below the highlight when there is no margin, flipping above near the bottom', () => {
    const below = placeCard({ rects: [rect(100, 300, 1100, 20)], columnRight: 1200 }, 160, false)!;
    expect(below.top).toBe(328);
    const above = placeCard({ rects: [rect(100, 780, 1100, 20)], columnRight: 1200 }, 160, false)!;
    expect(above.top + 160).toBeLessThanOrEqual(780);
  });
});
