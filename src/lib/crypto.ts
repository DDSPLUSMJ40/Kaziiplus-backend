import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

// AES-256-GCM, keyed by ENCRYPTION_KEY (32 random bytes, hex-encoded --
// generated the same way JWT_SECRET is). IV and auth tag are packed into
// the stored string alongside the ciphertext so decryption is
// self-contained: "<iv>:<authTag>:<ciphertext>", all hex.
function getKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error('ENCRYPTION_KEY is not set. Refusing to encrypt/decrypt.');
  }
  return Buffer.from(key, 'hex');
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decrypt(packed: string): string {
  const [ivHex, authTagHex, ciphertextHex] = packed.split(':');
  const decipher = createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]).toString('utf8');
}
