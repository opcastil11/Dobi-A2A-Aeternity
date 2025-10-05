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
  aeSdk = new AeSdkAepp({
    name: 'Dobi Protocol',
    nodes: [
      { name: 'testnet', instance: new Node(TESTNET_NODE_URL) },
      { name: 'mainnet', instance: new Node(MAINNET_NODE_URL) },
    ],
    compilerUrl: COMPILER_URL,
    onNetworkChange: async ({ networkId }) => {
      // Automatically select the node that matches the wallet network
      const [{ name }] = (await aeSdk.getNodesInPool())
        .filter((n) => n.nodeNetworkId === networkId);
      aeSdk.selectNode(name);
      const el = $('#summary-network');
      if (el) el.textContent = name === 'mainnet' ? 'Aeternity Mainnet' : 'Aeternity Testnet';
    },
    onAddressChange: ({ current }) => {
      const addr = Object.keys(current)[0];
      currentAddress = addr;
      setWalletText(short(addr));
      setOwner(addr);
      if (connected) updateBalance();
    },
    onDisconnect: () => {
      connected = false;
      currentAddress = undefined;
      setWalletText('Connect Wallet');
      setOwner('-');
      setBalance('0');
      alert('Wallet disconnected');
    },
  });
}

// ===== Contract lazy init =====
let ct; // contract instance

async function getContract() {
  // Disabled - using mode only
  throw new Error('Smart contract interaction disabled');
}

// ===== units and conversions =====
// We will use integers: kWh_int := kWh * 1000 (milli-kWh). Prices/costs in aettos (1 AE = 1e18 aettos).
const toAettos = (ae) => BigInt(Math.round(Number(ae) * 1e18));
const fromAettos = (aettos) => Number(aettos) / 1e18;
const kwhToInt = (kwh) => Math.max(0, Math.round(Number(kwh) * 1000)); // mWh
const intToKwh = (n) => Number(n) / 1000;

// Provider: a "readable" ID. By default, we derive from the destination address.
function deriveProviderId(payeeAddress) {
  return `prov_${(payeeAddress || 'ak_utility_provider').slice(-8)}`;
}

// Oracle in Sophia: expects type oracle(string,int) => ID "ok_..."
// If the user enters an ak_, we treat it as placeholder and warn.
function getOracleIdFromUI() {
  const raw = (ui.agent?.utility?.value || '').trim();
  if (raw.startsWith('ok_')) return raw;          // real OK
  if (raw.startsWith('ak_')) return 'ok_placeholder';    // placeholder while you don't register oracle on-chain
  return raw || 'ok_placeholder';
}

// === Chargers/Providers ===
async function scEnsureCharger(st) {
  // Disabled - using mode only
  agentEvent(`SC: register_charger(${st.id})`);
}

async function scEnsureProvider(payeeAddr, priceAEkWh) {
  // Disabled - using mode only
  const provId = deriveProviderId(payeeAddr);
  agentEvent(`SC: register_provider(${provId}) price=${priceAEkWh} AE/kWh`);
  return provId;
}

async function scFundCharger(st, amountAE) {
  // Disabled - using mode only
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
      
      // Initialize EV Charger Manager if available
      if (evChargerManager && !evChargerManager.connected) {
        try {
          evChargerManager.currentAddress = addr;
          evChargerManager.connected = true;
          // Skip contract initialization
        } catch (error) {
        }
      }
    } catch (err) {
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
    setBalance('0');
  }
}

// Hook UI
document.addEventListener('DOMContentLoaded', async () => {
  // Verify that SDK is loaded
  if (!window.Aeternity) {
    document.body.innerHTML = '<div style="color: white; text-align: center; padding: 50px;">Error: Aeternity SDK could not be loaded. Please reload the page.</div>';
    return;
  }

  // Protection against conflicts with window.ethereum
  try {
    const ethereumDesc = Object.getOwnPropertyDescriptor(window, 'ethereum');
    if (ethereumDesc && !ethereumDesc.configurable) {
    }
  } catch (e) {
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

/***** Charging stations *****/
const stations = [
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
  stations: stations,
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

/***** Stream of incoming payments *****/
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
      note: 'Driver top-up',
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
  // address placeholder tipo ak_...
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
    providerAddr: ui.agent.utility?.value || 'ak_utility_provider',
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

    // Simulate session start
    state.agent.session.id = Math.floor(Math.random() * 10000); // session_id
    agentEvent(`SC: ConsumptionStarted(session=${state.agent.session.id})`);
  } catch (err) {
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
        agentEvent(`SC: update_consumption_reading(+${kwhInt} mWh)`);
      } catch (e) {
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
          agentEvent('SC: stop_consumption → session closed ✅');
        }
      } catch (e) {
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
    agentEvent('Vehicle detected by IoT');
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

// EV Charger Integration
let evChargerManager = null;

async function initEVChargerManager() {
    if (!window.EVChargerManager) {
        return;
    }
    
    evChargerManager = new window.EVChargerManager();
    await evChargerManager.init();
}

// Enhanced wallet connection with EV Charger support (wrapper function)
async function connectWalletWithEVSupport() {
    // Just use the original connectWallet function
    // The EV Charger Manager will be initialized automatically after connection
    return await connectWallet();
}

// Basic device creation function
async function createDevice(deviceData) {
    // For now, just store in localStorage (can be enhanced later)
    const devices = JSON.parse(localStorage.getItem('dobi_devices') || '[]');
    const newDevice = {
        id: Date.now().toString(),
        ...deviceData,
        created_at: new Date().toISOString(),
        status: 'active'
    };
    devices.push(newDevice);
    localStorage.setItem('dobi_devices', JSON.stringify(devices));
    return newDevice;
}

// Enhanced device creation with EV Charger support
async function createDeviceWithEVSupport(deviceData) {
    try {
        if (deviceData.type === 'ev_charger' && evChargerManager && evChargerManager.connected) {
            // Register charger on blockchain
            const chargerId = deviceData.device_id;
            const location = deviceData.location;
            const initialBalance = parseInt(deviceData.initial_balance) || 10000;
            
            await evChargerManager.registerCharger(chargerId, location, initialBalance);
            
            // Also register as electricity provider
            const providerId = `PROVIDER_${chargerId}`;
            const providerName = `${deviceData.name} Provider`;
            const pricePerKwh = Math.round((parseFloat(deviceData.price_per_kwh) || 0.12) * 1000000000000000000);
            
            await evChargerManager.registerProvider(providerId, providerName, pricePerKwh);
        }
        
        // Continue with normal device creation
        return await createDevice(deviceData);
    } catch (error) {
        throw error;
    }
}

// Basic device detail view function
function showDeviceDetail(device) {
    // Update device summary information
    const summaryDeviceId = document.getElementById('summary-device-id');
    const summaryStatus = document.getElementById('summary-status');
    const summaryLocation = document.getElementById('summary-location');
    const summaryOwner = document.getElementById('summary-owner');
    const summaryType = document.getElementById('summary-type');
    const summaryDescription = document.getElementById('summary-description');
    
    if (summaryDeviceId) summaryDeviceId.textContent = device.device_id || '-';
    if (summaryStatus) {
        summaryStatus.textContent = device.status || 'active';
        summaryStatus.className = `status-badge ${device.status === 'active' ? 'active' : 'inactive'}`;
    }
    if (summaryLocation) summaryLocation.textContent = device.location || '-';
    if (summaryOwner) summaryOwner.textContent = device.owner || '-';
    if (summaryType) summaryType.textContent = device.type || '-';
    if (summaryDescription) summaryDescription.textContent = device.description || '-';
    
    // Update device detail title
    const deviceDetailTitle = document.getElementById('device-detail-title');
    if (deviceDetailTitle) {
        deviceDetailTitle.textContent = `${device.name || device.device_id} Details`;
    }
    
    // Show device detail page
    showPage(ui.pages.deviceDetail);
}

// Enhanced device detail view with EV Charger management
function showDeviceDetailWithEVSupport(device) {
    // Set current device context
    setCurrentDevice(device);
    
    showDeviceDetail(device);
    
    // Show EV Charger management if device is an EV Charger
    if (device.type === 'ev_charger') {
        if (evChargerManager) {
            evChargerManager.setCurrentChargerId(device.device_id);
            evChargerManager.showChargerManagement();
            
            // Load charger data and providers if connected
            if (evChargerManager.connected && connected) {
                evChargerManager.loadChargerData(device.device_id).catch(() => {});
                evChargerManager.loadProviders().catch(() => {});
            } else {
                // Show providers even if not connected (for demo purposes)
                evChargerManager.loadProviders().catch(() => {});
            }
        }
    } else {
        if (evChargerManager) {
            evChargerManager.hideChargerManagement();
        }
    }
}

// EV Charger specific event handlers
function bindEVChargerEvents() {
    // Fund charger button
    const fundChargerBtn = document.getElementById('fund-charger');
    if (fundChargerBtn) {
        fundChargerBtn.addEventListener('click', async () => {
            if (!connected) {
                showToast('Please connect wallet first', 'error');
                return;
            }
            
            if (!evChargerManager || !evChargerManager.connected) {
                showToast('EV Charger Manager not ready', 'error');
                return;
            }
            
            try {
                const currentDevice = getCurrentDevice();
                if (currentDevice && currentDevice.type === 'ev_charger') {
                    await evChargerManager.fundCharger(currentDevice.device_id, 1000);
                    showToast('Charger funded successfully!', 'success');
                    await evChargerManager.loadChargerData(currentDevice.device_id);
                }
            } catch (error) {
                showToast('Failed to fund charger: ' + error.message, 'error');
            }
        });
    }
    
    // View charger details button
    const viewChargerDetailsBtn = document.getElementById('view-charger-details');
    if (viewChargerDetailsBtn) {
        viewChargerDetailsBtn.addEventListener('click', () => {
            // Open operator.html in new tab
            window.open('./operator.html', '_blank');
        });
    }
    
    // Stop charging button
    const stopChargingBtn = document.getElementById('stop-charging-btn');
    if (stopChargingBtn) {
        stopChargingBtn.addEventListener('click', async () => {
            if (!connected) {
                showToast('Please connect wallet first', 'error');
                return;
            }
            
            if (!evChargerManager) {
                showToast('EV Charger Manager not initialized', 'error');
                return;
            }
            
            try {
                await evChargerManager.stopChargingSession();
            } catch (error) {
                showToast('Failed to stop charging session: ' + error.message, 'error');
            }
        });
    }
}

// Enhanced device type selection with EV Charger fields
function bindDeviceTypeSelection() {
    const deviceTypeBtns = document.querySelectorAll('.device-type-btn');
    const evChargerFields = document.getElementById('ev-charger-fields');
    
    deviceTypeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            // Remove active class from all buttons
            deviceTypeBtns.forEach(b => b.classList.remove('active'));
            // Add active class to clicked button
            btn.classList.add('active');
            
            // Show/hide EV Charger specific fields
            if (btn.dataset.type === 'ev_charger' && evChargerFields) {
                evChargerFields.style.display = 'block';
            } else if (evChargerFields) {
                evChargerFields.style.display = 'none';
            }
        });
    });
}

// Initialize EV Charger Manager when DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
    await initEVChargerManager();
    bindEVChargerEvents();
    bindDeviceTypeSelection();
});

// Get current device from context
function getCurrentDevice() {
    // This should be set when showing device details
    return window.currentDevice || null;
}

// Set current device context
function setCurrentDevice(device) {
    window.currentDevice = device;
}

// Make functions globally available for console
// Transaction management
let transactionCounter = 8; // Starting from 8 since we have 8 initial transactions

function addMoreTransactions() {
  const transactionsList = document.getElementById('transactions-list');
  if (!transactionsList) return;

  const moreTransactions = [
    {
      icon: 'fas fa-charging-station',
      title: 'EV Charging Session',
      description: `Session #${8473 + transactionCounter} - Green Energy Co.`,
      time: `${transactionCounter + 1} hours ago`,
      amount: `+${(Math.random() * 0.3 + 0.1).toFixed(3)} AE`,
      type: 'positive'
    },
    {
      icon: 'fas fa-bolt',
      title: 'Electricity Payment',
      description: 'Payment to Solar Power Ltd.',
      time: `${transactionCounter + 2} hours ago`,
      amount: `-${(Math.random() * 0.2 + 0.05).toFixed(3)} AE`,
      type: 'negative'
    },
    {
      icon: 'fas fa-wallet',
      title: 'Wallet Top-up',
      description: 'Added AE to wallet',
      time: `${transactionCounter + 3} hours ago`,
      amount: `+${(Math.random() * 5 + 5).toFixed(3)} AE`,
      type: 'positive'
    }
  ];

  moreTransactions.forEach(tx => {
    const transactionItem = document.createElement('div');
    transactionItem.className = 'transaction-item';
    transactionItem.innerHTML = `
      <div class="transaction-icon">
        <i class="${tx.icon}"></i>
      </div>
      <div class="transaction-details">
        <div class="transaction-title">${tx.title}</div>
        <div class="transaction-description">${tx.description}</div>
        <div class="transaction-time">${tx.time}</div>
      </div>
      <div class="transaction-amount ${tx.type}">
        ${tx.amount}
      </div>
    `;
    transactionsList.appendChild(transactionItem);
  });

  transactionCounter += 3;
  
  // Update total transactions counter
  const totalTransactions = document.getElementById('total-transactions');
  if (totalTransactions) {
    const currentTotal = parseInt(totalTransactions.textContent);
    totalTransactions.textContent = currentTotal + 3;
  }
}

// Device Logs functionality
let logCounter = 15; // Starting from 15 since we have 15 initial logs

function addNewLog() {
  const logsList = document.getElementById('device-logs-list');
  if (!logsList) return;

  const currentTime = new Date();
  const timestamp = currentTime.toISOString().replace('T', ' ').substring(0, 19);
  
  const logTypes = [
    {
      level: 'info',
      message: `EV Charger ST-002: Consumption reading updated - ${(Math.random() * 3 + 1).toFixed(2)} kWh consumed`
    },
    {
      level: 'success',
      message: `Blockchain: Payment transaction confirmed - ${(Math.random() * 0.5 + 0.1).toFixed(3)} AE to provider`
    },
    {
      level: 'info',
      message: `IoT Gateway: Received sensor data from device ST-00${Math.floor(Math.random() * 3 + 1)}`
    },
    {
      level: 'warning',
      message: `Device ST-00${Math.floor(Math.random() * 3 + 1)}: Network latency increased to ${Math.floor(Math.random() * 100 + 200)}ms`
    },
    {
      level: 'success',
      message: `Oracle: Verified consumption reading for session #${8473 + logCounter}`
    },
    {
      level: 'info',
      message: `System: Health check completed - All devices operational`
    }
  ];

  const randomLog = logTypes[Math.floor(Math.random() * logTypes.length)];
  
  const logEntry = document.createElement('div');
  logEntry.className = 'log-entry';
  logEntry.innerHTML = `
    <div class="log-timestamp">${timestamp}</div>
    <div class="log-level ${randomLog.level}">${randomLog.level.toUpperCase()}</div>
    <div class="log-message">${randomLog.message}</div>
  `;
  
  // Insert at the top of the logs list
  logsList.insertBefore(logEntry, logsList.firstChild);
  
  // Keep only the last 20 logs
  while (logsList.children.length > 20) {
    logsList.removeChild(logsList.lastChild);
  }
  
  logCounter++;
}

function refreshDeviceLogs() {
  // Add 3-5 new logs when refreshing
  const numNewLogs = Math.floor(Math.random() * 3) + 3;
  for (let i = 0; i < numNewLogs; i++) {
    setTimeout(() => addNewLog(), i * 200); // Stagger the additions
  }
}

// Initialize transaction functionality
document.addEventListener('DOMContentLoaded', () => {
  const loadMoreBtn = document.getElementById('load-more-transactions');
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', addMoreTransactions);
  }

  // Initialize device logs functionality
  const refreshLogsBtn = document.getElementById('refresh-device-logs');
  if (refreshLogsBtn) {
    refreshLogsBtn.addEventListener('click', refreshDeviceLogs);
  }

  // Auto-add logs every 30 seconds
  setInterval(addNewLog, 30000);

  // Initialize Dobi Assistant chat functionality
  const botInput = document.getElementById('bot-input');
  const sendBotMessageBtn = document.getElementById('send-bot-message');
  const botMessages = document.getElementById('bot-messages');

  function addBotMessage(message, isUser = false) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `bot-message ${isUser ? 'user-message' : ''}`;
    
    if (!isUser) {
      messageDiv.innerHTML = `
        <div class="bot-avatar">
          <img src="images/dobi-logo2.png" alt="Dobi Logo" class="bot-avatar-img">
        </div>
        <div class="message-content">
          <p>${message}</p>
        </div>
      `;
    } else {
      messageDiv.innerHTML = `
        <div class="message-content user-content">
          <p>${message}</p>
        </div>
        <div class="user-avatar">
          <i class="fas fa-user"></i>
        </div>
      `;
    }
    
    botMessages.appendChild(messageDiv);
    botMessages.scrollTop = botMessages.scrollHeight;
  }

  function sendMessage() {
    const message = botInput.value.trim();
    if (!message) return;

    // Add user message
    addBotMessage(message, true);
    botInput.value = '';

    // Simulate typing delay
    setTimeout(() => {
      const responses = [
        "I understand you're asking about that feature. Unfortunately, this functionality is not yet implemented in the current version of the Dobi Protocol.",
        "That's a great question! However, this feature is still under development and will be available in a future update.",
        "I'd love to help with that, but this particular functionality hasn't been implemented yet. Stay tuned for updates!",
        "Thanks for your interest in that feature. It's currently in development and will be released soon.",
        "I'm sorry, but that feature is not available yet. The development team is working on implementing it for future releases.",
        "That's an interesting request! This functionality is planned for upcoming versions of the Dobi Protocol.",
        "I understand what you're looking for, but this feature is still being developed. Check back later for updates!",
        "Great question! This feature is on our roadmap but hasn't been implemented yet. We're working on it!"
      ];
      
      const randomResponse = responses[Math.floor(Math.random() * responses.length)];
      addBotMessage(randomResponse);
    }, 1000 + Math.random() * 2000); // 1-3 second delay
  }

  if (sendBotMessageBtn) {
    sendBotMessageBtn.addEventListener('click', sendMessage);
  }

  if (botInput) {
    botInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        sendMessage();
      }
    });
  }
});

window.setContractAddress = setContractAddress;
window.scFundCharger = scFundCharger;
window.getContract = getContract;
window.evChargerManager = evChargerManager;
window.connectWalletWithEVSupport = connectWalletWithEVSupport;
window.getCurrentDevice = getCurrentDevice;
window.setCurrentDevice = setCurrentDevice;