import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  MidenWalletAdapter,
  WalletModalProvider,
  WalletMultiButton,
  WalletProvider,
  useWallet,
  TransactionType,
  CustomTransaction,
} from '@miden-sdk/miden-wallet-adapter';
import '@miden-sdk/miden-wallet-adapter-reactui/styles.css';
import './App.css';
import { getTokenMetadata, getTokenBySymbol } from './tokenRegistry';
import { requestTokens, getNoteFromFaucet } from './faucetClient';
import Pools from './pages/Pools';
import Faucet from './pages/Faucet';
import Trade from './pages/Trade';
import Portfolio from './pages/Portfolio';
import Home from './pages/Home';
import { useSwap } from './hooks/useSwap';
import { AccountId } from '@miden-sdk/miden-sdk';

const EXPLORER_URL = 'https://testnet.midenscan.com';

type TabKey = 'balances' | 'orders' | 'history' | 'notes';
type NoteTabKey = 'incoming' | 'pending' | 'spent';
type OrderType = 'limit' | 'market';
type PrivacyMode = 'public' | 'private';
type PageKey = 'home' | 'trade' | 'pools' | 'portfolio' | 'faucet';
type BalanceRow = { asset: string; total: string; available: string };
type NoteRow = { id: string; asset: string; amount: string; status: string };

const formatAmount = (amount: string, decimals: number | null) => {
  if (decimals == null) {
    return amount;
  }
  const raw = amount.replace('-', '');
  const padded = raw.padStart(decimals + 1, '0');
  const integer = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  const sign = amount.startsWith('-') ? '-' : '';
  return fraction ? `${sign}${integer}.${fraction}` : `${sign}${integer}`;
};

const formatAssetLabel = (faucetId: string) => {
  if (faucetId.length <= 10) {
    return faucetId;
  }
  return `${faucetId.slice(0, 6)}…${faucetId.slice(-4)}`;
};

const getAddressPart = (address: string) => {
  const [addressPart = ''] = address.split('_');
  return addressPart;
};

const resolveTokenMeta = (faucetIdObj: any, amountStr?: string) => {
  // AccountId.toString() returns hex format, normalize it
  let faucetId = faucetIdObj.toString();
  
  // Ensure 0x prefix for hex comparison
  if (!faucetId.startsWith('0x') && faucetId.length > 0) {
    faucetId = `0x${faucetId}`;
  }
  
  // Try to get metadata with normalized hex
  let registry = getTokenMetadata(faucetId);
  
  // If not found, try without 0x prefix
  if (!registry && faucetId.startsWith('0x')) {
    registry = getTokenMetadata(faucetId.slice(2));
  }
  
  if (registry) {
    return { symbol: registry.symbol, decimals: registry.decimals };
  }
  
  // Check if it's a network account (MIDEN)
  if (typeof faucetIdObj.isNetwork === 'function' && faucetIdObj.isNetwork()) {
    return { symbol: 'MIDEN', decimals: 6 };
  }
  
  // Try to infer MIDEN from amount (6 decimals)
  if (amountStr) {
    try {
      const amount = BigInt(amountStr);
      if (amount % 1_000_000n === 0n && amount % 100_000_000n !== 0n) {
        return { symbol: 'MIDEN', decimals: 6 };
      }
    } catch {
      // ignore parse errors
    }
  }
  
  // Fallback: show truncated faucet ID
  return { symbol: formatAssetLabel(faucetId), decimals: null };
};

// MARKETS will be computed dynamically from pool reserves
const getMarkets = (poolReserves: Record<string, { reserveA: bigint; reserveB: bigint }>) => {
  const markets = [];
  
  // MILO/MUSDC market
  const miloMusdcReserves = poolReserves['MILO/MUSDC'];
  if (miloMusdcReserves && miloMusdcReserves.reserveA > BigInt(0) && miloMusdcReserves.reserveB > BigInt(0)) {
    const reserveA = Number(miloMusdcReserves.reserveA);
    const reserveB = Number(miloMusdcReserves.reserveB);
    const price = reserveB / reserveA;
    const priceFormatted = price.toFixed(8);
    markets.push({
      pair: 'MILO/MUSDC',
      last: priceFormatted,
      change: '+0.0%',
      vol: '0',
    });
  } else {
    markets.push({
      pair: 'MILO/MUSDC',
      last: '0.00000000',
      change: '+0.0%',
      vol: '0',
    });
  }
  
  // MELO/MUSDC market
  const meloMusdcReserves = poolReserves['MELO/MUSDC'];
  if (meloMusdcReserves && meloMusdcReserves.reserveA > BigInt(0) && meloMusdcReserves.reserveB > BigInt(0)) {
    const reserveA = Number(meloMusdcReserves.reserveA);
    const reserveB = Number(meloMusdcReserves.reserveB);
    const price = reserveB / reserveA;
    const priceFormatted = price.toFixed(8);
    markets.push({
      pair: 'MELO/MUSDC',
      last: priceFormatted,
      change: '+0.0%',
      vol: '0',
    });
  } else {
    markets.push({
      pair: 'MELO/MUSDC',
      last: '0.00000000',
      change: '+0.0%',
      vol: '0',
    });
  }
  
  return markets;
};

// WASM Object Management Helpers
// These functions ensure WASM objects are properly freed after use

interface WasmObject {
  free?: () => void;
}

function safeFree(obj: WasmObject | null | undefined): void {
  if (obj && typeof obj.free === 'function') {
    try {
      obj.free();
    } catch (e) {
      // Ignore errors during cleanup
    }
  }
}

function safeFreeArray(items: (WasmObject | null | undefined)[]): void {
  for (const item of items) {
    safeFree(item);
  }
}

function safeGetFaucetIdHex(asset: any): string {
  try {
    const id = asset.faucetId();
    const hex = id.toString().toLowerCase();
    safeFree(id);
    return hex;
  } catch {
    return '';
  }
}

function TerminalApp() {
  const { address, connected, wallet, requestTransaction } = useWallet();
  
  // Initialize currentPage from URL hash
  const getPageFromHash = (): PageKey => {
    const hash = window.location.hash.slice(1);
    const page = hash.startsWith('/') ? hash.slice(1) : hash;
    if (page === 'pools' || page === 'trade' || page === 'portfolio' || page === 'faucet') {
      return page as PageKey;
    }
    return 'home';
  };
  
  const [currentPage, setCurrentPage] = useState<PageKey>(getPageFromHash());
  const [accountId, setAccountId] = useState<string | null>(null);
  const [account, setAccount] = useState<any | null>(null);
  const [client, setClient] = useState<any | null>(null);
  
  // Update page when hash changes
  useEffect(() => {
    const handleHashChange = () => {
      setCurrentPage(getPageFromHash());
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  // Debug: Log wallet state
  useEffect(() => {
    const walletState = {
      connected,
      address: address || 'null',
      accountId: accountId || 'null',
      hasClient: !!client,
      hasAccount: !!account
    };
    console.log('📊 Wallet state:', JSON.stringify(walletState, null, 2));
  }, [connected, address, accountId, client, account]);

  const [marketSearch, setMarketSearch] = useState('');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [activeMarket, setActiveMarket] = useState('MILO/MUSDC');
  const [timeframe, setTimeframe] = useState('1H');
  const [chartTab, setChartTab] = useState<'trades' | 'depth'>('trades');
  const [orderType, setOrderType] = useState<OrderType>('market');
  const [privacyMode, setPrivacyMode] = useState<PrivacyMode>('public');
  const [swapAmountIn, setSwapAmountIn] = useState<string>('');
  const [swapAmountOut, setSwapAmountOut] = useState<string>('');
  const [slippageTolerance, setSlippageTolerance] = useState<number>(0.5);
  const [swapReversed, setSwapReversed] = useState<boolean>(false);
  const [poolReserves, setPoolReserves] = useState<Record<string, { reserveA: bigint; reserveB: bigint }>>({});
  const [userBalances, setUserBalances] = useState<Record<string, bigint>>(() => {
    const initialBalances: Record<string, bigint> = {};
    const miloToken = getTokenBySymbol('MILO');
    const meloToken = getTokenBySymbol('MELO');
    const musdcToken = getTokenBySymbol('MUSDC');
    const midenToken = getTokenBySymbol('MIDEN');
    if (miloToken) initialBalances[miloToken.faucetId.toLowerCase()] = BigInt(0);
    if (meloToken) initialBalances[meloToken.faucetId.toLowerCase()] = BigInt(0);
    if (musdcToken) initialBalances[musdcToken.faucetId.toLowerCase()] = BigInt(0);
    if (midenToken) initialBalances[midenToken.faucetId.toLowerCase()] = BigInt(0);
    return initialBalances;
  });
  const [bottomTab, setBottomTab] = useState<TabKey>('balances');
  const [noteTab, setNoteTab] = useState<NoteTabKey>('incoming');
  const [balances, setBalances] = useState<BalanceRow[]>([]);
  const [notes, setNotes] = useState<Record<NoteTabKey, NoteRow[]>>({
    incoming: [],
    pending: [],
    spent: [],
  });
  const [refreshing, setRefreshing] = useState(false);
  const [faucetAmount, setFaucetAmount] = useState('10');
  const [faucetPrivate, setFaucetPrivate] = useState(false);
  const [faucetStatus, setFaucetStatus] = useState<string | null>(null);
  const [faucetBusy, setFaucetBusy] = useState<string | null>(null);
  const [sendMidenStatus, setSendMidenStatus] = useState<string | null>(null);
  const [sendMidenBusy, setSendMidenBusy] = useState(false);
  const [sendMidenAmount, setSendMidenAmount] = useState('500');
  
  const MIDEN_FAUCET_ID = '0x37d5977a8e16d8205a360820f0230f';
  const clientOpLock = useRef(false);
  const clientOpLockTimeout = useRef<NodeJS.Timeout | null>(null);
  
  // Helper to safely acquire lock with timeout
  const acquireLock = (timeoutMs: number = 30000): boolean => {
    if (clientOpLock.current) {
      return false;
    }
    clientOpLock.current = true;
    
    if (clientOpLockTimeout.current) {
      clearTimeout(clientOpLockTimeout.current);
    }
    clientOpLockTimeout.current = setTimeout(() => {
      console.warn('⚠️ Client operation lock timeout - force releasing');
      clientOpLock.current = false;
      clientOpLockTimeout.current = null;
    }, timeoutMs);
    
    return true;
  };
  
  // Helper to release lock
  const releaseLock = () => {
    clientOpLock.current = false;
    if (clientOpLockTimeout.current) {
      clearTimeout(clientOpLockTimeout.current);
      clientOpLockTimeout.current = null;
    }
  };

  const [skippedNoteIds, setSkippedNoteIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('miloSkippedNotes');
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });

  // Initialize client and account
  useEffect(() => {
    let cancelled = false;
    if (!connected || !address) {
      setAccountId(null);
      setAccount(null);
      setClient(null);
      return;
    }

    (async () => {
      const { WebClient, Address } = await import('@miden-sdk/miden-sdk');
      const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      const endpoints = isDev
        ? ['http://localhost:8085', 'https://rpc.testnet.miden.io']
        : [window.location.origin, 'http://localhost:8085'];

      const dbName = 'miden_client_store';

      // Helper: clear IndexedDB and wait
      const clearDb = async () => {
        try {
          const req = indexedDB.deleteDatabase(dbName);
          await new Promise<void>((resolve) => {
            req.onsuccess = () => { console.log('🗑️ IndexedDB cleared'); resolve(); };
            req.onerror = () => resolve();
            req.onblocked = () => { console.warn('IndexedDB delete blocked'); resolve(); };
          });
          await new Promise((r) => setTimeout(r, 300));
        } catch (e) { /* ignore */ }
      };

      // Helper: try to connect with given endpoints
      const tryConnect = async (): Promise<{ client: any; accountId: any; account: any } | null> => {
        for (const ep of endpoints) {
          try {
            console.log(`🔗 Trying RPC endpoint: ${ep}`);
            const wc = await WebClient.createClient(ep);
            await wc.syncState();
            console.log(`✅ Connected to: ${ep}`);
            const accId = Address.fromBech32(address!).accountId();
            // Import may fail if account not yet deployed on-chain - this is OK
            try {
              await wc.importAccountById(accId);
              console.log('✅ Account imported from network');
            } catch (importErr: any) {
              console.warn('⚠️ Could not import account (may not exist on-chain yet):', importErr?.message);
            }
            let acc = null;
            try {
              acc = await wc.getAccount(accId);
            } catch {
              console.warn('⚠️ Account not found locally, continuing without account state');
            }
            return { client: wc, accountId: accId, account: acc };
          } catch (err: any) {
            console.warn(`⚠️ Failed ${ep}:`, err?.message);
          }
        }
        return null;
      };

      try {
        // First attempt: use existing IndexedDB
        let result = await tryConnect();

        // If failed, clear IndexedDB and retry (handles stale data/schema issues)
        if (!result) {
          console.warn('🔄 First attempt failed, clearing IndexedDB and retrying...');
          await clearDb();
          result = await tryConnect();
        }

        if (!result) {
          throw new Error('Failed to connect to any RPC endpoint');
        }

        if (cancelled) {
          safeFree(result.accountId);
          safeFree(result.account);
          return;
        }

        setClient(result.client);
        setAccount(result.account);
        setAccountId(result.accountId.toString());
        safeFree(result.accountId);
      } catch (storeError: any) {
        if (!cancelled) {
          console.error('Failed to initialize WebClient:', storeError?.message);
          setClient(null);
          setAccount(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connected, address]);

  const consumeNotes = async () => {
    if (!client || !accountId || !requestTransaction) {
      console.warn('⚠️ Cannot consume notes: client, accountId, or wallet not available');
      return 0;
    }
    
    console.log('🔄 Starting note consumption...');
    
    try {
      const { AccountId, TransactionRequestBuilder, NoteAndArgs, NoteAndArgsArray } = await import('@miden-sdk/miden-sdk');
      
      // Sync state first
      await client.syncState();
      
      const accountIdObj = AccountId.fromHex(accountId);
      const consumableNotes = await client.getConsumableNotes(accountIdObj);
      
      if (consumableNotes.length === 0) {
        console.log('📭 No consumable notes found');
        return 0;
      }
      
      console.log(`📋 Found ${consumableNotes.length} consumable note(s)`);
      
      let consumedCount = 0;
      for (const consumable of consumableNotes) {
        try {
          const noteRecord = consumable.inputNoteRecord();
          const noteIdStr = noteRecord.id().toString();
          
          if (noteRecord.isConsumed() || noteRecord.isProcessing()) {
            console.log(`⏭️ Note ${noteIdStr.slice(0, 8)}... already consumed/processing`);
            continue;
          }
          
          // Try to convert note
          let note;
          if (typeof noteRecord.toNote === 'function') {
            note = noteRecord.toNote();
          } else if (typeof noteRecord.toInputNote === 'function') {
            const inputNote = noteRecord.toInputNote();
            note = inputNote?.note?.() || inputNote;
          }
          
          if (!note) {
            console.warn(`⚠️ Could not convert note ${noteIdStr.slice(0, 8)}...`);
            continue;
          }
          
          // Build consume transaction
          const consumeTxBuilder = new TransactionRequestBuilder();
          const noteAndArgs = new NoteAndArgs(note, null);
          const transactionRequest = consumeTxBuilder
            .withInputNotes(new NoteAndArgsArray([noteAndArgs]))
            .build();
          
          console.log(`📤 Consuming note ${noteIdStr.slice(0, 8)}...`);
          
          // Request transaction via extension wallet
          const txId = await requestTransaction({
            type: TransactionType.Custom,
            payload: new CustomTransaction(
              accountId,
              accountId,
              transactionRequest,
              [noteIdStr],
              undefined
            ),
          });
          
          if (txId) {
            consumedCount++;
            console.log(`✅ Consumed note ${noteIdStr.slice(0, 8)}..., tx: ${String(txId).slice(0, 16)}...`);
          }
          
          // Small delay between consumes
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (err: any) {
          console.warn(`⚠️ Failed to consume note: ${err?.message}`);
        }
      }
      
      if (consumedCount > 0) {
        console.log(`✅ Successfully consumed ${consumedCount} note(s)`);
      }
      
      // Final sync
      await client.syncState();
      await refreshAccountData();
      
      return consumedCount;
      
    } catch (error: any) {
      console.error('❌ Error consuming notes:', error);
      return 0;
    }
  };

  // Fetch pool reserves for swap calculations
  useEffect(() => {
    const clientToUse = client;
    if (!clientToUse) return;
    
    const fetchPoolReserves = async () => {
      if (!acquireLock(20000)) {
        return;
      }
      
      const wasmObjectsToFree: WasmObject[] = [];
      
      try {
        await clientToUse.syncState();
        
        const { getMiloMusdcPoolAccountId, getMeloMusdcPoolAccountId } = await import('./config/poolConfig');
        
        const miloToken = getTokenBySymbol('MILO');
        const meloToken = getTokenBySymbol('MELO');
        const musdcToken = getTokenBySymbol('MUSDC');
        
        console.log('🔍 Fetching pool reserves in App.tsx...');
        
        if (miloToken && meloToken && musdcToken) {
          const { AccountId } = await import('@miden-sdk/miden-sdk');
          
          // Get pool account IDs as hex strings
          const miloPoolIdHex = getMiloMusdcPoolAccountId();
          const meloPoolIdHex = getMeloMusdcPoolAccountId();
          
          console.log('  MILO/MUSDC Pool ID:', miloPoolIdHex);
          console.log('  MELO/MUSDC Pool ID:', meloPoolIdHex);
          
          // Import MILO/MUSDC pool
          try {
            const freshMiloPoolId = AccountId.fromHex(miloPoolIdHex);
            await clientToUse.importAccountById(freshMiloPoolId);
            console.log('  ✅ MILO/MUSDC pool imported');
            safeFree(freshMiloPoolId);
          } catch (e) {
            console.log('  ⚠️ MILO/MUSDC pool import skipped (may already exist)');
          }
          
          // Import MELO/MUSDC pool
          try {
            const freshMeloPoolId = AccountId.fromHex(meloPoolIdHex);
            await clientToUse.importAccountById(freshMeloPoolId);
            console.log('  ✅ MELO/MUSDC pool imported');
            safeFree(freshMeloPoolId);
          } catch (e) {
            console.log('  ⚠️ MELO/MUSDC pool import skipped (may already exist)');
          }
          
          let miloReserve = BigInt(0);
          let musdcReserve = BigInt(0);
          
          // Get MILO/MUSDC pool reserves
          try {
            const miloPoolAccountId = AccountId.fromHex(miloPoolIdHex);
            wasmObjectsToFree.push(miloPoolAccountId);
            
            const miloPoolAccount = await clientToUse.getAccount(miloPoolAccountId);
            if (miloPoolAccount) {
              wasmObjectsToFree.push(miloPoolAccount);
              
              const miloVault = miloPoolAccount.vault();
              wasmObjectsToFree.push(miloVault);
              
              const miloFungibleAssets = miloVault.fungibleAssets();
              console.log(`  📊 MILO/MUSDC pool has ${miloFungibleAssets.length} fungible assets`);
              
              for (const asset of miloFungibleAssets) {
                const faucetIdHex = safeGetFaucetIdHex(asset);
                const amount = BigInt(asset.amount());
                const assetTokenMeta = getTokenMetadata(faucetIdHex);
                
                if (assetTokenMeta) {
                  if (assetTokenMeta.symbol === 'MILO') {
                    miloReserve = amount;
                    console.log(`    Found MILO in pool: ${faucetIdHex}, amount: ${amount.toString()}`);
                  } else if (assetTokenMeta.symbol === 'MUSDC') {
                    musdcReserve = amount;
                    console.log(`    Found MUSDC in pool: ${faucetIdHex}, amount: ${amount.toString()}`);
                  }
                } else {
                  const miloFaucetIdHex = miloToken.faucetId.toLowerCase();
                  const musdcFaucetIdHex = musdcToken.faucetId.toLowerCase();
                  if (faucetIdHex === miloFaucetIdHex) {
                    miloReserve = amount;
                  } else if (faucetIdHex === musdcFaucetIdHex) {
                    musdcReserve = amount;
                  }
                }
                
                safeFree(asset);
              }
            }
          } catch (e) {
            console.warn('  ⚠️ Failed to get MILO/MUSDC pool:', e);
          }
          
          let meloReserve = BigInt(0);
          let meloMusdcReserve = BigInt(0);
          
          // Get MELO/MUSDC pool reserves
          try {
            const meloPoolAccountId = AccountId.fromHex(meloPoolIdHex);
            wasmObjectsToFree.push(meloPoolAccountId);
            
            const meloPoolAccount = await clientToUse.getAccount(meloPoolAccountId);
            if (meloPoolAccount) {
              wasmObjectsToFree.push(meloPoolAccount);
              
              const meloVault = meloPoolAccount.vault();
              wasmObjectsToFree.push(meloVault);
              
              const meloFungibleAssets = meloVault.fungibleAssets();
              console.log(`  📊 MELO/MUSDC pool has ${meloFungibleAssets.length} fungible assets`);
              
              for (const asset of meloFungibleAssets) {
                const faucetIdHex = safeGetFaucetIdHex(asset);
                const amount = BigInt(asset.amount());
                const assetTokenMeta = getTokenMetadata(faucetIdHex);
                
                if (assetTokenMeta) {
                  if (assetTokenMeta.symbol === 'MELO') {
                    meloReserve = amount;
                    console.log(`    Found MELO in pool: ${faucetIdHex}, amount: ${amount.toString()}`);
                  } else if (assetTokenMeta.symbol === 'MUSDC') {
                    meloMusdcReserve = amount;
                    console.log(`    Found MUSDC in pool: ${faucetIdHex}, amount: ${amount.toString()}`);
                  }
                } else {
                  const meloFaucetIdHex = meloToken.faucetId.toLowerCase();
                  const musdcFaucetIdHex = musdcToken.faucetId.toLowerCase();
                  if (faucetIdHex === meloFaucetIdHex) {
                    meloReserve = amount;
                  } else if (faucetIdHex === musdcFaucetIdHex) {
                    meloMusdcReserve = amount;
                  }
                }
                
                safeFree(asset);
              }
            }
          } catch (e) {
            console.warn('  ⚠️ Failed to get MELO/MUSDC pool:', e);
          }
          
          console.log('  Pool Reserves:');
          console.log('    MILO/MUSDC - MILO:', miloReserve.toString());
          console.log('    MILO/MUSDC - MUSDC:', musdcReserve.toString());
          console.log('    MELO/MUSDC - MELO:', meloReserve.toString());
          console.log('    MELO/MUSDC - MUSDC:', meloMusdcReserve.toString());
          
          setPoolReserves({
            'MILO/MUSDC': {
              reserveA: miloReserve,
              reserveB: musdcReserve,
            },
            'MELO/MUSDC': {
              reserveA: meloReserve,
              reserveB: meloMusdcReserve,
            },
          });
        }
        
        console.log('✅ Pool reserves set in App.tsx');
      } catch (error) {
        console.error('Error fetching pool reserves:', error);
      } finally {
        safeFreeArray(wasmObjectsToFree);
        releaseLock();
      }
    };
    
    fetchPoolReserves();
    const interval = setInterval(fetchPoolReserves, 15000);
    return () => clearInterval(interval);
  }, [client]);

  // Fetch user balances
  useEffect(() => {
    const clientToUse = client;
    const accountIdStr = accountId;
    
    if (!clientToUse || !accountIdStr) {
      setUserBalances({});
      return;
    }
    
    let isMounted = true;
    let intervalId: NodeJS.Timeout | null = null;
    
    const fetchUserBalances = async () => {
      if (!acquireLock(20000)) {
        console.log('⏸️ Balance fetch skipped - client operation lock active');
        return;
      }
      
      const wasmObjectsToFree: WasmObject[] = [];
      
      try {
        try {
          await clientToUse.syncState();
        } catch (syncError: any) {
          const errorMsg = syncError?.message || String(syncError);
          if (errorMsg.includes('too many note IDs')) {
            console.warn('⚠️ Too many notes, skipping sync in fetchUserBalances');
          } else {
            console.warn('⚠️ Sync failed in fetchUserBalances:', errorMsg);
          }
        }
        
        const { AccountId } = await import('@miden-sdk/miden-sdk');
        const accountData = await clientToUse.getAccount(AccountId.fromHex(accountIdStr));
        
        const balances: Record<string, bigint> = {};
        const miloToken = getTokenBySymbol('MILO');
        const meloToken = getTokenBySymbol('MELO');
        const musdcToken = getTokenBySymbol('MUSDC');
        const midenToken = getTokenBySymbol('MIDEN');
        
        if (miloToken) balances[miloToken.faucetId.toLowerCase()] = BigInt(0);
        if (meloToken) balances[meloToken.faucetId.toLowerCase()] = BigInt(0);
        if (musdcToken) balances[musdcToken.faucetId.toLowerCase()] = BigInt(0);
        if (midenToken) balances[midenToken.faucetId.toLowerCase()] = BigInt(0);
        
        if (!accountData) {
          console.warn('⚠️ Account data not found for balance fetch, setting zero balances');
          if (isMounted) {
            setUserBalances(balances);
          }
          return;
        }
        
        wasmObjectsToFree.push(accountData);
        
        const vault = accountData.vault();
        wasmObjectsToFree.push(vault);
        
        const fungibleAssets = vault.fungibleAssets();
        
        let totalMidenBalance = BigInt(0);
        
        console.log(`🔍 Found ${fungibleAssets.length} fungible assets`);
        
        for (const asset of fungibleAssets) {
          const faucetIdObj = asset.faucetId();
          wasmObjectsToFree.push(faucetIdObj);
          
          const faucetIdHex = faucetIdObj.toString().toLowerCase();
          const amount = BigInt(asset.amount());
          const assetTokenMeta = getTokenMetadata(faucetIdHex);
          
          if (assetTokenMeta) {
            if (assetTokenMeta.symbol === 'MIDEN' && midenToken) {
              totalMidenBalance += amount;
              console.log(`  ✅ MIDEN asset: ${faucetIdHex}, amount: ${amount.toString()}, total so far: ${totalMidenBalance.toString()}`);
            } else if (assetTokenMeta.symbol === 'MILO' || assetTokenMeta.symbol === 'MELO' || assetTokenMeta.symbol === 'MUSDC') {
              const existingBalance = balances[faucetIdHex] || BigInt(0);
              balances[faucetIdHex] = existingBalance + amount;
              console.log(`  ✅ ${assetTokenMeta.symbol} asset: ${faucetIdHex}, amount: ${amount.toString()}, balance: ${balances[faucetIdHex].toString()}`);
            } else {
              console.log(`  ⚠️ Unknown token with metadata: ${assetTokenMeta.symbol} (${faucetIdHex}), amount: ${amount.toString()}`);
            }
          } else {
            if (miloToken && faucetIdHex === miloToken.faucetId.toLowerCase()) {
              const existingBalance = balances[faucetIdHex] || BigInt(0);
              balances[faucetIdHex] = existingBalance + amount;
              console.log(`  ✅ MILO (direct): ${faucetIdHex}, amount: ${amount.toString()}, balance: ${balances[faucetIdHex].toString()}`);
            } else if (meloToken && faucetIdHex === meloToken.faucetId.toLowerCase()) {
              const existingBalance = balances[faucetIdHex] || BigInt(0);
              balances[faucetIdHex] = existingBalance + amount;
              console.log(`  ✅ MELO (direct): ${faucetIdHex}, amount: ${amount.toString()}, balance: ${balances[faucetIdHex].toString()}`);
            } else if (musdcToken && faucetIdHex === musdcToken.faucetId.toLowerCase()) {
              const existingBalance = balances[faucetIdHex] || BigInt(0);
              balances[faucetIdHex] = existingBalance + amount;
              console.log(`  ✅ MUSDC (direct): ${faucetIdHex}, amount: ${amount.toString()}, balance: ${balances[faucetIdHex].toString()}`);
            } else if (midenToken && faucetIdHex === midenToken.faucetId.toLowerCase()) {
              totalMidenBalance += amount;
              console.log(`  ✅ MIDEN (direct match): ${faucetIdHex}, amount: ${amount.toString()}, total so far: ${totalMidenBalance.toString()}`);
            } else {
              console.log(`  ⚠️ Unknown asset: ${faucetIdHex}, amount: ${amount.toString()}`);
            }
          }
          
          safeFree(asset);
        }
        
        if (midenToken) {
          balances[midenToken.faucetId.toLowerCase()] = totalMidenBalance;
          if (totalMidenBalance > BigInt(0)) {
            console.log(`  ✅ Final MIDEN balance: ${totalMidenBalance.toString()}`);
          }
        }
        
        console.log('💰 User balances fetched:', balances);
        
        if (isMounted) {
          setUserBalances(balances);
        }
      } catch (error: any) {
        console.error('❌ Error fetching user balances:', error);
        const errorMsg = error?.message || String(error);
        console.error('   Error details:', errorMsg);
        
        const balances: Record<string, bigint> = {};
        const miloToken = getTokenBySymbol('MILO');
        const meloToken = getTokenBySymbol('MELO');
        const musdcToken = getTokenBySymbol('MUSDC');
        const midenToken = getTokenBySymbol('MIDEN');
        if (miloToken) balances[miloToken.faucetId.toLowerCase()] = BigInt(0);
        if (meloToken) balances[meloToken.faucetId.toLowerCase()] = BigInt(0);
        if (musdcToken) balances[musdcToken.faucetId.toLowerCase()] = BigInt(0);
        if (midenToken) balances[midenToken.faucetId.toLowerCase()] = BigInt(0);
        if (isMounted) {
          setUserBalances(balances);
        }
      } finally {
        safeFreeArray(wasmObjectsToFree);
        releaseLock();
      }
    };
    
    fetchUserBalances();
    intervalId = setInterval(fetchUserBalances, 10000);
    
    return () => {
      isMounted = false;
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [client, accountId]);

  // Calculate output amount when input changes
  useEffect(() => {
    if (!swapAmountIn || !poolReserves[activeMarket]) {
      setSwapAmountOut('');
      return;
    }
    
    const amount = parseFloat(swapAmountIn);
    if (isNaN(amount) || amount <= 0) {
      setSwapAmountOut('');
      return;
    }
    
    const reserves = poolReserves[activeMarket];
    if (reserves.reserveA > BigInt(0) && reserves.reserveB > BigInt(0)) {
      const [tokenA, tokenB] = activeMarket.split('/');
      const tokenIn = swapReversed ? tokenB : tokenA;
      const tokenOut = swapReversed ? tokenA : tokenB;
      const tokenInMeta = getTokenBySymbol(tokenIn);
      const tokenOutMeta = getTokenBySymbol(tokenOut);
      
      if (!tokenInMeta || !tokenOutMeta) {
        setSwapAmountOut('');
        return;
      }
      
      const amountRaw = BigInt(Math.floor(amount * 10 ** (tokenInMeta.decimals ?? 0)));
      const reserveIn = swapReversed ? reserves.reserveB : reserves.reserveA;
      const reserveOut = swapReversed ? reserves.reserveA : reserves.reserveB;
      
      const fee = BigInt(1000);
      const amountInWithFee = amountRaw * (BigInt(1000000) - fee);
      const estimatedOut = (amountInWithFee * reserveOut) / (reserveIn * BigInt(1000000) + amountInWithFee);
      
      const buyDecimals = tokenOutMeta.decimals ?? 0;
      const divisor = BigInt(10 ** buyDecimals);
      const whole = estimatedOut / divisor;
      const fraction = estimatedOut % divisor;
      
      let result = '';
      if (fraction === BigInt(0)) {
        result = whole.toString();
      } else {
        const fractionStr = fraction.toString().padStart(buyDecimals, '0').replace(/0+$/, '');
        result = fractionStr ? `${whole}.${fractionStr}` : whole.toString();
      }
      
      setSwapAmountOut(result);
    } else {
      setSwapAmountOut('');
    }
  }, [swapAmountIn, swapReversed, activeMarket, poolReserves]);

  // Swap hook - use extension wallet
  const syncState = useCallback(async () => {
    const clientToUse = client;
    if (clientToUse) {
      if (!acquireLock(15000)) {
        return;
      }
      try {
        await clientToUse.syncState();
      } catch (syncError: any) {
        const errorMsg = syncError?.message || String(syncError);
        if (errorMsg.includes('too many note IDs')) {
          console.warn('⚠️ Too many notes, skipping sync in swap syncState');
        } else {
          console.warn('⚠️ Sync failed in swap syncState, continuing anyway:', errorMsg);
        }
      } finally {
        releaseLock();
      }
    }
  }, [client]);
  
  const { 
    swap, 
    isLoading: isSwapLoading, 
    error: swapError, 
    txId: swapTxId, 
    noteId: swapNoteId,
  } = useSwap({
    client,
    accountId,
    poolAccountId: null,
  });

  const refreshAccountData = async () => {
    const clientToUse = client;
    const accountIdStr = accountId;
    
    if (!clientToUse || !accountIdStr) return;
    if (!acquireLock(20000)) return;
    
    const wasmObjectsToFree: WasmObject[] = [];
    setRefreshing(true);
    
    try {
      const { NoteFilter, NoteFilterTypes, AccountId } = await import('@miden-sdk/miden-sdk');
      
      try {
        await clientToUse.syncState();
      } catch (syncError: any) {
        const errorMsg = syncError?.message || String(syncError);
        if (errorMsg.includes('too many note IDs')) {
          console.warn('⚠️ Too many notes, skipping sync in refreshAccountData');
        } else {
          console.warn('⚠️ Sync failed in refreshAccountData, continuing anyway:', errorMsg);
        }
      }

      const accountIdObj = AccountId.fromHex(accountIdStr);
      wasmObjectsToFree.push(accountIdObj);
      
      const latestAccount = await clientToUse.getAccount(accountIdObj);
      if (latestAccount) {
        wasmObjectsToFree.push(latestAccount);
        
        setAccount(latestAccount);
        
        const vaultAssets = latestAccount.vault().fungibleAssets();
        console.log('📊 Vault assets count:', vaultAssets.length);
        
        const assetRows = vaultAssets.map((asset: any) => {
          const faucetIdObj = asset.faucetId();
          wasmObjectsToFree.push(faucetIdObj);
          
          const amountStr = asset.amount().toString();
          
          let faucetIdStr: string;
          if (typeof faucetIdObj.toString === 'function') {
            faucetIdStr = faucetIdObj.toString();
          } else {
            faucetIdStr = String(faucetIdObj);
          }
          
          console.log('🔍 Asset - Faucet ID:', faucetIdStr, 'Amount:', amountStr);
          
          const meta = resolveTokenMeta(faucetIdObj, amountStr);
          console.log('✅ Resolved - Symbol:', meta.symbol, 'Decimals:', meta.decimals);
          
          safeFree(asset);
          
          return {
            asset: meta.symbol,
            total: formatAmount(amountStr, meta.decimals),
            available: formatAmount(amountStr, meta.decimals),
            faucetId: faucetIdStr,
            amount: BigInt(amountStr),
            decimals: meta.decimals,
          };
        });
        
        const groupedBalances = new Map<string, {
          asset: string;
          total: string;
          available: string;
          amount: bigint;
          decimals: number;
        }>();
        
        for (const row of assetRows) {
          const existing = groupedBalances.get(row.asset);
          if (existing) {
            const maxDecimals = Math.max(existing.decimals, row.decimals);
            const existingAmount = existing.amount * BigInt(10 ** (maxDecimals - existing.decimals));
            const rowAmount = row.amount * BigInt(10 ** (maxDecimals - row.decimals));
            const totalAmount = existingAmount + rowAmount;
            
            groupedBalances.set(row.asset, {
              asset: row.asset,
              total: formatAmount(totalAmount.toString(), maxDecimals),
              available: formatAmount(totalAmount.toString(), maxDecimals),
              amount: totalAmount,
              decimals: maxDecimals,
            });
          } else {
            groupedBalances.set(row.asset, {
              asset: row.asset,
              total: row.total,
              available: row.available,
              amount: row.amount,
              decimals: row.decimals,
            });
          }
        }
        
        const rows = Array.from(groupedBalances.values()).map(({ asset, total, available }) => ({
          asset,
          total,
          available,
        }));
        
        console.log('💰 Final balance rows (grouped):', rows);
        setBalances(rows);
      } else {
        console.warn('⚠️ Latest account not found');
      }

      const toNoteRow = (record: any, status: string): NoteRow => {
        const details = record.details();
        wasmObjectsToFree.push(details);
        
        const assets = details.assets().fungibleAssets();
        if (assets.length === 0) {
          const recordId = record.id();
          wasmObjectsToFree.push(recordId);
          return { id: recordId.toString(), asset: 'Unknown', amount: '-', status };
        }
        const amountStr = assets[0].amount().toString();
        const faucetIdObj = assets[0].faucetId();
        wasmObjectsToFree.push(faucetIdObj);
        
        const meta = resolveTokenMeta(faucetIdObj, amountStr);
        const recordId = record.id();
        wasmObjectsToFree.push(recordId);
        
        return {
          id: recordId.toString(),
          asset: meta.symbol,
          amount: formatAmount(amountStr, meta.decimals),
          status,
        };
      };

      const accountIdForNotes = AccountId.fromHex(accountIdStr);
      wasmObjectsToFree.push(accountIdForNotes);
      
      const incoming = await client.getConsumableNotes(accountIdForNotes);
      const pending = await client.getInputNotes(new NoteFilter(NoteFilterTypes.Processing));
      const spent = await client.getInputNotes(new NoteFilter(NoteFilterTypes.Consumed));

      setNotes({
        incoming: incoming.map((rec: any) =>
          toNoteRow(rec.inputNoteRecord(), 'Ready'),
        ),
        pending: pending.map((rec: any) => toNoteRow(rec, 'Processing')),
        spent: spent.map((rec: any) => toNoteRow(rec, 'Consumed')),
      });
    } catch (error) {
      console.error('Failed to refresh account data:', error);
    } finally {
      safeFreeArray(wasmObjectsToFree);
      releaseLock();
      setRefreshing(false);
    }
  };

  const handleFaucetRequest = async (symbol: string) => {
    console.log('handleFaucetRequest called:', { symbol, connected, address, accountId });
    
    let accountIdForRequest: string | null = null;
    
    if (address || accountId) {
      accountIdForRequest = address || accountId;
      console.log('Using extension wallet address:', accountIdForRequest);
    }
    
    if (!accountIdForRequest) {
      const errorMsg = `❌ Connect wallet first.`;
      console.error(errorMsg);
      setFaucetStatus(errorMsg);
      return;
    }
    
    const token = getTokenBySymbol(symbol);
    if (!token) {
      setFaucetStatus('❌ Token metadata not found.');
      return;
    }
    if (!token.faucetApiUrl) {
      setFaucetStatus('❌ Set faucet API URL for this token.');
      return;
    }
    setFaucetStatus(null);
    setFaucetBusy(symbol);
    try {
      const MAX_CLAIMABLE_BASE_UNITS = 1000000000;
      
      const amount = token.decimals == null
        ? faucetAmount
        : `${Math.round(Number(faucetAmount) * 10 ** token.decimals)}`;
      
      const amountNum = parseInt(amount, 10);
      if (amountNum > MAX_CLAIMABLE_BASE_UNITS) {
        const maxTokens = MAX_CLAIMABLE_BASE_UNITS / (10 ** (token.decimals ?? 0));
        setFaucetStatus(`❌ Amount too large! Maximum is ${maxTokens} tokens (${MAX_CLAIMABLE_BASE_UNITS} base units).`);
        setFaucetBusy(null);
        return;
      }
      
      console.log('Requesting tokens:', { symbol, accountId: accountIdForRequest, amount, apiUrl: token.faucetApiUrl });
      
      const result = await requestTokens({
        apiUrl: token.faucetApiUrl,
        accountId: accountIdForRequest,
        amount,
        isPrivate: faucetPrivate,
      });
      
      console.log('Faucet mint result:', result);
      
      setFaucetStatus(
        `✅ Success! Transaction submitted to blockchain. ` +
        `Tx: ${result.tx_id.slice(0, 16)}..., Note: ${result.note_id.slice(0, 16)}... ` +
        `Note created - view on explorer. ` +
        `Note: Tokens are in a note and need to be consumed to appear in balance.`
      );
      
      setFaucetStatus(
        `✅ Transaction submitted! Note created. ` +
        `Waiting 20 seconds for confirmation, then automatically consuming...`
      );
      
      const clientForFaucet = client;
      const accountForFaucet = account;
      
      if (clientForFaucet && accountForFaucet) {
        setTimeout(async () => {
          setFaucetStatus('⏳ Syncing state to find notes...');
          try {
            // Simply sync state - note should be available if created on-chain
            await clientForFaucet.syncState();
            await refreshAccountData();
            
            // Get consumable notes
            const accountIdObj = (await import('@miden-sdk/miden-sdk')).AccountId.fromHex(accountForFaucet.id().toString());
            const consumableNotes = await clientForFaucet.getConsumableNotes(accountIdObj);
            
            if (consumableNotes.length > 0) {
              setFaucetStatus(`🔄 Found ${consumableNotes.length} note(s) to consume. Starting automatic consume...`);
              await consumeNotes();
            } else {
              setFaucetStatus(
                `✅ Transaction submitted! Note created. ` +
                `Please wait 30 seconds, REFRESH THE PAGE, and click "Consume Notes" button to add tokens to balance.`
              );
            }
          } catch (error: any) {
            console.error('Auto-consume error:', error);
            const errorMsg = error?.message || 'Unknown error';
            setFaucetStatus(
              `✅ Transaction submitted! Note created. ` +
              `Sync failed: ${errorMsg}. ` +
              `Please REFRESH THE PAGE and click "Consume Notes" button manually.`
            );
          }
        }, 20000);
      } else {
        setFaucetStatus(
          `✅ Transaction submitted! Note created. ` +
          `WebClient not available - please refresh page and click "Consume Notes" to add tokens to balance.`
        );
      }
    } catch (error: any) {
      const errorMsg = error?.message || 'Unknown error';
      setFaucetStatus(`❌ Failed: ${errorMsg}`);
      console.error('Faucet error:', error);
    } finally {
      setFaucetBusy(null);
    }
  };

  const filteredMarkets = useMemo(() => {
    const markets = getMarkets(poolReserves);
    const bySearch = markets.filter((market) =>
      market.pair.toLowerCase().includes(marketSearch.toLowerCase())
    );
    if (!favoriteOnly) {
      return bySearch;
    }
    return bySearch.filter((market) => market.pair === 'MILO/MUSDC');
  }, [marketSearch, favoriteOnly, poolReserves]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/logo.png" alt="Milo Swap" className="brand-logo" />
        </div>
        <nav className="topbar-nav">
          {(['home', 'trade', 'pools', 'portfolio', 'faucet'] as PageKey[]).map((page) => (
            <button
              key={page}
              className={`nav-button ${currentPage === page ? 'active' : ''}`}
              onClick={() => {
                setCurrentPage(page);
                window.location.hash = page;
              }}
            >
              {page.charAt(0).toUpperCase() + page.slice(1)}
            </button>
          ))}
        </nav>
        <div className="topbar-actions">
          <div className="network-pill">Testnet</div>
          {connected && accountId ? (
            <>
              <div className="account-pill" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '0.25rem', padding: '0.5rem 1rem' }}>
                <span style={{ fontSize: '0.75rem', color: '#9aa4b2' }}>MIDEN Balance</span>
                <code style={{ fontSize: '0.85rem' }}>
                  {(() => {
                    const midenToken = getTokenBySymbol('MIDEN');
                    if (midenToken) {
                      const balance = userBalances[midenToken.faucetId.toLowerCase()] || BigInt(0);
                      const decimals = midenToken.decimals ?? 0;
                      const formatted = (Number(balance) / Math.pow(10, decimals)).toLocaleString('en-US', {
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 6,
                      });
                      return formatted;
                    }
                    return '0';
                  })()}
                </code>
              </div>
              <WalletMultiButton className="secondary-button" style={{ marginLeft: '0.5rem' }} />
            </>
          ) : (
            <WalletMultiButton className="primary-button" />
          )}
        </div>
      </header>

      {currentPage === 'pools' ? (
        <Pools 
          client={client} 
          accountId={accountId}
          poolReserves={poolReserves}
          userBalances={userBalances}
        />
      ) : currentPage === 'faucet' ? (
        <Faucet
          client={client}
          accountId={accountId}
          account={account}
        />
      ) : currentPage === 'trade' ? (
        <Trade
          client={client}
          accountId={accountId}
          account={account}
          poolReserves={poolReserves}
          userBalances={userBalances}
        />
      ) : currentPage === 'portfolio' ? (
        <Portfolio
          client={client}
          accountId={accountId}
          account={account}
          poolReserves={poolReserves}
          userBalances={userBalances}
        />
      ) : (
        <Home />
      )}
    </div>
  );
}

function App() {
  const wallets = useMemo(
    () => [
      new MidenWalletAdapter({
        appName: 'Milo Swap',
      }),
    ],
    [],
  );

  return (
    <WalletProvider wallets={wallets} autoConnect>
      <WalletModalProvider>
        <TerminalApp />
      </WalletModalProvider>
    </WalletProvider>
  );
}

export default App;
