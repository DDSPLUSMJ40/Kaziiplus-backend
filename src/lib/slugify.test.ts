import { describe, it, expect } from 'vitest';
import { slugify } from './slugify';

describe('slugify', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(slugify('Elena Cruz')).toBe('elena-cruz');
  });

  it('strips punctuation', () => {
    expect(slugify("Jo's Candles!")).toBe('jos-candles');
  });

  it('collapses repeated whitespace into one hyphen', () => {
    expect(slugify('Multi   Space   Brand')).toBe('multi-space-brand');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('  -Leading Trailing-  ')).toBe('leading-trailing');
  });

  it('returns an empty string for input with no keepable characters', () => {
    expect(slugify('!!!')).toBe('');
  });
});
