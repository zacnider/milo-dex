/**
 * Application Wallet Manager
 * Handles creation, restoration, and export of in-app Miden wallets
 */

import * as bip39 from 'bip39';
import { WebClient, AccountStorageMode, AccountId, NetworkId, AccountInterface } from '@miden-sdk/miden-sdk';
import { encryptMnemonic, decryptMnemonic } from './crypto';

const STORAGE_KEY = 'milo_app_wallets'; // Changed to plural for multi-wallet support

export interface AppWalletData {
  accountId: string;
  encryptedMnemonic: string;
  encryptedAccountFile: string; // Base64 encoded encrypted account file
  createdAt: number;
  address: string;
  salt?: string;
}

export interface AppWalletsMap {
  [extensionWalletAddress: string]: AppWalletData;
}

/**
 * Generates a 12-word BIP39 mnemonic phrase
 */
export function generateMnemonic(): string {
  return bip39.generateMnemonic(128); // 128 bits = 12 words
}

/**
 * Generates a deterministic 12-word BIP39 mnemonic from extension wallet address
 * Same extension wallet address will always produce the same mnemonic
 */
export async function generateDeterministicMnemonic(extensionWalletAddress: string): Promise<string> {
  // 1. Hash the extension wallet address using SHA-256
  const encoder = new TextEncoder();
  const data = encoder.encode(extensionWalletAddress);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  
  // 2. Take first 16 bytes (128 bits) for BIP39 entropy
  const entropy = hashArray.slice(0, 16);
  
  // 3. Convert entropy to hex string (32 characters for 16 bytes)
  const entropyHex = Array.from(entropy)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  // 4. Convert entropy to mnemonic
  const mnemonic = bip39.entropyToMnemonic(entropyHex);
  
  console.log(`Generated deterministic mnemonic for ${extensionWalletAddress}:`, mnemonic);
  console.log(`Entropy (first 8 bytes):`, Array.from(entropy.slice(0, 8)));
  
  return mnemonic;
}

/**
 * Validates a BIP39 mnemonic phrase
 */
export function validateMnemonic(mnemonic: string): boolean {
  return bip39.validateMnemonic(mnemonic);
}

/**
 * Converts a mnemonic phrase to a 32-byte seed for init_seed
 */
export function mnemonicToSeed(mnemonic: string): Uint8Array {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  return new Uint8Array(seed.slice(0, 32)); // Take first 32 bytes for init_seed
}

/**
 * Derives a 32-byte auth seed from mnemonic (different derivation path)
 */
export function mnemonicToAuthSeed(mnemonic: string): Uint8Array {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  return new Uint8Array(seed.slice(32, 64)); // Take bytes 32-64 for auth key seed
}

/**
 * Gets all app wallets from localStorage
 */
export function getAllAppWallets(): AppWalletsMap {
  try {
    const walletsStr = localStorage.getItem(STORAGE_KEY);
    if (!walletsStr) {
      return {};
    }
    return JSON.parse(walletsStr);
  } catch (error) {
    console.error('Failed to get app wallets:', error);
    return {};
  }
}

/**
 * Saves all app wallets to localStorage
 */
export function saveAllAppWallets(wallets: AppWalletsMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(wallets));
  } catch (error) {
    console.error('Failed to save app wallets:', error);
    throw error;
  }
}

/**
 * Creates a new in-app wallet with a deterministic mnemonic for a specific extension wallet
 * Same extension wallet address will always produce the same trading wallet
 * The seed phrase can be exported and imported to Miden extension wallet or other browsers
 * Same seed phrase = same account (deterministic, works everywhere)
 */
export async function createAppWallet(
  client: WebClient,
  userPassword: string,
  extensionWalletAddress: string
): Promise<{ walletData: AppWalletData; mnemonic: string }> {
  try {
    // 1. Check if wallet already exists for this extension wallet
    const existingWallet = getAppWalletData(extensionWalletAddress);
    if (existingWallet) {
      console.log(`Trading wallet already exists for ${extensionWalletAddress}, returning existing wallet`);
      // Decrypt mnemonic to return it
      const mnemonic = await decryptMnemonic(existingWallet.encryptedMnemonic, userPassword);
      return { walletData: existingWallet, mnemonic };
    }
    
    // 2. Generate deterministic 12-word mnemonic from extension wallet address
    // Same extension wallet = same mnemonic = same account (deterministic)
    const mnemonic = await generateDeterministicMnemonic(extensionWalletAddress);
    console.log('Generated deterministic mnemonic from extension wallet:', mnemonic);
    
    // 2. Derive seeds deterministically from mnemonic
    const initSeed = mnemonicToSeed(mnemonic); // For account init (first 32 bytes)
    const authSeed = mnemonicToAuthSeed(mnemonic); // For auth key (bytes 32-64)
    
    console.log('Derived init seed (first 8 bytes):', Array.from(initSeed.slice(0, 8)));
    console.log('Derived auth seed (first 8 bytes):', Array.from(authSeed.slice(0, 8)));
    
    // 3. Create Miden account with deterministic seeds using AccountBuilder
    // This ensures both init_seed and auth key are deterministic
    const { AccountBuilder, AccountComponent, AuthSecretKey, AccountType } = await import('@miden-sdk/miden-sdk');
    
    // Create deterministic auth key from auth seed
    // rpoFalconWithRNG is a static method, expects Uint8Array or undefined
    // This creates a deterministic RNG from the 32-byte seed
    const secretKey = AuthSecretKey.rpoFalconWithRNG(new Uint8Array(authSeed));
    const authComponent = AccountComponent.createAuthComponentFromSecretKey(secretKey);
    
    // Create BasicWallet component from MASM code
    // Try to use client.createCodeBuilder() directly (proxy should forward it)
    // If that doesn't work, try createScriptBuilder() as used in Miden playground
    let codeBuilder;
    try {
      if (typeof (client as any).createCodeBuilder === 'function') {
        codeBuilder = (client as any).createCodeBuilder();
      } else if (typeof (client as any).createScriptBuilder === 'function') {
        codeBuilder = (client as any).createScriptBuilder();
      } else {
        throw new Error('Neither createCodeBuilder nor createScriptBuilder is available on client');
      }
    } catch (err: any) {
      throw new Error(`Failed to create code builder: ${err.message}`);
    }
    const basicWalletMasm = `use.miden::native_account
use.miden::output_note

# CONSTANTS
# =================================================================================================
const.PUBLIC_NOTE=1

#! Adds the provided asset to the active account.
#!
#! Inputs:  [ASSET, pad(12)]
#! Outputs: [pad(16)]
#!
#! Where:
#! - ASSET is the asset to be received, can be fungible or non-fungible
#!
#! Panics if:
#! - the same non-fungible asset already exists in the account.
#! - adding a fungible asset would result in amount overflow, i.e.,
#!   the total amount would be greater than 2^63.
#!
#! Invocation: call
export.receive_asset
    exec.native_account::add_asset
    # => [ASSET', pad(12)]

    # drop the final asset
    dropw
    # => [pad(16)]
end

#! Removes the specified asset from the account and adds it to the output note with the specified
#! index.
#!
#! This procedure is expected to be invoked using a \`call\` instruction. It makes no guarantees about
#! the contents of the \`PAD\` elements shown below. It is the caller's responsibility to make sure
#! these elements do not contain any meaningful data.
#!
#! Inputs:  [ASSET, note_idx, pad(11)]
#! Outputs: [ASSET, note_idx, pad(11)]
#!
#! Where:
#! - note_idx is the index of the output note.
#! - ASSET is the fungible or non-fungible asset of interest.
#!
#! Panics if:
#! - the fungible asset is not found in the vault.
#! - the amount of the fungible asset in the vault is less than the amount to be removed.
#! - the non-fungible asset is not found in the vault.
#!
#! Invocation: call
export.move_asset_to_note
    # remove the asset from the account
    exec.native_account::remove_asset
    # => [ASSET, note_idx, pad(11)]

    dupw dup.8 movdn.4
    # => [ASSET, note_idx, ASSET, note_idx, pad(11)]

    exec.output_note::add_asset
    # => [ASSET, note_idx, pad(11)]
end
`;
    
    const basicWalletCode = codeBuilder.compileAccountComponentCode(basicWalletMasm);
    const basicWalletComponent = AccountComponent.compile(basicWalletCode, [])
      .withSupportsAllTypes();

    // Create account with deterministic init_seed and auth key
    const accountBuilder = new AccountBuilder(initSeed);
    const account = accountBuilder
      .accountType(AccountType.RegularAccountUpdatableCode) // mutable
      .storageMode(AccountStorageMode.private())
      .withAuthComponent(authComponent) // Use authComponent created from secretKey
      .withComponent(basicWalletComponent) // Add basic wallet component
      .build().account;
    
    console.log('Created account with AccountBuilder:', account.id().toString());
    console.log('Account ID should be deterministic:', account.id().toString());
    
    // 3.5. Add secret key to keystore first (required before adding account)
    try {
      console.log('🔄 Adding secret key to keystore...');
      await (client as any).addAccountAuthSecretKeyToWebStore(secretKey);
      console.log('✅ Secret key added to keystore');
    } catch (keyError: any) {
      // If key already exists, that's okay - continue
      const errorMsg = keyError.message || keyError.toString() || '';
      if (errorMsg.includes('already exists') || 
          errorMsg.includes('Key already exists') || 
          errorMsg.includes('ConstraintError') ||
          errorMsg.includes('Failed to insert item into IndexedDB')) {
        console.log('ℹ️ Secret key already exists in keystore or IndexedDB error (likely duplicate), continuing...');
      } else {
        console.error('❌ Failed to add secret key:', keyError);
        throw keyError;
      }
    }
    
    // 3.6. Add account to client (without deploying first)
    // Use overwrite: true to allow re-adding if account already exists
    try {
      console.log('🔄 Adding account to client...');
      await client.newAccount(account, true); // true = overwrite if exists
      console.log('✅ Account added to client');
    } catch (addError: any) {
      // If account is already tracked, that's okay - continue
      if (addError.message && addError.message.includes('already being tracked')) {
        console.log('ℹ️ Account already tracked, continuing...');
      } else {
        console.error('❌ Failed to add account:', addError);
        throw addError;
      }
    }
    
    // 3.7. Deploy account to blockchain (if not already deployed)
    try {
      console.log('🔄 Deploying account to blockchain...');
      // Check if account is already deployed by trying to get it
      try {
        await client.getAccount(account.id());
        console.log('✅ Account already deployed');
      } catch {
        // Account not deployed, deploy it
        await client.newAccount(account, true); // true = deploy to blockchain
        console.log('✅ Account deployed to blockchain successfully');
      }
    } catch (deployError: any) {
      console.error('❌ Failed to deploy account:', deployError);
      // Continue anyway - account can still be used undeployed
      console.warn('⚠️ Account created but not deployed. Some features may not work.');
    }
    
    // 4. Export the account file (for backup)
    const accountFile = await client.exportAccountFile(account.id());
    const accountFileBytes = accountFile.serialize();
    const accountFileBase64 = btoa(String.fromCharCode(...accountFileBytes));
    
    // 5. Encrypt both mnemonic and account file
    const encryptedMnemonic = await encryptMnemonic(mnemonic, userPassword);
    const encryptedAccountFile = await encryptMnemonic(accountFileBase64, userPassword);
    
    // 6. Get address
    const accountIdObj = account.id();
    const address = accountIdObj.toBech32(NetworkId.testnet(), AccountInterface.BasicWallet);
    
    // 7. Create wallet data
    const walletData: AppWalletData = {
      accountId: accountIdObj.toString(),
      encryptedMnemonic,
      encryptedAccountFile,
      createdAt: Date.now(),
      address
    };
    
    // 8. Save to localStorage under extension wallet address
    const allWallets = getAllAppWallets();
    allWallets[extensionWalletAddress] = walletData;
    saveAllAppWallets(allWallets);
    
    console.log(`App wallet created successfully for ${extensionWalletAddress}:`, walletData.accountId);
    
    return { walletData, mnemonic };
  } catch (error) {
    console.error('Failed to create app wallet:', error);
    throw error;
  }
}

/**
 * Restores wallet from mnemonic phrase
 * Works on any device because we use deterministic derivation from mnemonic
 * Same mnemonic always produces the same account (like Miden extension wallet)
 */
export async function restoreAppWallet(
  client: WebClient,
  mnemonic: string,
  userPassword: string,
  extensionWalletAddress?: string // Optional: if provided, saves under this key
): Promise<AppWalletData> {
  try {
    // 1. Validate mnemonic
    if (!validateMnemonic(mnemonic)) {
      throw new Error('Invalid mnemonic phrase');
    }
    
    // 2. Derive seeds deterministically from mnemonic (same as creation)
    const initSeed = mnemonicToSeed(mnemonic);
    const authSeed = mnemonicToAuthSeed(mnemonic);
    
    console.log('Restoring with init seed (first 8 bytes):', Array.from(initSeed.slice(0, 8)));
    console.log('Restoring with auth seed (first 8 bytes):', Array.from(authSeed.slice(0, 8)));
    
    // 3. Recreate the account with the same seeds using AccountBuilder
    const { AccountBuilder, AccountComponent, AuthSecretKey, AccountType } = await import('@miden-sdk/miden-sdk');
    
    // Create deterministic auth key from auth seed (same as creation)
    // rpoFalconWithRNG is a static method, expects Uint8Array or undefined
    // This creates a deterministic RNG from the 32-byte seed
    const secretKey = AuthSecretKey.rpoFalconWithRNG(new Uint8Array(authSeed));
    const authComponent = AccountComponent.createAuthComponentFromSecretKey(secretKey);
    
    // Create BasicWallet component from MASM code (same as creation)
    // Try to use client.createCodeBuilder() directly (proxy should forward it)
    // If that doesn't work, try createScriptBuilder() as used in Miden playground
    let codeBuilder;
    try {
      if (typeof (client as any).createCodeBuilder === 'function') {
        codeBuilder = (client as any).createCodeBuilder();
      } else if (typeof (client as any).createScriptBuilder === 'function') {
        codeBuilder = (client as any).createScriptBuilder();
      } else {
        throw new Error('Neither createCodeBuilder nor createScriptBuilder is available on client');
      }
    } catch (err: any) {
      throw new Error(`Failed to create code builder: ${err.message}`);
    }
    const basicWalletMasm = `use.miden::native_account
use.miden::output_note

# CONSTANTS
# =================================================================================================
const.PUBLIC_NOTE=1

#! Adds the provided asset to the active account.
#!
#! Inputs:  [ASSET, pad(12)]
#! Outputs: [pad(16)]
#!
#! Where:
#! - ASSET is the asset to be received, can be fungible or non-fungible
#!
#! Panics if:
#! - the same non-fungible asset already exists in the account.
#! - adding a fungible asset would result in amount overflow, i.e.,
#!   the total amount would be greater than 2^63.
#!
#! Invocation: call
export.receive_asset
    exec.native_account::add_asset
    # => [ASSET', pad(12)]

    # drop the final asset
    dropw
    # => [pad(16)]
end

#! Removes the specified asset from the account and adds it to the output note with the specified
#! index.
#!
#! This procedure is expected to be invoked using a \`call\` instruction. It makes no guarantees about
#! the contents of the \`PAD\` elements shown below. It is the caller's responsibility to make sure
#! these elements do not contain any meaningful data.
#!
#! Inputs:  [ASSET, note_idx, pad(11)]
#! Outputs: [ASSET, note_idx, pad(11)]
#!
#! Where:
#! - note_idx is the index of the output note.
#! - ASSET is the fungible or non-fungible asset of interest.
#!
#! Panics if:
#! - the fungible asset is not found in the vault.
#! - the amount of the fungible asset in the vault is less than the amount to be removed.
#! - the non-fungible asset is not found in the vault.
#!
#! Invocation: call
export.move_asset_to_note
    # remove the asset from the account
    exec.native_account::remove_asset
    # => [ASSET, note_idx, pad(11)]

    dupw dup.8 movdn.4
    # => [ASSET, note_idx, ASSET, note_idx, pad(11)]

    exec.output_note::add_asset
    # => [ASSET, note_idx, pad(11)]
end
`;
    
    const basicWalletCode = codeBuilder.compileAccountComponentCode(basicWalletMasm);
    const basicWalletComponent = AccountComponent.compile(basicWalletCode, [])
      .withSupportsAllTypes();

    // Create account with deterministic init_seed and auth key (same as creation)
    const accountBuilder = new AccountBuilder(initSeed);
    const account = accountBuilder
      .accountType(AccountType.RegularAccountUpdatableCode) // mutable
      .storageMode(AccountStorageMode.private())
      .withAuthComponent(authComponent) // Use authComponent created from secretKey
      .withComponent(basicWalletComponent) // Add basic wallet component
      .build().account;
    
    console.log('Restored account with AccountBuilder:', account.id().toString());
    
    // 3.5. Add secret key to keystore first (required before adding account)
    try {
      console.log('🔄 Adding secret key to keystore...');
      await (client as any).addAccountAuthSecretKeyToWebStore(secretKey);
      console.log('✅ Secret key added to keystore');
    } catch (keyError: any) {
      // If key already exists, that's okay - continue
      const errorMsg = keyError.message || keyError.toString() || '';
      if (errorMsg.includes('already exists') || 
          errorMsg.includes('Key already exists') || 
          errorMsg.includes('ConstraintError') ||
          errorMsg.includes('Failed to insert item into IndexedDB')) {
        console.log('ℹ️ Secret key already exists in keystore or IndexedDB error (likely duplicate), continuing...');
      } else {
        console.error('❌ Failed to add secret key:', keyError);
        throw keyError;
      }
    }
    
    // 3.6. Add account to client
    // Use overwrite: true to allow re-adding if account already exists
    try {
      console.log('🔄 Adding account to client...');
      await client.newAccount(account, true); // true = overwrite if exists
      console.log('✅ Account added to client');
    } catch (addError: any) {
      // If account is already tracked, that's okay - continue
      if (addError.message && addError.message.includes('already being tracked')) {
        console.log('ℹ️ Account already tracked, continuing...');
      } else {
        console.error('❌ Failed to add account:', addError);
        throw addError;
      }
    }
    
    // 4. Export the account file (for future backups)
    const accountFile = await client.exportAccountFile(account.id());
    const accountFileBytes = accountFile.serialize();
    const accountFileBase64 = btoa(String.fromCharCode(...accountFileBytes));
    
    // 5. Encrypt both mnemonic and account file
    const encryptedMnemonic = await encryptMnemonic(mnemonic, userPassword);
    const encryptedAccountFile = await encryptMnemonic(accountFileBase64, userPassword);
    
    // 6. Get address
    const accountIdObj = account.id();
    const address = accountIdObj.toBech32(NetworkId.testnet(), AccountInterface.BasicWallet);
    
    // 7. Create wallet data
    const walletData: AppWalletData = {
      accountId: accountIdObj.toString(),
      encryptedMnemonic,
      encryptedAccountFile,
      createdAt: Date.now(),
      address
    };
    
    // 8. Save to localStorage
    // If extension wallet address provided, save under that key
    // Otherwise, save under account ID (for standalone restore)
    const allWallets = getAllAppWallets();
    const storageKey = extensionWalletAddress || walletData.accountId;
    allWallets[storageKey] = walletData;
    saveAllAppWallets(allWallets);
    
    console.log(`App wallet restored successfully from mnemonic. Account ID:`, walletData.accountId);
    
    return walletData;
  } catch (error) {
    console.error('Failed to restore app wallet:', error);
    throw error;
  }
}

/**
 * Exports the mnemonic phrase for a specific extension wallet (requires password)
 */
export async function exportMnemonic(userPassword: string, extensionWalletAddress: string): Promise<string> {
  try {
    const allWallets = getAllAppWallets();
    const walletData = allWallets[extensionWalletAddress];
    if (!walletData) {
      throw new Error(`No app wallet found for ${extensionWalletAddress}`);
    }
    
    const mnemonic = await decryptMnemonic(walletData.encryptedMnemonic, userPassword);
    
    return mnemonic;
  } catch (error) {
    console.error('Failed to export mnemonic:', error);
    throw error;
  }
}

/**
 * Gets the app wallet data for a specific extension wallet (without mnemonic)
 */
export function getAppWalletData(extensionWalletAddress: string): AppWalletData | null {
  try {
    const allWallets = getAllAppWallets();
    return allWallets[extensionWalletAddress] || null;
  } catch (error) {
    console.error('Failed to get app wallet data:', error);
    return null;
  }
}

/**
 * Checks if an app wallet exists for a specific extension wallet
 */
export function hasAppWallet(extensionWalletAddress: string): boolean {
  const allWallets = getAllAppWallets();
  return !!allWallets[extensionWalletAddress];
}

/**
 * Deletes the app wallet for a specific extension wallet (requires password confirmation)
 */
export async function deleteAppWallet(userPassword: string, extensionWalletAddress: string): Promise<void> {
  try {
    // Verify password before deletion
    await exportMnemonic(userPassword, extensionWalletAddress);
    
    const allWallets = getAllAppWallets();
    delete allWallets[extensionWalletAddress];
    saveAllAppWallets(allWallets);
    
    console.log(`App wallet deleted for ${extensionWalletAddress}`);
  } catch (error) {
    console.error('Failed to delete app wallet:', error);
    throw new Error('Wrong password or wallet not found');
  }
}

/**
 * Gets the account ID from the stored wallet for a specific extension wallet
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function getAppWalletAccountId(_client: WebClient, extensionWalletAddress: string): Promise<AccountId | null> {
  try {
    const walletData = getAppWalletData(extensionWalletAddress);
    if (!walletData) {
      return null;
    }
    
    return AccountId.fromHex(walletData.accountId);
  } catch (error) {
    console.error('Failed to get app wallet account ID:', error);
    return null;
  }
}
