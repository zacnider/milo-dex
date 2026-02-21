/**
 * Exports trading wallet to Miden Extension Wallet format
 * Format: { dt: base64, iv: base64, salt: object, encryptedPasswordCheck?: base64 }
 * Encryption: PBKDF2-HMAC-SHA256 (100000 iterations) + AES-256-GCM
 */

interface MidenWalletExportJson {
  dt: string; // Encrypted account file (base64)
  iv: string; // Initialization vector (base64)
  salt: { [key: number]: number }; // Salt for PBKDF2 (Uint8Array serialized as object)
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
 * Exports trading wallet account file to Miden extension wallet format
 * @param accountFileBase64 - The account file as base64 string
 * @param password - The password to encrypt the wallet file
 * @returns Miden extension wallet JSON format
 */
export async function exportTradingWalletToMidenFormat(
  accountFileBase64: string,
  password: string
): Promise<MidenWalletExportJson> {
  try {
    // Decode account file from base64
    const accountFileBytes = Uint8Array.from(atob(accountFileBase64), c => c.charCodeAt(0));

    // Generate random salt (32 bytes)
    const salt = crypto.getRandomValues(new Uint8Array(32));
    
    // Derive key from password using PBKDF2
    const key = await deriveKeyFromPassword(password, salt, 100000);

    // Generate random IV (12 bytes for AES-GCM)
    const iv = crypto.getRandomValues(new Uint8Array(12));

    // Encrypt account file using AES-256-GCM
    const encrypted = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv,
        tagLength: 128 // 16 bytes tag
      },
      key,
      accountFileBytes
    );

    // Convert encrypted data to base64
    const encryptedArray = new Uint8Array(encrypted);
    const dt = btoa(String.fromCharCode(...encryptedArray));
    
    // Convert IV to base64
    const ivBase64 = btoa(String.fromCharCode(...iv));
    
    // Convert salt to object format (as Miden extension expects)
    const saltObj: { [key: number]: number } = {};
    salt.forEach((byte, index) => {
      saltObj[index] = byte;
    });

    // Optional: Create password check (encrypt a known value to verify password)
    // This is optional but Miden extension might use it
    const passwordCheck = 'miden-wallet-password-check';
    const passwordCheckBytes = new TextEncoder().encode(passwordCheck);
    const encryptedPasswordCheck = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv, // Reuse IV for password check (or generate new one)
        tagLength: 128
      },
      key,
      passwordCheckBytes
    );
    const encryptedPasswordCheckArray = new Uint8Array(encryptedPasswordCheck);
    const encryptedPasswordCheckBase64 = btoa(String.fromCharCode(...encryptedPasswordCheckArray));

    return {
      dt,
      iv: ivBase64,
      salt: saltObj,
      encryptedPasswordCheck: encryptedPasswordCheckBase64
    };
  } catch (error: any) {
    console.error('Failed to export wallet to Miden format:', error);
    throw new Error(`Failed to export wallet: ${error.message || 'Unknown error'}`);
  }
}

/**
 * Exports trading wallet and downloads it as JSON file
 * @param accountFileBase64 - The account file as base64 string
 * @param accountId - The account ID (for filename)
 * @param password - The password to encrypt the wallet file
 */
export async function downloadTradingWalletAsMidenFormat(
  accountFileBase64: string,
  accountId: string,
  password: string
): Promise<void> {
  try {
    const walletJson = await exportTradingWalletToMidenFormat(accountFileBase64, password);
    
    // Create JSON string
    const jsonString = JSON.stringify(walletJson, null, 2);
    
    // Create blob and download
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trading_wallet_${accountId.slice(0, 16)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    console.log('✅ Trading wallet exported to Miden extension format');
  } catch (error: any) {
    console.error('Failed to download wallet:', error);
    throw error;
  }
}
