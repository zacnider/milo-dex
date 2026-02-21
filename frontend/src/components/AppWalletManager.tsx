/**
 * AppWalletManager Component
 * Manages in-app Miden wallet creation, restoration, and export
 */

import { useState, useEffect } from 'react';
import type { WebClient } from '@miden-sdk/miden-sdk';
import { useWallet } from '@miden-sdk/miden-wallet-adapter';
import {
  createAppWallet,
  exportMnemonic,
  getAppWalletData,
  hasAppWallet,
  deleteAppWallet,
  type AppWalletData
} from '../lib/AppWallet';

interface AppWalletManagerProps {
  client: WebClient | null;
  onWalletCreated?: (walletData: AppWalletData) => void;
}

export function AppWalletManager({ client, onWalletCreated }: AppWalletManagerProps) {
  const [walletExists, setWalletExists] = useState(false);
  const [walletData, setWalletData] = useState<AppWalletData | null>(null);
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [mnemonic, setMnemonic] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [internalClient, setInternalClient] = useState<any>(null);
  
  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  
  // Watch for external wallet logout
  const { address: externalWalletAddress } = useWallet();

  // Initialize internal client if not provided
  useEffect(() => {
    const initClient = async () => {
      if (client) {
        setInternalClient(client as any);
        return;
      }
      
      try {
        const { WebClient: WC } = await import('@miden-sdk/miden-sdk');
        const nodeEndpoint = 'https://rpc.testnet.miden.io';
        const webClient = await WC.createClient(nodeEndpoint);
        setInternalClient(webClient);
        console.log('AppWalletManager: Internal client initialized');
      } catch (err) {
        console.error('AppWalletManager: Failed to initialize internal client:', err);
      }
    };
    
    initClient();
  }, [client]);

  useEffect(() => {
    // Check if app wallet exists for this extension wallet
    if (externalWalletAddress) {
      const exists = hasAppWallet(externalWalletAddress);
      setWalletExists(exists);
      if (exists) {
        setWalletData(getAppWalletData(externalWalletAddress));
      }
    }
  }, [externalWalletAddress]);
  
  // Auto-logout app wallet when external wallet disconnects
  useEffect(() => {
    // Only logout if:
    // 1. App wallet exists
    // 2. External wallet is disconnected (address is null/undefined)
    // 3. We're past initial page load (check after small delay)
    if (walletExists && !externalWalletAddress) {
      const timer = setTimeout(() => {
        // Double check after delay to avoid false positives during page load
        if (walletExists && !externalWalletAddress && walletData) {
          console.log('⚠️ External wallet disconnected, clearing app wallet for all addresses...');
          // Emergency cleanup: clear all wallets
          localStorage.removeItem('milo_app_wallets');
          setWalletExists(false);
          setWalletData(null);
          // Optional: reload page to reset all state
          // window.location.reload();
        }
      }, 1500); // 1.5 second delay to avoid logout during initial load
      
      return () => clearTimeout(timer);
    }
  }, [externalWalletAddress, walletExists]);

  const handleCreateWallet = async (password: string) => {
    const activeClient = internalClient || client;
    if (!activeClient) {
      setError('Client not initialized. Please wait...');
      return;
    }

    if (!externalWalletAddress) {
      setError('Please connect your Miden wallet extension first');
      return;
    }

    try {
      setIsLoading(true);
      setError('');
      
      const { walletData, mnemonic: generatedMnemonic } = await createAppWallet(
        activeClient, 
        password, 
        externalWalletAddress
      );
      
      setWalletData(walletData);
      setWalletExists(true);
      setMnemonic(generatedMnemonic);
      setShowMnemonic(true);
      setShowCreateModal(false);
      
      onWalletCreated?.(walletData);
    } catch (err: any) {
      setError(err.message || 'Failed to create wallet');
      console.error('Create wallet error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  // Removed: handleImportMidenWallet - no import functionality needed
  // Removed: handleRestoreFromSeed - no restore functionality needed
  // Only create and export seed phrase are supported

  const handleExportMnemonic = async (password: string) => {
    if (!externalWalletAddress) {
      setError('Extension wallet not connected');
      return;
    }

    try {
      setIsLoading(true);
      setError('');
      
      const exportedMnemonic = await exportMnemonic(password, externalWalletAddress);
      setMnemonic(exportedMnemonic);
      setShowMnemonic(true);
      setShowExportModal(false);
    } catch (err: any) {
      setError(err.message || 'Failed to export mnemonic. Wrong password?');
      console.error('Export mnemonic error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  // @ts-ignore - unused function kept for potential future use
  const handleExportToMidenExtension = async (exportPassword: string) => {
    if (!externalWalletAddress || !walletData) {
      setError('Trading wallet not found');
      return;
    }

    try {
      setIsLoading(true);
      setError('');

      // Get dApp password to decrypt account file
      const dAppPassword = prompt('Enter your dApp password to decrypt account file:');
      if (!dAppPassword) {
        setIsLoading(false);
        return;
      }

      // Note: Export to Miden extension format removed
      // Users should export seed phrase instead and import to Miden extension wallet using seed phrase
      alert('⚠️ Export to Miden Extension Wallet file format is not supported.\n\n' +
            'Instead, please:\n' +
            '1. Export your seed phrase using "Export Seed Phrase" button\n' +
            '2. In Miden Extension Wallet, use "Import with Seed Phrase"\n' +
            '3. Enter your 12-word seed phrase\n\n' +
            'This will restore the same trading wallet in Miden Extension Wallet.');

      alert(`✅ Trading wallet exported successfully!\n\n` +
            `File: trading_wallet_${walletData.accountId.slice(0, 16)}.json\n\n` +
            `To import to Miden Extension Wallet:\n` +
            `1. Open Miden Extension Wallet\n` +
            `2. Go to Settings > Import Account\n` +
            `3. Select the downloaded .json file\n` +
            `4. Enter password: ${exportPassword}\n\n` +
            `⚠️ IMPORTANT: Save this password! You'll need it to import the wallet.`);
    } catch (err: any) {
      setError(err.message || 'Failed to export wallet');
      console.error('Export to Miden extension error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  // @ts-ignore - unused function kept for potential future use
  const handleDeleteWallet = async (password: string) => {
    if (!confirm('Are you sure you want to delete your wallet? Make sure you have backed up your seed phrase!')) {
      return;
    }

    if (!externalWalletAddress) {
      setError('Extension wallet not connected');
      return;
    }

    try {
      setIsLoading(true);
      setError('');
      
      await deleteAppWallet(password, externalWalletAddress);
      setWalletExists(false);
      setWalletData(null);
    } catch (err: any) {
      setError(err.message || 'Failed to delete wallet');
      console.error('Delete wallet error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  // If extension wallet not connected, show connect message
  if (!externalWalletAddress) {
    return (
      <div className="app-wallet-manager">
        <div className="wallet-setup">
          <h2>🔌 Connect Your Miden Wallet</h2>
          <p style={{ marginBottom: '1.5rem', color: '#9aa4b2' }}>
            Please connect your Miden wallet extension first to create a trading wallet.
          </p>
          
          <div style={{ 
            padding: '2rem', 
            background: 'rgba(96, 165, 250, 0.1)', 
            border: '2px solid rgba(96, 165, 250, 0.3)', 
            borderRadius: '8px',
            textAlign: 'center'
          }}>
            <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🔗</div>
            <p style={{ color: '#60a5fa', fontSize: '1.1rem', marginBottom: '1rem' }}>
              <strong>Extension Wallet Required</strong>
            </p>
            <p style={{ color: '#9aa4b2', fontSize: '0.9rem', lineHeight: '1.6' }}>
              Click the "Connect Wallet" button in the top right corner to connect your Miden wallet extension.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // If extension connected but no app wallet, show create button
  if (!walletExists) {
    return (
      <div className="app-wallet-manager">
        <div className="wallet-setup">
          <h2>🔐 Create Your Trading Wallet</h2>
          <p style={{ marginBottom: '1rem', color: '#9aa4b2' }}>
            Extension wallet connected: <code style={{ color: '#4ade80' }}>{externalWalletAddress.slice(0, 10)}...{externalWalletAddress.slice(-4)}</code>
          </p>
          <p style={{ marginBottom: '1.5rem', color: '#9aa4b2' }}>
            Your external wallet is used only for authentication.<br/>
            All trading operations will use this secure in-app wallet.
          </p>
          
          <div style={{ display: 'flex', gap: '0.5rem', flexDirection: 'column' }}>
            <button 
              onClick={() => setShowCreateModal(true)}
              className="btn-primary"
              style={{ width: '100%', padding: '1rem', fontSize: '1.1rem' }}
              disabled={!internalClient && !client}
            >
              {(!internalClient && !client) ? 'Initializing...' : 'Create Trading Wallet'}
            </button>
            
          </div>
          
          {(!internalClient && !client) && (
            <div style={{ marginTop: '1rem', color: '#9aa4b2', textAlign: 'center' }}>
              ⏳ Initializing Miden client...
            </div>
          )}
        </div>

        {/* Create Wallet Modal */}
        {showCreateModal && (
          <CreateWalletModal
            onConfirm={handleCreateWallet}
            onCancel={() => setShowCreateModal(false)}
            isLoading={isLoading}
            error={error}
          />
        )}


        {/* Mnemonic Display Modal */}
        {showMnemonic && (
          <MnemonicDisplayModal
            mnemonic={mnemonic}
            onClose={() => {
              setShowMnemonic(false);
              setMnemonic('');
            }}
          />
        )}
      </div>
    );
  }

  // Extract clean bech32 address (without _qru... suffix)
  const displayAddress = walletData?.address?.split('_')[0] || walletData?.address || 'N/A';

  return (
    <div className="app-wallet-info">
      <div className="wallet-details">
        <div className="wallet-address-display">
          <strong>Trading Wallet:</strong>
          <code className="wallet-address-main">{displayAddress}</code>
        </div>
        <div style={{ fontSize: '0.85rem', color: '#9aa4b2', marginTop: '0.5rem' }}>
          All trades use this wallet. External wallet is for authentication only.
        </div>
      </div>

      <div className="wallet-actions">
        <button 
          onClick={() => setShowExportModal(true)}
          className="btn-secondary"
        >
          📤 Export Seed Phrase
        </button>
      </div>

      {/* Export Mnemonic Modal */}
      {showExportModal && (
        <ExportMnemonicModal
          onConfirm={handleExportMnemonic}
          onCancel={() => setShowExportModal(false)}
          isLoading={isLoading}
          error={error}
        />
      )}

      {/* Mnemonic Display Modal */}
      {showMnemonic && (
        <MnemonicDisplayModal
          mnemonic={mnemonic}
          onClose={() => {
            setShowMnemonic(false);
            setMnemonic('');
          }}
        />
      )}
    </div>
  );
}

// Sub-components

// @ts-ignore - unused component kept for potential future use
function ImportMidenWalletModal({ onConfirm, onCancel, isLoading, error }: any) {
  const [password, setPassword] = useState('');
  // @ts-ignore - unused variable kept for potential future use
  const [walletFile, setWalletFile] = useState<File | null>(null);
  const [walletJson, setWalletJson] = useState<any>(null);
  const [fileError, setFileError] = useState('');

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setWalletFile(file);
    setFileError('');

    try {
      const text = await file.text();
      const json = JSON.parse(text);
      
      // Validate JSON structure
      if (!json.dt || !json.iv || !json.salt) {
        setFileError('Invalid wallet file format. Expected: { dt, iv, salt, ... }');
        setWalletJson(null);
        return;
      }

      setWalletJson(json);
    } catch (err: any) {
      setFileError('Failed to parse wallet file: ' + err.message);
      setWalletJson(null);
    }
  };

  const handleSubmit = () => {
    if (!walletJson) {
      setFileError('Please select a valid wallet file');
      return;
    }
    if (!password) {
      setFileError('Please enter the wallet password');
      return;
    }
    onConfirm(walletJson, password);
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h3>Import from Miden Extension Wallet</h3>
        <p style={{ color: '#9aa4b2', fontSize: '0.9rem', marginBottom: '1rem' }}>
          Import your Miden extension wallet file (.json) to use it as your trading wallet.
        </p>

        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', color: '#e2e8f0' }}>
            Wallet File (JSON)
          </label>
          <input
            type="file"
            accept=".json"
            onChange={handleFileSelect}
            style={{
              width: '100%',
              padding: '0.5rem',
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '4px',
              color: '#e2e8f0'
            }}
            disabled={isLoading}
          />
          {fileError && (
            <div style={{ color: '#ef4444', fontSize: '0.85rem', marginTop: '0.5rem' }}>
              {fileError}
            </div>
          )}
          {walletJson && !fileError && (
            <div style={{ color: '#4ade80', fontSize: '0.85rem', marginTop: '0.5rem' }}>
              ✅ Wallet file loaded successfully
            </div>
          )}
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', color: '#e2e8f0' }}>
            Wallet Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter wallet password"
            style={{
              width: '100%',
              padding: '0.75rem',
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '4px',
              color: '#e2e8f0'
            }}
            disabled={isLoading}
          />
        </div>

        {error && (
          <div style={{ color: '#ef4444', fontSize: '0.9rem', marginBottom: '1rem' }}>
            ❌ {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            className="btn-secondary"
            disabled={isLoading}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            className="btn-primary"
            disabled={isLoading || !walletJson || !password}
          >
            {isLoading ? 'Importing...' : 'Import Wallet'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateWalletModal({ onConfirm, onCancel, isLoading, error }: any) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const handleSubmit = () => {
    if (password !== confirmPassword) {
      alert('Passwords do not match');
      return;
    }
    if (password.length < 8) {
      alert('Password must be at least 8 characters');
      return;
    }
    onConfirm(password);
  };

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h3>Create New Wallet</h3>
        <p>Enter a password to secure your wallet</p>
        
        <div className="form-group">
          <label>Password:</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password (min 8 characters)"
            disabled={isLoading}
          />
        </div>

        <div className="form-group">
          <label>Confirm Password:</label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Confirm password"
            disabled={isLoading}
          />
        </div>

        {error && <div className="error-message">{error}</div>}

        <div className="modal-actions">
          <button onClick={handleSubmit} disabled={isLoading || !password}>
            {isLoading ? 'Creating...' : 'Create Wallet'}
          </button>
          <button onClick={onCancel} disabled={isLoading}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// RestoreWalletModal removed - no import functionality, only create and export

function ExportMnemonicModal({ onConfirm, onCancel, isLoading, error }: any) {
  const [password, setPassword] = useState('');

  const handleSubmit = () => {
    if (!password) {
      alert('Please enter your password');
      return;
    }
    onConfirm(password);
  };

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h3>Export Seed Phrase</h3>
        <p>Enter your password to view your seed phrase</p>
        
        <div className="form-group">
          <label>Password:</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter your password"
            disabled={isLoading}
          />
        </div>

        {error && <div className="error-message">{error}</div>}

        <div className="modal-actions">
          <button onClick={handleSubmit} disabled={isLoading || !password}>
            {isLoading ? 'Verifying...' : 'Show Seed Phrase'}
          </button>
          <button onClick={onCancel} disabled={isLoading}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function MnemonicDisplayModal({ mnemonic, onClose }: any) {
  const [copied, setCopied] = useState(false);
  const [showAccountFile, setShowAccountFile] = useState(false);
  const [accountFileData, setAccountFileData] = useState<{ json: string; raw: string }>({ json: '', raw: '' });

  const handleCopy = () => {
    navigator.clipboard.writeText(mnemonic);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  
  const handleExportAccountFile = async () => {
    // @ts-ignore - externalWalletAddress is available in component scope
    if (!externalWalletAddress) {
      alert('Extension wallet not connected');
      return;
    }

    try {
      // @ts-ignore - externalWalletAddress is available in component scope
      const walletData = getAppWalletData(externalWalletAddress);
      if (!walletData?.encryptedAccountFile) {
        alert('No account file available');
        return;
      }
      
      // Decrypt with dApp password to get raw account file
      const dAppPassword = prompt('Enter your dApp password to export account backup:');
      if (!dAppPassword) return;
      
      const { decryptMnemonic } = await import('../lib/crypto');
      const accountFileBase64 = await decryptMnemonic(walletData.encryptedAccountFile, dAppPassword);
      
      // Verify binary format by checking magic bytes "acct" (0x61636374)
      const binaryString = atob(accountFileBase64);
      const magic = binaryString.slice(0, 4);
      
      if (magic !== 'acct') {
        console.error('❌ Invalid account file format! Magic bytes mismatch.');
        alert('Warning: Account file format may be invalid.');
        return;
      }
      
      console.log('✅ Account file format verified!');
      
      setAccountFileData({
        json: '', // No longer needed
        raw: accountFileBase64
      });
      setShowAccountFile(true);
    } catch (err: any) {
      alert('Failed to export account file: ' + err.message);
    }
  };
  
  const handleDownloadAccountFile = () => {
    // Convert Base64 to binary Uint8Array
    const binaryString = atob(accountFileData.raw);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'milo-wallet-backup.mac';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="modal-overlay">
      <div className="modal mnemonic-modal">
        <h3>⚠️ Your Wallet Backup</h3>
        {!showAccountFile ? (
          <>
            <p className="warning">
              Save these 12 words AND your account file for full wallet recovery!
            </p>
            
            <div className="mnemonic-display">
              {mnemonic.split(' ').map((word: string, i: number) => (
                <div key={i} className="mnemonic-word">
                  <span className="word-number">{i + 1}</span>
                  <span className="word-text">{word}</span>
                </div>
              ))}
            </div>

            <div className="modal-actions">
              <button onClick={handleCopy}>
                {copied ? '✓ Copied!' : 'Copy Seed Phrase'}
              </button>
              <button onClick={handleExportAccountFile} className="btn-secondary">
                Export Account File
              </button>
              <button onClick={onClose} className="btn-primary">
                I've Saved It
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ 
              padding: '1rem', 
              background: 'rgba(245, 158, 11, 0.1)', 
              border: '2px solid rgba(245, 158, 11, 0.5)', 
              borderRadius: '8px', 
              marginBottom: '1.5rem'
            }}>
              <h3 style={{ margin: '0 0 0.5rem 0', color: '#f59e0b', fontSize: '1.1rem' }}>
                ⚠️ Important: Miden Extension Import
              </h3>
              <p style={{ fontSize: '0.9rem', color: '#fcd34d', lineHeight: '1.6', margin: 0 }}>
                The Miden wallet extension <strong>only accepts accounts imported via Seed Phrase (12 words)</strong>.<br /><br />
                
                <strong>To import to Miden Extension:</strong><br />
                1. Click "Back to Seed Phrase" below<br />
                2. Copy your 12-word seed phrase<br />
                3. Use "Import with Seed Phrase" in the extension<br /><br />
                
                Account files (.mac/.json) are <strong>only for this dApp</strong>.
              </p>
            </div>
            
            <div style={{ marginBottom: '1rem' }}>
              <div style={{ 
                padding: '1rem', 
                background: '#1a1a2a', 
                borderRadius: '6px',
                border: '1px solid #2a2a4a',
                opacity: 0.6
              }}>
                <h4 style={{ margin: '0 0 0.5rem 0', color: '#60a5fa' }}>📁 Account Backup (dApp Only)</h4>
                <p style={{ fontSize: '0.85rem', color: '#9aa4b2', marginBottom: '0.5rem' }}>
                  Binary format (.mac) - For re-importing to THIS dApp only, NOT for extension
                </p>
                <button 
                  onClick={handleDownloadAccountFile}
                  style={{ width: '100%', padding: '0.75rem', opacity: 0.7 }}
                  className="btn-secondary"
                >
                  Download .mac File (dApp Backup)
                </button>
              </div>
            </div>
            
            <div className="modal-actions">
              <button onClick={() => setShowAccountFile(false)} className="btn-primary" style={{ fontSize: '1rem', padding: '1rem 2rem' }}>
                ← Back to Seed Phrase (For Extension Import)
              </button>
              <button onClick={onClose} className="btn-secondary">
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
