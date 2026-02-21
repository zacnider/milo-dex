import { useWallet } from '@miden-sdk/miden-wallet-adapter';

export default function Home() {
  const { connected } = useWallet();

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%)',
      padding: '4rem 2rem',
    }}>
      <div style={{
        maxWidth: '1200px',
        margin: '0 auto',
      }}>
        {/* Hero Section */}
        <div style={{
          textAlign: 'center',
          marginBottom: '4rem',
        }}>
          <div style={{
            background: '#ff6b35',
            color: '#000',
            display: 'inline-block',
            padding: '1rem 2rem',
            borderRadius: '12px',
            fontSize: '3rem',
            fontWeight: 'bold',
            marginBottom: '1rem',
            boxShadow: '0 8px 32px rgba(255, 107, 53, 0.4)',
          }}>
            MILO SWAP
          </div>
          <h1 style={{
            color: '#fff',
            fontSize: '2.5rem',
            margin: '1rem 0',
            fontWeight: 'bold',
          }}>
            Decentralized Exchange on Miden
          </h1>
          <p style={{
            color: '#999',
            fontSize: '1.2rem',
            maxWidth: '600px',
            margin: '0 auto',
            lineHeight: '1.6',
          }}>
            Trade tokens, provide liquidity on the Miden blockchain.
            Fast, secure, and decentralized.
          </p>
        </div>

        {/* Features Grid */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          gap: '2rem',
          marginBottom: '4rem',
        }}>
          <div style={{
            background: '#1a1a1a',
            border: '2px solid #ff6b35',
            borderRadius: '12px',
            padding: '2rem',
            transition: 'all 0.3s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'translateY(-5px)';
            e.currentTarget.style.boxShadow = '0 8px 24px rgba(255, 107, 53, 0.3)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.boxShadow = 'none';
          }}
          >
            <div style={{
              fontSize: '3rem',
              marginBottom: '1rem',
            }}>💱</div>
            <h3 style={{
              color: '#ff6b35',
              fontSize: '1.5rem',
              marginBottom: '0.5rem',
              fontWeight: 'bold',
            }}>Swap Tokens</h3>
            <p style={{
              color: '#999',
              lineHeight: '1.6',
            }}>
              Instantly swap between MILOA, MILOB, MUSDT, and MIDEN tokens with low fees and high liquidity.
            </p>
          </div>

          <div style={{
            background: '#1a1a1a',
            border: '2px solid #ff6b35',
            borderRadius: '12px',
            padding: '2rem',
            transition: 'all 0.3s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'translateY(-5px)';
            e.currentTarget.style.boxShadow = '0 8px 24px rgba(255, 107, 53, 0.3)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.boxShadow = 'none';
          }}
          >
            <div style={{
              fontSize: '3rem',
              marginBottom: '1rem',
            }}>💧</div>
            <h3 style={{
              color: '#ff6b35',
              fontSize: '1.5rem',
              marginBottom: '0.5rem',
              fontWeight: 'bold',
            }}>Provide Liquidity</h3>
            <p style={{
              color: '#999',
              lineHeight: '1.6',
            }}>
              Add liquidity to pools and earn trading fees.
            </p>
          </div>

          <div style={{
            background: '#1a1a1a',
            border: '2px solid #ff6b35',
            borderRadius: '12px',
            padding: '2rem',
            transition: 'all 0.3s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'translateY(-5px)';
            e.currentTarget.style.boxShadow = '0 8px 24px rgba(255, 107, 53, 0.3)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.boxShadow = 'none';
          }}
          >
            <div style={{
              fontSize: '3rem',
              marginBottom: '1rem',
            }}>🔒</div>
            <h3 style={{
              color: '#ff6b35',
              fontSize: '1.5rem',
              marginBottom: '0.5rem',
              fontWeight: 'bold',
            }}>Secure & Private</h3>
            <p style={{
              color: '#999',
              lineHeight: '1.6',
            }}>
              Built on Miden's zero-knowledge proof technology. Your transactions are secure and private.
            </p>
          </div>
        </div>

        {/* CTA Section */}
        <div style={{
          background: '#ff6b35',
          color: '#000',
          borderRadius: '12px',
          padding: '3rem',
          textAlign: 'center',
          marginBottom: '4rem',
        }}>
          <h2 style={{
            fontSize: '2rem',
            marginBottom: '1rem',
            fontWeight: 'bold',
          }}>Ready to Start Trading?</h2>
          <p style={{
            fontSize: '1.1rem',
            marginBottom: '2rem',
            opacity: 0.9,
          }}>
            Connect your wallet and start swapping tokens on Miden testnet.
          </p>
          <div style={{
            display: 'flex',
            gap: '1rem',
            justifyContent: 'center',
            flexWrap: 'wrap',
          }}>
            <button
              onClick={() => {
                window.location.hash = 'trade';
              }}
              style={{
                background: '#000',
                color: '#ff6b35',
                border: 'none',
                borderRadius: '8px',
                padding: '1rem 2rem',
                fontSize: '1.1rem',
                fontWeight: 'bold',
                cursor: 'pointer',
                transition: 'all 0.3s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'scale(1.05)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'scale(1)';
              }}
            >
              Start Trading →
            </button>
            <button
              onClick={() => {
                window.location.hash = 'faucet';
              }}
              style={{
                background: '#000',
                color: '#ff6b35',
                border: 'none',
                borderRadius: '8px',
                padding: '1rem 2rem',
                fontSize: '1.1rem',
                fontWeight: 'bold',
                cursor: 'pointer',
                transition: 'all 0.3s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'scale(1.05)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'scale(1)';
              }}
            >
              Get Test Tokens →
            </button>
          </div>
        </div>

        {/* Stats Section */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '2rem',
        }}>
          <div style={{
            background: '#1a1a1a',
            border: '1px solid #333',
            borderRadius: '12px',
            padding: '1.5rem',
            textAlign: 'center',
          }}>
            <div style={{
              color: '#ff6b35',
              fontSize: '2rem',
              fontWeight: 'bold',
              marginBottom: '0.5rem',
            }}>2</div>
            <div style={{
              color: '#999',
              fontSize: '0.9rem',
            }}>Trading Pairs</div>
          </div>
          <div style={{
            background: '#1a1a1a',
            border: '1px solid #333',
            borderRadius: '12px',
            padding: '1.5rem',
            textAlign: 'center',
          }}>
            <div style={{
              color: '#ff6b35',
              fontSize: '2rem',
              fontWeight: 'bold',
              marginBottom: '0.5rem',
            }}>0.1%</div>
            <div style={{
              color: '#999',
              fontSize: '0.9rem',
            }}>Trading Fee</div>
          </div>
          <div style={{
            background: '#1a1a1a',
            border: '1px solid #333',
            borderRadius: '12px',
            padding: '1.5rem',
            textAlign: 'center',
          }}>
            <div style={{
              color: '#ff6b35',
              fontSize: '2rem',
              fontWeight: 'bold',
              marginBottom: '0.5rem',
            }}>ZK</div>
            <div style={{
              color: '#999',
              fontSize: '0.9rem',
            }}>Zero-Knowledge</div>
          </div>
          <div style={{
            background: '#1a1a1a',
            border: '1px solid #333',
            borderRadius: '12px',
            padding: '1.5rem',
            textAlign: 'center',
          }}>
            <div style={{
              color: '#ff6b35',
              fontSize: '2rem',
              fontWeight: 'bold',
              marginBottom: '0.5rem',
            }}>🔐</div>
            <div style={{
              color: '#999',
              fontSize: '0.9rem',
            }}>Secure</div>
          </div>
        </div>
      </div>
    </div>
  );
}
