import { describe, expect, it } from 'vitest';
import {
  TRACE_IO_LIMITS,
  boundedPreview,
  ioPayload,
  truncatePreview,
} from '../../src/trace/io-preview';

describe('truncatePreview', () => {
  it('keeps short strings intact', () => {
    expect(truncatePreview('short', 400)).toBe('short');
  });

  it('truncates long strings with an ellipsis marker', () => {
    const out = truncatePreview('a'.repeat(100), 10);
    expect(out).toBe('a'.repeat(10) + '…');
  });
});

describe('boundedPreview', () => {
  it('passes primitives through', () => {
    expect(boundedPreview(42)).toBe(42);
    expect(boundedPreview(true)).toBe(true);
    expect(boundedPreview(null)).toBe(null);
    expect(boundedPreview('plain')).toBe('plain');
  });

  it('truncates long strings to the per-string limit', () => {
    const preview = boundedPreview({ note: 'x'.repeat(1000) }) as { note: string };
    expect(preview.note.length).toBeLessThanOrEqual(TRACE_IO_LIMITS.string + 1);
    expect(preview.note).toContain('…');
  });

  it('caps arrays and summarizes the dropped tail', () => {
    const preview = boundedPreview({ items: Array.from({ length: 20 }, (_, i) => i) }) as {
      items: unknown[];
    };
    const items = preview.items as unknown[];
    expect(items.length).toBe(TRACE_IO_LIMITS.arrayItems + 1);
    expect(String(items.at(-1))).toContain('12 more');
  });

  it('bounds nested object depth', () => {
    const deep = { a: { b: { c: { d: { e: 'too deep' } } } } };
    const preview = boundedPreview(deep) as Record<string, unknown>;
    const leaf = preview.a as Record<string, unknown>;
    const c = (leaf.b as Record<string, unknown>).c as Record<string, unknown>;
    expect(typeof c.d).toBe('string');
  });

  it('guards against circular references', () => {
    const circle: Record<string, unknown> = { name: 'loop' };
    circle.self = circle;
    const preview = boundedPreview(circle) as Record<string, unknown>;
    expect(preview.name).toBe('loop');
    expect(preview.self).toContain('circular');
  });

  it('respects a total budget and omits the tail', () => {
    const preview = boundedPreview(
      { a: 'x'.repeat(100), b: 'y'.repeat(100), c: 'z'.repeat(100) },
      { budget: 120 },
    ) as Record<string, string>;
    const omitted = Object.values(preview).filter((v) => v.includes('omitted'));
    expect(omitted.length).toBeGreaterThanOrEqual(1);
    expect(preview.c).toContain('omitted');
  });

  it('returns JSON-safe output for non-plain values', () => {
    const preview = boundedPreview({ when: new Date('2026-08-16T00:00:00Z') }) as {
      when: string;
    };
    expect(() => JSON.stringify(preview)).not.toThrow();
  });
});

describe('ioPayload', () => {
  it('builds { input, output } from the given sides', () => {
    expect(ioPayload({ input: { q: 1 }, output: { r: 2 } })).toEqual({ input: { q: 1 }, output: { r: 2 } });
  });

  it('omits empty sides', () => {
    expect(ioPayload({ output: {} })).toBeUndefined();
    expect(ioPayload({ input: { q: 1 } })).toEqual({ input: { q: 1 } });
    expect(ioPayload({ input: undefined, output: undefined })).toBeUndefined();
  });
});
