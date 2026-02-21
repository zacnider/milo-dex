/**
 * Crypto utilities for encrypting/decrypting sensitive data
 */

const SALT = 'milo-swap-v1-salt';
const ITERATIONS = 100000;

/**
 * Derives an encryption key from a password
 */
async function deriveKey(password: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode(SALT),
      iterations: ITERATIONS,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts a mnemonic phrase with a password
 * Returns base64 encoded encrypted data with IV prepended
 */
export async function encryptMnemonic(
  mnemonic: string,
  password: string
): Promise<string> {
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(mnemonic);
    
    const key = await deriveKey(password);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      data
    );
    
    // Combine IV + encrypted data
    const result = new Uint8Array(iv.length + encrypted.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(encrypted), iv.length);
    
    // Convert to base64
    return btoa(String.fromCharCode(...result));
  } catch (error) {
    console.error('Encryption failed:', error);
    throw new Error('Failed to encrypt mnemonic');
  }
}

/**
 * Decrypts an encrypted mnemonic phrase with a password
 */
export async function decryptMnemonic(
  encryptedMnemonic: string,
  password: string
): Promise<string> {
  try {
    // Decode base64
    const encryptedData = Uint8Array.from(atob(encryptedMnemonic), c => c.charCodeAt(0));
    
    // Extract IV (first 12 bytes) and ciphertext
    const iv = encryptedData.slice(0, 12);
    const ciphertext = encryptedData.slice(12);
    
    const key = await deriveKey(password);
    
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );
    
    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  } catch (error) {
    console.error('Decryption failed:', error);
    throw new Error('Failed to decrypt mnemonic. Wrong password?');
  }
}

/**
 * Generates a random salt for additional security
 */
export function generateSalt(): string {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...salt));
}
