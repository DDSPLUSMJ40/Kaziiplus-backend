import { describe, it, expect, beforeEach } from 'vitest';
import { encrypt, decrypt } from './crypto';

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64); // 32 bytes hex
});

describe('encrypt/decrypt', () => {
  it('round-trips a plaintext string', () => {
    const packed = encrypt('a-real-printful-token');
    expect(decrypt(packed)).toBe('a-real-printful-token');
  });

  it('produces different ciphertext each time (random IV)', () => {
    const a = encrypt('same-input');
    const b = encrypt('same-input');
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe('same-input');
    expect(decrypt(b)).toBe('same-input');
  });

  it('throws if ENCRYPTION_KEY is not set', () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encrypt('x')).toThrow('ENCRYPTION_KEY is not set');
  });
});
