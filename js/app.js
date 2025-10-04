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

// ===== On-chain config =====
const CONTRACT_SOURCE_URL = '/AIPaymentManager.aes';     // servido por tu server estático
let CONTRACT_ADDRESS = localStorage.getItem('contract_addr') || ''; // pega aquí la que desplegaste si quieres fijo

function setContractAddress(addr) {
  CONTRACT_ADDRESS = addr;
  localStorage.setItem('contract_addr', addr);
  const el = document.getElementById('summary-contract-address');
  if (el) el.textContent = addr || '-';
}

// Establecer la dirección del contrato desplegado
setContractAddress('ct_gWCgyfWtVYAYXD2zwPQHxLK6btmvjhPhZE9XVmSzpaVNVPjb7');
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

// ===== Contract lazy init =====
let ct; // instancia del contrato

async function getContract() {
  if (ct) return ct;
  if (!CONTRACT_ADDRESS) throw new Error('CONTRACT_ADDRESS vacío. Usa setContractAddress("ct_...").');

  const res = await fetch(CONTRACT_SOURCE_URL);
  if (!res.ok) throw new Error(`No pude leer ${CONTRACT_SOURCE_URL} (${res.status})`);
  const sourceCode = await res.text();

  // v14 en navegador: initializeContract; fallback a Contract.initialize si hiciera falta
  if (typeof aeSdk.initializeContract === 'function') {
    ct = await aeSdk.initializeContract({ sourceCode, address: CONTRACT_ADDRESS });
  } else if (window.Aeternity?.Contract?.initialize) {
    // fallback (misma API que usas en deploy.js del lado Node)
    ct = await window.Aeternity.Contract.initialize({
      ...aeSdk.getContext?.(),
      sourceCode,
      address: CONTRACT_ADDRESS,
    });
  } else {
    throw new Error('Tu SDK no expone initializeContract ni Contract.initialize');
  }
  return ct;
}

// ===== unidades y conversiones =====
// Usaremos enteros: kWh_int := kWh * 1000 (milli-kWh). Precios/costos en aettos (1 AE = 1e18 aettos).
const toAettos = (ae) => BigInt(Math.round(Number(ae) * 1e18));
const fromAettos = (aettos) => Number(aettos) / 1e18;
const kwhToInt = (kwh) => Math.max(0, Math.round(Number(kwh) * 1000)); // mWh
const intToKwh = (n) => Number(n) / 1000;

// Proveedor: un ID "legible". Por defecto, derivamos del address destino.
function deriveProviderId(payeeAddress) {
  return `prov_${(payeeAddress || 'ak_utility_mock').slice(-8)}`;
}

// Oráculo en Sophia: espera tipo oracle(string,int) => ID "ok_..."
// Si el usuario pone una ak_, la tratamos como mock y advertimos.
function getOracleIdFromUI() {
  const raw = (ui.agent?.utility?.value || '').trim();
  if (raw.startsWith('ok_')) return raw;          // OK real
  if (raw.startsWith('ak_')) return 'ok_mock';    // placeholder mientras no registres oráculo on-chain
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

/***** MOCK: estaciones de carga *****/
const mockStations = [
  {
    id: 'ST-001',
    name: 'Dobi Station - Centro',
    location: 'Av. Libertador 123, Santiago',
    status: 'available',
    powerKw: 22,
    priceAEkWh: 0.12,
    connectors: ['Type2', 'CCS2'],
    description: 'Punto público en estacionamiento subterráneo',
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
    description: 'Rápida DC, 50kW',
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
    description: 'Carga lenta residencial',
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

/***** Render listado de estaciones *****/
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

  // delegación: abrir detalle
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

/***** Abrir detalle de estación *****/
function openDeviceDetail(id) {
  const st = state.stations.find(s => s.id === id);
  if (!st) return;
  state.selectedStation = st;

  // Rellenar sumario
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

  // Reset agente
  resetAgent(st);
  agentBindEvents(st);

  // Render pagos existentes y arrancar stream live
  renderPayments(st);
  startPaymentsStream(st);

  // Mostrar página
  showPage(ui.pages.detail);

  // opcional: simula llegada automática a los 2–5s
  setTimeout(() => {
    if (!state.agent.running && state.agent.enabled) {
      agentEvent('Vehículo detectado por IoT (auto)');
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

  // pintar arriba del todo
  const list = ui.lists.payments;
  if (list) {
    list.prepend(paymentItem(payment));
  }
}

/***** Stream de pagos "entrantes" simulados *****/
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

/***** Utilidades *****/
function randomAk() {
  // address mock tipo ak_...
  const base = btoa(String(Math.random())).replace(/[^a-zA-Z0-9]/g,'').slice(0, 30);
  return `ak_${base}${Math.floor(Math.random()*1000)}`;
}

/***** Agente automático *****/
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
    agentEvent('Wallet no conectada: intentando conectar…');
    await connectWallet();
    if (!connected) {
      agentEvent('❌ No se pudo conectar la wallet. Sesión sólo visual.');
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

  // === Paso 2–3: App -> SC (arrancar sesión) ===
  agentEvent(`App: Iniciar carga en ${st.id}`);
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
    agentEvent('❌ SC: start_consumption falló. Seguimos en modo visual.');
  }

  // === Lecturas IoT cada 5s (Paso 4–6) ===
  if (state.agent.mqtt) clearInterval(state.agent.mqtt);
  state.agent.mqtt = setInterval(async () => {
    const deltaKwh = +(Math.random()*0.6 + 0.2).toFixed(3);
    state.agent.consumed = +(state.agent.consumed + deltaKwh).toFixed(3);
    agentEvent(`IoT→MQTT: +${deltaKwh} kWh (total ${state.agent.consumed})`);

    // Precio a usar
    const price = state.agent.session.priceAEkWh;
    const pct = Math.min(100, (state.agent.consumed / state.agent.session.kwhGoal) * 100);
    ui.agent?.pbar && (ui.agent.pbar.style.width = `${pct}%`);
    ui.agent?.ptxt && (ui.agent.ptxt.textContent = `${Math.floor(pct)}%`);

    // Paso 5: oráculo "verifica"
    agentEvent(`Oracle ${shortAddr(state.agent.session.oracleId)}: lectura verificada`);

    // Paso 6: SC debita (por actualización)
    const sessId = state.agent.session.id;
    if (sessId != null) {
      try {
        const kwhInt = kwhToInt(deltaKwh);
        await (await getContract()).methods.update_consumption_reading(sessId, kwhInt);
        agentEvent(`SC: update_consumption_reading(+${kwhInt} mWh)`);
      } catch (e) {
        console.warn('update_consumption_reading falló (mock continúa):', e?.message || e);
      }
    }

    // Terminar sesión cuando alcanzamos objetivo
    if (state.agent.consumed >= state.agent.session.kwhGoal) {
      clearInterval(state.agent.mqtt); state.agent.mqtt = null;
      setAgentStatus('settling');
      agentEvent('Vehículo: Detener carga');

      // Paso 7–9: Pago final y cierre
      try {
        const totalIntKwh = kwhToInt(state.agent.consumed);
        if (state.agent.session.id != null) {
          await (await getContract()).methods.stop_consumption(state.agent.session.id, totalIntKwh);
          agentEvent('SC: stop_consumption → sesión cerrada ✅');
        }
      } catch (e) {
        console.warn('stop_consumption falló (mock continúa):', e?.message || e);
      }

      // (UI) reflejamos pago a provider en el feed — el contrato lo hace on-chain;
      // aquí sólo mostramos un "echo visual".
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
  // registrar pago de salida (Station → Utility)
  pushPayment(st, {
    id: crypto.randomUUID(),
    ts: Date.now(),
    from: st.id,
    to: session.utility,
    amountAE: session.totalAE,
    type: 'out',
    note: 'Auto-settlement (Station → Utility)',
  });

  agentEvent('Agent: pago automático ejecutado ✅');
  setAgentStatus('settled');
  agentHistoryPush(st.id, session);

  // reset sesión
  state.agent.running = false;
  state.agent.session = null;
}

function resetAgent(st) {
  // valores por defecto
  if (ui.agent?.kwh) ui.agent.kwh.value = 12;
  if (ui.agent?.tariff) ui.agent.tariff.value = st.priceAEkWh || 0.12;
  if (ui.agent?.utility) ui.agent.utility.value = '';
  agentComputeTotal();

  // progreso/estado
  state.agent.enabled = !!ui.agent?.toggle?.checked;
  state.agent.running = false;
  state.agent.pct = 0;
  if (ui.agent?.pbar) ui.agent.pbar.style.width = '0%';
  if (ui.agent?.ptxt) ui.agent.ptxt.textContent = '0%';
  setAgentStatus('idle');

  // limpiar eventos
  if (ui.agent?.events) ui.agent.events.innerHTML = '';
  if (ui.agent?.history) ui.agent.history.innerHTML = '';

  // pintar historial previo (si hay)
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
    agentEvent('Vehículo detectado por IoT (simulado)');
    if (state.agent.enabled) agentStartSession(st);
    else agentEvent('Agente deshabilitado: no se inicia sesión');
  });
  ui.agent.reset?.addEventListener('click', () => resetAgent(st));
  document.getElementById('agent-fund')?.addEventListener('click', async () => {
    try {
      await scFundCharger(st, 5);
      agentEvent('✅ Cargador fundido con 5 AE');
    } catch (e) {
      agentEvent(`❌ Error fundiendo: ${e.message}`);
    }
  });
}

/***** Eventos UI *****/
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

// Botón back del detalle
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

// Los eventos del agente se manejan en agentBindEvents()

// Inicial
document.addEventListener('DOMContentLoaded', () => {
  renderStats();
  renderDevicesList(); // para que "Devices" ya esté listo al primer click
  // puedes también sembrar "Recent Devices" si quieres
});

// Hacer funciones disponibles globalmente para la consola
window.setContractAddress = setContractAddress;
window.scFundCharger = scFundCharger;
window.getContract = getContract;