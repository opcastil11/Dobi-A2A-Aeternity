const {
  AeSdkAepp,
  Node,
  BrowserWindowMessageConnection,
  walletDetector,
} = window.Aeternity;

// Nodes and compiler recommended by the guide
const TESTNET_NODE_URL = 'https://testnet.aeternity.io';
const MAINNET_NODE_URL = 'https://mainnet.aeternity.io';
const COMPILER_URL = 'https://compiler.aepps.com'; // public

// ===== On-chain config =====
const CONTRACT_SOURCE_URL = '/AIPaymentManager.aes';     // served by your static server
let CONTRACT_ADDRESS = localStorage.getItem('contract_addr') || ''; // paste here the one you deployed if you want it fixed

function setContractAddress(addr) {
  CONTRACT_ADDRESS = addr;
  localStorage.setItem('contract_addr', addr);
  const el = document.getElementById('summary-contract-address');
  if (el) el.textContent = addr || '-';
}

// Set the deployed contract address
setContractAddress('ct_gWCgyfWtVYAYXD2zwPQHxLK6btmvjhPhZE9XVmSzpaVNVPjb7');
// Ref: official connection guide (constants / init / scan).  // docs cited in the message

let aeSdk;
let stopScan;
let connected = false;
let currentAddress;

// UI Helpers
const $ = (sel) => document.querySelector(sel);
const setWalletText = (t) => ($('#wallet-text').textContent = t);
const setOwner = (addr) => { const el = $('#summary-owner'); if (el) el.textContent = addr || '-'; };
const setBalance = (ae) => {
  $('#wallet-balance').textContent = `${ae} AE`;
  const el = $('#summary-wallet-ae'); if (el) el.textContent = `${ae} AE`;
};
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

async function initAepp() {
  console.log('🚀 Initializing Aeternity SDK...');
  aeSdk = new AeSdkAepp({
    name: 'Dobi Protocol',
    nodes: [
      { name: 'testnet', instance: new Node(TESTNET_NODE_URL) },
      { name: 'mainnet', instance: new Node(MAINNET_NODE_URL) },
    ],
    compilerUrl: COMPILER_URL,
    onNetworkChange: async ({ networkId }) => {
      console.log('🌐 Network change detected:', networkId);
      // Automatically select the node that matches the wallet network
      const [{ name }] = (await aeSdk.getNodesInPool())
        .filter((n) => n.nodeNetworkId === networkId);
      aeSdk.selectNode(name);
      const el = $('#summary-network');
      if (el) el.textContent = name === 'mainnet' ? 'Aeternity Mainnet' : 'Aeternity Testnet';
      console.log('✅ Node selected:', name);
    },
    onAddressChange: ({ current }) => {
      const addr = Object.keys(current)[0];
      console.log('👤 Address change:', addr);
      currentAddress = addr;
      setWalletText(short(addr));
      setOwner(addr);
      if (connected) updateBalance();
    },
    onDisconnect: () => {
      console.log('❌ Wallet disconnected');
      connected = false;
      currentAddress = undefined;
      setWalletText('Connect Wallet');
      setOwner('-');
      setBalance('0');
      alert('Wallet disconnected');
    },
  });
  console.log('✅ Aeternity SDK initialized');
}

// ===== Contract lazy init =====
let ct; // contract instance

async function getContract() {
  if (ct) return ct;
  if (!CONTRACT_ADDRESS) throw new Error('CONTRACT_ADDRESS empty. Use setContractAddress("ct_...").');

  const res = await fetch(CONTRACT_SOURCE_URL);
  if (!res.ok) throw new Error(`Could not read ${CONTRACT_SOURCE_URL} (${res.status})`);
  const sourceCode = await res.text();

  // v14 in browser: initializeContract; fallback to Contract.initialize if needed
  if (typeof aeSdk.initializeContract === 'function') {
    ct = await aeSdk.initializeContract({ sourceCode, address: CONTRACT_ADDRESS });
  } else if (window.Aeternity?.Contract?.initialize) {
    // fallback (same API you use in deploy.js on Node side)
    ct = await window.Aeternity.Contract.initialize({
      ...aeSdk.getContext?.(),
      sourceCode,
      address: CONTRACT_ADDRESS,
    });
  } else {
    throw new Error('Your SDK does not expose initializeContract or Contract.initialize');
  }
  return ct;
}

// ===== units and conversions =====
// We will use integers: kWh_int := kWh * 1000 (milli-kWh). Prices/costs in aettos (1 AE = 1e18 aettos).
const toAettos = (ae) => BigInt(Math.round(Number(ae) * 1e18));
const fromAettos = (aettos) => Number(aettos) / 1e18;
const kwhToInt = (kwh) => Math.max(0, Math.round(Number(kwh) * 1000)); // mWh
const intToKwh = (n) => Number(n) / 1000;

// Provider: a "readable" ID. By default, we derive from the destination address.
function deriveProviderId(payeeAddress) {
  return `prov_${(payeeAddress || 'ak_utility_mock').slice(-8)}`;
}

// Oracle in Sophia: expects type oracle(string,int) => ID "ok_..."
// If the user enters an ak_, we treat it as mock and warn.
function getOracleIdFromUI() {
  const raw = (ui.agent?.utility?.value || '').trim();
  if (raw.startsWith('ok_')) return raw;          // real OK
  if (raw.startsWith('ak_')) return 'ok_mock';    // placeholder while you don't register oracle on-chain
  return raw || 'ok_mock';
}

// === Chargers/Providers ===
async function scEnsureCharger(st) {
  const c = await getContract();
  const r = await c.methods.get_charger_info(st.id);
  if (r.decodedResult === null) {
    await c.methods.register_charger(st.id, st.location || '-', 0);
    agentEvent(`SC: register_charger(${st.id})`);
  }
}

async function scEnsureProvider(payeeAddr, priceAEkWh) {
  const c = await getContract();
  const provId = deriveProviderId(payeeAddr);
  const info = await c.methods.get_provider_info(provId);
  if (info.decodedResult === null) {
    const priceAettos = toAettos(priceAEkWh);
    await c.methods.register_provider(provId, 'Utility', priceAettos.toString());
    agentEvent(`SC: register_provider(${provId}) price=${priceAEkWh} AE/kWh`);
  }
  return deriveProviderId(payeeAddr);
}

async function scFundCharger(st, amountAE) {
  const c = await getContract();
  const amt = toAettos(amountAE);
  await c.methods.fund_charger(st.id, { amount: amt.toString() });
  agentEvent(`SC: fund_charger ${amountAE} AE`);
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
      // 🔧 Connect to wallet node (avoids network/latency mismatch)
      await aeSdk.connectToWallet(wallet.getConnection(), {
        connectNode: true,
        name: 'wallet-node',
        select: true,
      });

      // Wait a tick for the wallet to finish "setting up" after unlock
      await new Promise(r => setTimeout(r, 150));

      // ⚠️ This call was where it exploded: now we wrap it
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

      // Single retry (e.g., if unlock took a bit longer)
      setTimeout(() => {
        if (!connected) connectWallet();
      }, 500);
    }
  };

  // Start the detector and save the stopper
  stopScan = walletDetector(scanner, handleWallets);

  // Fallback if wallet not detected
  setTimeout(() => {
    if (!connected && !stopped) {
      stopScan?.();
      alert('Superhero Wallet not detected. Is it installed and enabled?');
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
    console.warn('Could not get balance:', e);
    setBalance('0');
  }
}

// Hook UI
document.addEventListener('DOMContentLoaded', async () => {
  // Verify that SDK is loaded
  if (!window.Aeternity) {
    console.error('Aeternity SDK is not loaded');
    document.body.innerHTML = '<div style="color: white; text-align: center; padding: 50px;">Error: Aeternity SDK could not be loaded. Please reload the page.</div>';
    return;
  }

  // Protection against conflicts with window.ethereum
  try {
    const ethereumDesc = Object.getOwnPropertyDescriptor(window, 'ethereum');
    if (ethereumDesc && !ethereumDesc.configurable) {
      console.warn('window.ethereum is already defined and not configurable. This may cause conflicts.');
    }
  } catch (e) {
    console.warn('Error checking window.ethereum:', e);
  }

  await initAepp();
  $('#connect-wallet').addEventListener('click', async () => {
    if (!connected) {
      setWalletText('Connecting...');
      await connectWallet();
    } else {
      alert('You are already connected. (You can disconnect from the extension.)');
    }
  });

  // Your existing UI buttons:
  $('#hero-create-btn')?.addEventListener('click', () => $('#create-page')?.classList.add('active'));
  $('#hero-devices-btn')?.addEventListener('click', () => $('#devices-page')?.classList.add('active'));
});

/***** MOCK: charging stations *****/
const mockStations = [
  {
    id: 'ST-001',
    name: 'Dobi Station - Center',
    location: 'Libertador Ave 123, Santiago',
    status: 'available',
    powerKw: 22,
    priceAEkWh: 0.12,
    connectors: ['Type2', 'CCS2'],
    description: 'Public point in underground parking',
    type: 'charger',
    payments: [],
  },
  {
    id: 'ST-002',
    name: 'Dobi Station - Providencia',
    location: 'Nueva Providencia 2200, Santiago',
    status: 'busy',
    powerKw: 50,
    priceAEkWh: 0.15,
    connectors: ['CCS2', 'CHAdeMO'],
    description: 'Fast DC, 50kW',
    type: 'charger',
    payments: [],
  },
  {
    id: 'ST-003',
    name: 'Dobi Station - Las Condes',
    location: 'Isidora Goyenechea 3000, Santiago',
    status: 'maintenance',
    powerKw: 7,
    priceAEkWh: 0.10,
    connectors: ['Type2'],
    description: 'Residential slow charging',
    type: 'charger',
    payments: [],
  },
];

const ui = {
  pages: {
    home: document.getElementById('home-page'),
    devices: document.getElementById('devices-page'),
    create: document.getElementById('create-page'),
    tx: document.getElementById('transactions-page'),
    detail: document.getElementById('device-detail-page'),
  },
  lists: {
    devices: document.getElementById('devices-list'),
    payments: document.getElementById('payments-feed'),
  },
  stats: {
    totalDevices: document.getElementById('total-devices'),
    totalTx: document.getElementById('total-transactions'),
  },
  detail: {
    title: document.getElementById('device-detail-title'),
    id: document.getElementById('summary-device-id'),
    status: document.getElementById('summary-status'),
    location: document.getElementById('summary-location'),
    owner: document.getElementById('summary-owner'),
    type: document.getElementById('summary-type'),
    desc: document.getElementById('summary-description'),
    dataPoints: document.getElementById('summary-data-points'),
    lastUpdate: document.getElementById('summary-last-update'),
    uptime: document.getElementById('summary-uptime'),
    network: document.getElementById('summary-network'),
    contract: document.getElementById('summary-contract-address'),
  },
  agent: {
    kwh: document.getElementById('agent-kwh'),
    tariff: document.getElementById('agent-tariff'),
    utility: document.getElementById('agent-utility'),
    total: document.getElementById('agent-total'),
    toggle: document.getElementById('agent-toggle'),
    status: document.getElementById('agent-status'),
    arrival: document.getElementById('agent-arrival'),
    reset: document.getElementById('agent-reset'),
    pbar: document.getElementById('agent-progress-bar'),
    ptxt: document.getElementById('agent-progress-text'),
    events: document.getElementById('session-events'),
    history: document.getElementById('session-history'),
  },
  nav: {
    home: document.getElementById('nav-home'),
    devices: document.getElementById('nav-devices'),
    tx: document.getElementById('nav-transactions'),
  },
  paymentsCtl: {
    pause: document.getElementById('btn-pause-payments'),
    resume: document.getElementById('btn-resume-payments'),
    status: document.getElementById('payments-status')
  }
};

const state = {
  stations: mockStations,
  selectedStation: null,
  paymentsTimers: new Map(),  // stationId -> interval id
  chargingTimer: null,
  chargingPct: 0,
  livePaymentsPaused: false,
  totalTxCount: 0,
  agent: {
    enabled: true,
    running: false,
    pct: 0,
    timer: null,
    session: null,      // {id, kwh, tariff, utility, startedAt, finishedAt, totalAE}
    history: new Map(), // stationId -> array sesiones
  },
};

function showPage(id) {
  Object.values(ui.pages).forEach(p => p.classList.remove('active'));
  id.classList.add('active');
}

function fmtAE(num) {
  return Number(num).toFixed(3);
}

function shortAddr(a) {
  if (!a) return '-';
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/***** Render stations list *****/
function renderDevicesList() {
  const container = ui.lists.devices;
  if (!container) return;
  container.innerHTML = '';

  state.stations.forEach(st => {
    const card = document.createElement('div');
    card.className = 'device-card';

    const statusColor =
      st.status === 'available' ? 'var(--green)' :
      st.status === 'busy' ? 'var(--yellow)' :
      st.status === 'maintenance' ? 'var(--orange)' : 'var(--red)';

    card.innerHTML = `
      <div class="device-card-header">
        <h3>${st.name}</h3>
        <span class="status-badge" style="background:${statusColor};">${st.status}</span>
      </div>
      <div class="device-card-body">
        <p><i class="fas fa-location-dot"></i> ${st.location}</p>
        <p><i class="fas fa-bolt"></i> ${st.powerKw} kW · <i class="fas fa-coins"></i> ${fmtAE(st.priceAEkWh)} AE/kWh</p>
        <p><i class="fas fa-plug"></i> ${st.connectors.join(', ')}</p>
      </div>
      <div class="device-card-actions">
        <button class="btn btn-primary" data-open="${st.id}"><i class="fas fa-eye"></i> Open</button>
      </div>
    `;
    container.appendChild(card);
  });

  // delegation: open detail
  container.querySelectorAll('button[data-open]').forEach(btn => {
    btn.addEventListener('click', e => {
      const id = e.currentTarget.getAttribute('data-open');
      openDeviceDetail(id);
    });
  });
}

/***** Stats *****/
function renderStats() {
  if (ui.stats.totalDevices) ui.stats.totalDevices.textContent = String(state.stations.length);
  if (ui.stats.totalTx) ui.stats.totalTx.textContent = String(state.totalTxCount);
}

/***** Open station detail *****/
function openDeviceDetail(id) {
  const st = state.stations.find(s => s.id === id);
  if (!st) return;
  state.selectedStation = st;

  // Fill summary
  ui.detail.title.textContent = st.name;
  ui.detail.id.textContent = st.id;
  ui.detail.status.textContent = st.status;
  ui.detail.location.textContent = st.location;
  ui.detail.owner.textContent = currentAddress ? currentAddress : '-';
  ui.detail.type.textContent = st.type;
  ui.detail.desc.textContent = st.description;
  ui.detail.dataPoints.textContent = `${Math.floor(Math.random()*50)+10}`;
  ui.detail.lastUpdate.textContent = new Date().toLocaleString();
  ui.detail.uptime.textContent = `${Math.floor(Math.random()*96)+24} h`;
  ui.detail.contract.textContent = CONTRACT_ADDRESS || '-';

  // Reset agent
  resetAgent(st);
  agentBindEvents(st);

  // Render existing payments and start live stream
  renderPayments(st);
  startPaymentsStream(st);

  // Show page
  showPage(ui.pages.detail);

  // optional: simulate automatic arrival in 2-5s
  setTimeout(() => {
    if (!state.agent.running && state.agent.enabled) {
      agentEvent('Vehicle detected by IoT (auto)');
      agentStartSession(st);
    }
  }, 2000 + Math.random()*3000);
}

/***** Payments feed *****/
function renderPayments(station) {
  const list = ui.lists.payments;
  if (!list) return;
  list.innerHTML = '';

  station.payments
    .slice()
    .sort((a,b) => b.ts - a.ts)
    .forEach(p => list.appendChild(paymentItem(p)));
}

function paymentItem(p) {
  const row = document.createElement('div');
  row.className = 'log-item';
  const color = p.type === 'in' ? 'var(--green)' : 'var(--orange)';
  const sign = p.type === 'in' ? '+' : '−';
  row.innerHTML = `
    <div class="log-icon"><i class="fas ${p.type === 'in' ? 'fa-arrow-down' : 'fa-arrow-up'}"></i></div>
    <div class="log-content">
      <div class="log-title">${p.note || (p.type === 'in' ? 'Driver → Station' : 'Station → Utility')}</div>
      <div class="log-meta">
        <span>${new Date(p.ts).toLocaleTimeString()}</span>
        <span>from <code>${shortAddr(p.from)}</code></span>
        <span>to <code>${shortAddr(p.to)}</code></span>
      </div>
    </div>
    <div class="log-amount" style="color:${color}; font-weight:700;">${sign} ${fmtAE(p.amountAE)} AE</div>
  `;
  return row;
}

function pushPayment(station, payment) {
  station.payments.push(payment);
  state.totalTxCount++;
  renderStats();

  // paint at the top
  const list = ui.lists.payments;
  if (list) {
    list.prepend(paymentItem(payment));
  }
}

/***** Stream of simulated "incoming" payments *****/
function startPaymentsStream(station) {
  stopPaymentsStream(station.id);

  const interval = setInterval(() => {
    if (state.livePaymentsPaused) return;
    const amt = (Math.random() * 0.9 + 0.1); // 0.1 - 1.0 AE
    const p = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      from: randomAk(),
      to: station.id,
      amountAE: amt,
      type: 'in',
      note: 'Driver top-up (mock)',
    };
    pushPayment(station, p);
  }, 5000 + Math.random()*4000); // 5-9s

  state.paymentsTimers.set(station.id, interval);
}

function stopPaymentsStream(stationId) {
  const t = state.paymentsTimers.get(stationId);
  if (t) clearInterval(t);
  state.paymentsTimers.delete(stationId);
}

/***** Utilities *****/
function randomAk() {
  // address mock tipo ak_...
  const base = btoa(String(Math.random())).replace(/[^a-zA-Z0-9]/g,'').slice(0, 30);
  return `ak_${base}${Math.floor(Math.random()*1000)}`;
}

/***** Automatic agent *****/
function agentComputeTotal() {
  const k = Number(ui.agent.kwh?.value || 0);
  const t = Number(ui.agent.tariff?.value || 0);
  const total = k * t;
  if (ui.agent.total) ui.agent.total.textContent = fmtAE(total);
  return total;
}

function agentEvent(text) {
  if (!ui.agent?.events) return;
  const row = document.createElement('div');
  row.className = 'log-item';
  row.innerHTML = `
    <div class="log-icon"><i class="fas fa-circle-dot"></i></div>
    <div class="log-content">
      <div class="log-title">${text}</div>
      <div class="log-meta"><span>${new Date().toLocaleTimeString()}</span></div>
    </div>`;
  ui.agent.events.prepend(row);
}

function agentHistoryPush(stationId, sess) {
  if (!state.agent.history.has(stationId)) state.agent.history.set(stationId, []);
  state.agent.history.get(stationId).unshift(sess);

  if (!ui.agent?.history) return;
  const row = document.createElement('div');
  row.className = 'log-item';
  row.innerHTML = `
    <div class="log-icon"><i class="fas fa-bolt"></i></div>
    <div class="log-content">
      <div class="log-title">kWh: ${sess.kwh} · AE: ${fmtAE(sess.totalAE)}</div>
      <div class="log-meta">
        <span>${new Date(sess.startedAt).toLocaleTimeString()} → ${new Date(sess.finishedAt).toLocaleTimeString()}</span>
        <span>Utility: <code>${shortAddr(sess.utility)}</code></span>
      </div>
    </div>`;
  ui.agent.history.prepend(row);
}

function setAgentStatus(s) {
  if (ui.agent?.status) ui.agent.status.textContent = s;
}

async function agentStartSession(st) {
  if (!state.agent.enabled || state.agent.running) return;

  if (!connected) {
    agentEvent('Wallet not connected: trying to connect...');
    await connectWallet();
    if (!connected) {
      agentEvent('❌ Could not connect wallet. Visual session only.');
    }
  }

  const priceFromUI = Number(ui.agent.tariff?.value || 0);

  // UI + estado
  state.agent.running = true;
  state.agent.consumed = 0;
  state.agent.paidAE = 0;
  state.agent.session = {
    id: null,
    startedAt: Date.now(),
    oracleId: getOracleIdFromUI(),
    providerAddr: ui.agent.utility?.value || 'ak_utility_mock',
    providerId: deriveProviderId(ui.agent.utility?.value),
    priceAEkWh: priceFromUI,
    kwhGoal: Number(ui.agent.kwh?.value || 0),
  };

  // Progreso inicial
  ui.agent?.pbar && (ui.agent.pbar.style.width = '0%');
  ui.agent?.ptxt && (ui.agent.ptxt.textContent = '0%');
  setAgentStatus('charging');

  // === Step 2-3: App -> SC (start session) ===
  agentEvent(`App: Start charging at ${st.id}`);
  try {
    await scEnsureCharger(st);
    const provId = await scEnsureProvider(state.agent.session.providerAddr, state.agent.session.priceAEkWh);

    const c = await getContract();
    const estKwhInt = kwhToInt(state.agent.session.kwhGoal);
    const oracleId = state.agent.session.oracleId; // ok_... (o ok_mock)
    const meta = `ui:${window.location.host}`;

    const start = await c.methods.start_consumption(st.id, provId, oracleId, estKwhInt, meta);
    state.agent.session.id = start.decodedResult; // session_id (int)
    agentEvent(`SC: ConsumptionStarted(session=${state.agent.session.id})`);
  } catch (err) {
    console.error(err);
    agentEvent('❌ SC: start_consumption failed. Continuing in visual mode.');
  }

  // === IoT readings every 5s (Step 4-6) ===
  if (state.agent.mqtt) clearInterval(state.agent.mqtt);
  state.agent.mqtt = setInterval(async () => {
    const deltaKwh = +(Math.random()*0.6 + 0.2).toFixed(3);
    state.agent.consumed = +(state.agent.consumed + deltaKwh).toFixed(3);
    agentEvent(`IoT→MQTT: +${deltaKwh} kWh (total ${state.agent.consumed})`);

    // Price to use
    const price = state.agent.session.priceAEkWh;
    const pct = Math.min(100, (state.agent.consumed / state.agent.session.kwhGoal) * 100);
    ui.agent?.pbar && (ui.agent.pbar.style.width = `${pct}%`);
    ui.agent?.ptxt && (ui.agent.ptxt.textContent = `${Math.floor(pct)}%`);

    // Step 5: oracle "verifies"
    agentEvent(`Oracle ${shortAddr(state.agent.session.oracleId)}: reading verified`);

    // Step 6: SC debits (by update)
    const sessId = state.agent.session.id;
    if (sessId != null) {
      try {
        const kwhInt = kwhToInt(deltaKwh);
        await (await getContract()).methods.update_consumption_reading(sessId, kwhInt);
        agentEvent(`SC: update_consumption_reading(+${kwhInt} mWh)`);
      } catch (e) {
        console.warn('update_consumption_reading failed (mock continues):', e?.message || e);
      }
    }

    // End session when we reach goal
    if (state.agent.consumed >= state.agent.session.kwhGoal) {
      clearInterval(state.agent.mqtt); state.agent.mqtt = null;
      setAgentStatus('settling');
      agentEvent('Vehicle: Stop charging');

      // Step 7-9: Final payment and close
      try {
        const totalIntKwh = kwhToInt(state.agent.consumed);
        if (state.agent.session.id != null) {
          await (await getContract()).methods.stop_consumption(state.agent.session.id, totalIntKwh);
          agentEvent('SC: stop_consumption → session closed ✅');
        }
      } catch (e) {
        console.warn('stop_consumption failed (mock continues):', e?.message || e);
      }

      // (UI) we reflect payment to provider in the feed — the contract does it on-chain;
      // here we only show a "visual echo".
      const totalAE = +(state.agent.consumed * price).toFixed(6);
      pushPayment(st, {
        id: crypto.randomUUID(),
        ts: Date.now(),
        from: st.id,
        to: state.agent.session.providerAddr,
        amountAE: totalAE,
        type: 'out',
        note: 'Auto-settlement (on-chain echo)',
      });

      setAgentStatus('settled');
      agentHistoryPush(st.id, {
        kwh: state.agent.consumed,
        totalAE: totalAE,
        utility: state.agent.session.providerAddr,
        startedAt: state.agent.session.startedAt,
        finishedAt: Date.now(),
      });

      state.agent.running = false;
      state.agent.session = null;
    }
  }, 5000);
}

function agentAutoSettle(st, session) {
  // register outgoing payment (Station → Utility)
  pushPayment(st, {
    id: crypto.randomUUID(),
    ts: Date.now(),
    from: st.id,
    to: session.utility,
    amountAE: session.totalAE,
    type: 'out',
    note: 'Auto-settlement (Station → Utility)',
  });

  agentEvent('Agent: automatic payment executed ✅');
  setAgentStatus('settled');
  agentHistoryPush(st.id, session);

  // reset session
  state.agent.running = false;
  state.agent.session = null;
}

function resetAgent(st) {
  // default values
  if (ui.agent?.kwh) ui.agent.kwh.value = 12;
  if (ui.agent?.tariff) ui.agent.tariff.value = st.priceAEkWh || 0.12;
  if (ui.agent?.utility) ui.agent.utility.value = '';
  agentComputeTotal();

  // progress/status
  state.agent.enabled = !!ui.agent?.toggle?.checked;
  state.agent.running = false;
  state.agent.pct = 0;
  if (ui.agent?.pbar) ui.agent.pbar.style.width = '0%';
  if (ui.agent?.ptxt) ui.agent.ptxt.textContent = '0%';
  setAgentStatus('idle');

  // clear events
  if (ui.agent?.events) ui.agent.events.innerHTML = '';
  if (ui.agent?.history) ui.agent.history.innerHTML = '';

  // paint previous history (if any)
  const prev = state.agent.history.get(st.id) || [];
  prev.forEach(sess => agentHistoryPush(st.id, sess));
}

function agentBindEvents(st) {
  ['input','change'].forEach(ev => {
    ui.agent.kwh?.addEventListener(ev, agentComputeTotal);
    ui.agent.tariff?.addEventListener(ev, agentComputeTotal);
  });
  ui.agent.toggle?.addEventListener('change', () => {
    state.agent.enabled = ui.agent.toggle.checked;
    setAgentStatus(state.agent.enabled ? (state.agent.running ? 'charging' : 'idle') : 'disabled');
  });
  ui.agent.arrival?.addEventListener('click', () => {
    agentEvent('Vehicle detected by IoT (simulated)');
    if (state.agent.enabled) agentStartSession(st);
    else agentEvent('Agent disabled: session not started');
  });
  ui.agent.reset?.addEventListener('click', () => resetAgent(st));
  document.getElementById('agent-fund')?.addEventListener('click', async () => {
    try {
      await scFundCharger(st, 5);
      agentEvent('✅ Charger funded with 5 AE');
    } catch (e) {
      agentEvent(`❌ Error funding: ${e.message}`);
    }
  });
}

/***** UI Events *****/
// Navbar
ui.nav.devices?.addEventListener('click', () => {
  renderDevicesList();
  showPage(ui.pages.devices);
});
ui.nav.home?.addEventListener('click', () => showPage(ui.pages.home));
ui.nav.tx?.addEventListener('click', () => showPage(ui.pages.tx));

// Botones hero ya existentes
document.getElementById('hero-devices-btn')?.addEventListener('click', () => {
  renderDevicesList();
  showPage(ui.pages.devices);
});

// Detail back button
document.getElementById('device-detail-back-btn')?.addEventListener('click', () => {
  if (state.selectedStation) stopPaymentsStream(state.selectedStation.id);
  showPage(ui.pages.devices);
});

// Payments controls
ui.paymentsCtl.pause?.addEventListener('click', () => {
  state.livePaymentsPaused = true;
  ui.paymentsCtl.status.textContent = 'paused';
});
ui.paymentsCtl.resume?.addEventListener('click', () => {
  state.livePaymentsPaused = false;
  ui.paymentsCtl.status.textContent = 'live';
});

// Agent events are handled in agentBindEvents()

// Initial
document.addEventListener('DOMContentLoaded', () => {
  renderStats();
  renderDevicesList(); // so "Devices" is already ready on first click
  // you can also seed "Recent Devices" if you want
});

// Make functions globally available for console
window.setContractAddress = setContractAddress;
window.scFundCharger = scFundCharger;
window.getContract = getContract;