/**
 * Decrypts Miden Extension Wallet encrypted JSON file
 * Format: { dt: base64, iv: base64, salt: base64, encryptedPasswordCheck: base64 }
 * Encryption: PBKDF2-HMAC-SHA256 (100000 iterations) + AES-256-GCM
 */

interface MidenWalletJson {
  dt: string; // Encrypted account file (base64)
  iv: string; // Initialization vector (base64)
  salt: string | number[] | { [key: string]: number }; // Salt for PBKDF2 (base64 string or Uint8Array-like object)
  encryptedPasswordCheck?: string; // Optional password verification (base64)
}

/**
 * Derives AES-256 key from password using PBKDF2-HMAC-SHA256
 * Same parameters as Miden extension wallet uses
 */
async function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array,
  iterations: number = 100000
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt.buffer as ArrayBuffer,
      iterations: iterations,
      hash: 'SHA-256'
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Decrypts Miden extension wallet encrypted JSON file
 * @param walletJson - The encrypted wallet JSON object
 * @param password - The password used to encrypt the wallet
 * @returns Decrypted account file as base64 string (ready for AccountFile.deserialize)
 */
export async function decryptMidenWalletFile(
  walletJson: MidenWalletJson,
  password: string
): Promise<string> {
  try {
    // Decode base64 fields
    const encryptedData = Uint8Array.from(atob(walletJson.dt), c => c.charCodeAt(0));
    const iv = Uint8Array.from(atob(walletJson.iv), c => c.charCodeAt(0));
    
    // Handle salt - it can be base64 string or Uint8Array-like object
    let salt: Uint8Array;
    if (typeof walletJson.salt === 'string') {
      // Base64 string
      salt = Uint8Array.from(atob(walletJson.salt), c => c.charCodeAt(0));
    } else if (Array.isArray(walletJson.salt)) {
      // Array of numbers
      salt = new Uint8Array(walletJson.salt);
    } else if (typeof walletJson.salt === 'object') {
      // Object with numeric keys (Uint8Array serialized as object)
      const saltObj = walletJson.salt as { [key: string]: number };
      const saltArray = Object.keys(saltObj)
        .map(k => parseInt(k))
        .sort((a, b) => a - b)
        .map(k => saltObj[k]);
      salt = new Uint8Array(saltArray);
    } else {
      throw new Error('Invalid salt format in wallet file');
    }

    // Derive key from password using PBKDF2
    // Miden extension uses: PBKDF2-HMAC-SHA256 with 100000 iterations
    const key = await deriveKeyFromPassword(password, salt, 100000);

    // Decrypt using AES-256-GCM
    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv,
        tagLength: 128 // 16 bytes tag for GCM
      },
      key,
      encryptedData
    );

    // Convert decrypted bytes to base64 string
    // The decrypted data is the raw account file bytes
    const decryptedArray = new Uint8Array(decrypted);
    const base64 = btoa(String.fromCharCode(...decryptedArray));

    // Verify it's a valid account file by checking magic bytes "acct"
    const magic = String.fromCharCode(...decryptedArray.slice(0, 4));
    if (magic !== 'acct') {
      throw new Error('Decrypted data does not appear to be a valid Miden account file (magic bytes mismatch)');
    }

    return base64;
  } catch (error: any) {
    if (error.name === 'OperationError' || error.message?.includes('decrypt')) {
      throw new Error('Failed to decrypt wallet file. Wrong password?');
    }
    throw error;
  }
}

/**
 * Imports a Miden extension wallet file into our in-app wallet
 * @param walletJson - The encrypted wallet JSON object
 * @param password - The password used to encrypt the wallet
 * @param extensionWalletAddress - The extension wallet address to associate with
 * @returns The account file data that can be imported into WebClient
 */
export async function importMidenWalletToAppWallet(
  walletJson: MidenWalletJson,
  password: string,
  _extensionWalletAddress: string
): Promise<{
  accountFileBase64: string;
  accountId: string;
}> {
  try {
    // Decrypt the wallet file
    const accountFileBase64 = await decryptMidenWalletFile(walletJson, password);

    // Parse account file to get account ID
    // We need to deserialize it to get the account ID
    const { AccountFile } = await import('@miden-sdk/miden-sdk');
    const accountFileBytes = Uint8Array.from(atob(accountFileBase64), c => c.charCodeAt(0));
    const accountFile = AccountFile.deserialize(accountFileBytes);
    // AccountFile has accountId() method, but TypeScript types may not reflect it
    const accountId = (accountFile as any).accountId ? (accountFile as any).accountId().toString() : (accountFile as any).account().id().toString();

    return {
      accountFileBase64,
      accountId
    };
  } catch (error: any) {
    console.error('Failed to import Miden wallet:', error);
    throw new Error(`Failed to import wallet: ${error.message || 'Unknown error'}`);
  }
}
