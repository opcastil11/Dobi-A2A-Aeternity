const {
  AeSdkAepp,
  Node,
  BrowserWindowMessageConnection,
  walletDetector,
} = window.Aeternity;

// Nodos y compiler recomendados por la guía
const TESTNET_NODE_URL = 'https://testnet.aeternity.io';
const MAINNET_NODE_URL = 'https://mainnet.aeternity.io';
const COMPILER_URL = 'https://compiler.aepps.com'; // público
// Ref: guía oficial de conexión (constantes / init / scan).  // docs citadas en el mensaje

let aeSdk;
let stopScan;
let connected = false;
let currentAddress;

// Helpers UI
const $ = (sel) => document.querySelector(sel);
const setWalletText = (t) => ($('#wallet-text').textContent = t);
const setOwner = (addr) => { const el = $('#summary-owner'); if (el) el.textContent = addr || '-'; };
const setBalance = (ae) => {
  $('#wallet-balance').textContent = `${ae} AE`;
  const el = $('#summary-wallet-ae'); if (el) el.textContent = `${ae} AE`;
};
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

async function initAepp() {
  console.log('🚀 Inicializando Aeternity SDK...');
  aeSdk = new AeSdkAepp({
    name: 'Dobi Protocol',
    nodes: [
      { name: 'testnet', instance: new Node(TESTNET_NODE_URL) },
      { name: 'mainnet', instance: new Node(MAINNET_NODE_URL) },
    ],
    compilerUrl: COMPILER_URL,
    onNetworkChange: async ({ networkId }) => {
      console.log('🌐 Cambio de red detectado:', networkId);
      // Selecciona automáticamente el nodo que coincide con el network del wallet
      const [{ name }] = (await aeSdk.getNodesInPool())
        .filter((n) => n.nodeNetworkId === networkId);
      aeSdk.selectNode(name);
      const el = $('#summary-network');
      if (el) el.textContent = name === 'mainnet' ? 'Aeternity Mainnet' : 'Aeternity Testnet';
      console.log('✅ Nodo seleccionado:', name);
    },
    onAddressChange: ({ current }) => {
      const addr = Object.keys(current)[0];
      console.log('👤 Cambio de dirección:', addr);
      currentAddress = addr;
      setWalletText(short(addr));
      setOwner(addr);
      if (connected) updateBalance();
    },
    onDisconnect: () => {
      console.log('❌ Wallet desconectada');
      connected = false;
      currentAddress = undefined;
      setWalletText('Connect Wallet');
      setOwner('-');
      setBalance('0');
      alert('Wallet desconectada');
    },
  });
  console.log('✅ Aeternity SDK inicializado');
}

async function connectWallet() {
  const scanner = new BrowserWindowMessageConnection();
  let stopped = false;

  const handleWallets = async ({ wallets, newWallet }) => {
    if (stopped) return;
    const wallet = newWallet || Object.values(wallets)[0];
    stopped = true;
    stopScan?.();

    try {
      // 🔧 Conéctate al nodo del wallet (evita mismatch de red/latencia)
      await aeSdk.connectToWallet(wallet.getConnection(), {
        connectNode: true,
        name: 'wallet-node',
        select: true,
      });

      // Espera un tick para que el wallet termine de "armarse" tras el unlock
      await new Promise(r => setTimeout(r, 150));

      // ⚠️ Esta llamada era donde explotaba: ahora la envolvemos
      const { address: { current } } =
        await aeSdk.subscribeAddress('subscribe', 'connected');

      const addr = Object.keys(current)[0];
      currentAddress = addr;
      connected = true;
      setWalletText(short(addr));
      setOwner(addr);
      await updateBalance();
    } catch (err) {
      console.error('[AEX-2] connect/subscribe failed:', err);
      connected = false;
      setWalletText('Connect Wallet');
      setOwner('-');
      setBalance('0');
      alert(`Wallet error: ${err?.message || err}`);

      // Reintento único (p. ej., si el unlock tardó un poco)
      setTimeout(() => {
        if (!connected) connectWallet();
      }, 500);
    }
  };

  // Inicia el detector y guarda el stopper
  stopScan = walletDetector(scanner, handleWallets);

  // Fallback si no se detecta wallet
  setTimeout(() => {
    if (!connected && !stopped) {
      stopScan?.();
      alert('No se detectó Superhero Wallet. ¿Está instalada y habilitada?');
    }
  }, 6000);
}

async function updateBalance() {
  try {
    if (!currentAddress) return;
    const aettos = await aeSdk.getBalance(currentAddress);
    const ae = (Number(BigInt(aettos)) / 1e18).toFixed(4);
    setBalance(ae);
  } catch (e) {
    console.warn('No se pudo obtener balance:', e);
    setBalance('0');
  }
}

// Hook UI
document.addEventListener('DOMContentLoaded', async () => {
  // Verificar que el SDK esté cargado
  if (!window.Aeternity) {
    console.error('Aeternity SDK no está cargado');
    document.body.innerHTML = '<div style="color: white; text-align: center; padding: 50px;">Error: Aeternity SDK no se pudo cargar. Por favor, recarga la página.</div>';
    return;
  }

  // Protección contra conflictos con window.ethereum
  try {
    const ethereumDesc = Object.getOwnPropertyDescriptor(window, 'ethereum');
    if (ethereumDesc && !ethereumDesc.configurable) {
      console.warn('window.ethereum ya está definido y no es configurable. Esto puede causar conflictos.');
    }
  } catch (e) {
    console.warn('Error verificando window.ethereum:', e);
  }

  await initAepp();
  $('#connect-wallet').addEventListener('click', async () => {
    if (!connected) {
      setWalletText('Conectando...');
      await connectWallet();
    } else {
      alert('Ya estás conectado. (Puedes desconectar desde la extensión.)');
    }
  });

  // Botones de tu UI que ya existen:
  $('#hero-create-btn')?.addEventListener('click', () => $('#create-page')?.classList.add('active'));
  $('#hero-devices-btn')?.addEventListener('click', () => $('#devices-page')?.classList.add('active'));
});