// ============================================
// COMPLETE IoT ORACLE INTEGRATION FOR EV CHARGER
// Connects: IoT Meter → Oracle → Smart Contract
// ============================================

const { AeSdk, Node, MemoryAccount, CompilerHttp } = require('@aeternity/aepp-sdk');
const mqtt = require('mqtt');
const express = require('express');
const fs = require('fs');

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
  // æternity Network
  nodeUrl: process.env.NODE_URL || 'https://testnet.aeternity.io',
  compilerUrl: 'https://compiler.aepps.com',
  
  // Smart Contract
  contractAddress: process.env.CONTRACT_ADDRESS || 'ct_YourContractAddress',
  contractSource: './ChargerElectricityPayment.aes', // Path to contract source
  
  // Oracle Account
  oracleSecretKey: process.env.ORACLE_SECRET_KEY || 'sk_YourOracleSecretKey',
  
  // MQTT Configuration (IoT Meter)
  mqttBroker: process.env.MQTT_BROKER || 'mqtt://localhost:1883',
  mqttTopic: 'charger/+/consumption', // + is wildcard for charger_id
  
  // Update Settings
  updateIntervalSeconds: parseInt(process.env.UPDATE_INTERVAL) || 10,
  minKwhIncrement: parseFloat(process.env.MIN_KWH_INCREMENT) || 0.1,
  
  // API Server
  apiPort: parseInt(process.env.API_PORT) || 3000
};

// ============================================
// ORACLE CLASS
// ============================================

class ChargerOracle {
  constructor() {
    this.aeSdk = null;
    this.contract = null;
    this.oracleId = null;
    this.mqttClient = null;
    this.activeSessions = new Map(); // sessionId -> sessionData
    this.lastReadings = new Map();   // sessionId -> lastKwhValue
    this.address = null;
  }

  // Initialize connection to æternity
  async initialize() {
    console.log('🚀 Initializing Oracle System...\n');
    
    try {
      // Connect to æternity node
      const node = new Node(CONFIG.nodeUrl);
      const account = new MemoryAccount(CONFIG.oracleSecretKey);
      
      this.aeSdk = new AeSdk({
        nodes: [{ name: 'testnet', instance: node }],
        accounts: [account],
        onCompiler: new CompilerHttp(CONFIG.compilerUrl)
      });

      this.address = await this.aeSdk.address();
      
      console.log('✅ Connected to æternity network');
      console.log(`📍 Oracle Address: ${this.address}`);
      console.log(`🌐 Node: ${CONFIG.nodeUrl}\n`);

      // Load and initialize contract
      await this.initializeContract();
      
      // Register as oracle
      await this.registerOracle();
      
      console.log('✅ Oracle initialization complete\n');

    } catch (error) {
      console.error('❌ Initialization failed:', error.message);
      throw error;
    }
  }

  // Load and connect to smart contract
  async initializeContract() {
    try {
      console.log('📄 Loading smart contract...');
      
      // Read contract source
      const sourceCode = fs.readFileSync(CONFIG.contractSource, 'utf-8');
      
      // Initialize contract instance
      this.contract = await this.aeSdk.initializeContract({
        sourceCode,
        address: CONFIG.contractAddress
      });

      console.log(`✅ Contract loaded: ${CONFIG.contractAddress}\n`);

    } catch (error) {
      console.error('❌ Failed to load contract:', error.message);
      throw error;
    }
  }

  // Register as oracle on æternity
  async registerOracle() {
    try {
      console.log('🔮 Registering as oracle...');
      
      // Register oracle with query/response formats
      this.oracleId = await this.aeSdk.registerOracle(
        'string',  // Query format: "charger_id,kwh_reading"
        'int',     // Response format: kWh as integer (x100 for decimals)
        {
          queryFee: 0,
          oracleTtl: { type: 'delta', value: 500 },
          responseTtl: { type: 'delta', value: 100 }
        }
      );
      
      console.log(`✅ Oracle registered: ${this.oracleId}\n`);
      
    } catch (error) {
      // Oracle might already be registered
      console.log('ℹ️  Oracle may already be registered');
      this.oracleId = await this.aeSdk.getOracleObject(this.address);
      console.log(`📍 Using existing oracle: ${this.oracleId.id}\n`);
    }
  }

  // Connect to MQTT broker (IoT meter)
  async connectToIoT() {
    console.log('🔌 Connecting to IoT devices via MQTT...');
    console.log(`📡 Broker: ${CONFIG.mqttBroker}`);
    console.log(`📋 Topic: ${CONFIG.mqttTopic}\n`);
    
    this.mqttClient = mqtt.connect(CONFIG.mqttBroker);

    this.mqttClient.on('connect', () => {
      console.log('✅ Connected to MQTT Broker');
      
      this.mqttClient.subscribe(CONFIG.mqttTopic, (err) => {
        if (err) {
          console.error('❌ Subscription error:', err);
        } else {
          console.log('📡 Listening for IoT meter readings...\n');
        }
      });
    });

    this.mqttClient.on('message', (topic, message) => {
      this.handleIoTReading(topic, message);
    });

    this.mqttClient.on('error', (error) => {
      console.error('❌ MQTT Error:', error);
    });
  }

  // Process IoT meter reading
  async handleIoTReading(topic, message) {
    try {
      const reading = JSON.parse(message.toString());
      
      // Expected format:
      // {
      //   "charger_id": "CHARGER_001",
      //   "session_id": 12345,
      //   "kwh_reading": 5.75,
      //   "timestamp": 1234567890,
      //   "voltage": 220,
      //   "current": 32,
      //   "power": 7040
      // }

      const { session_id, charger_id, kwh_reading, timestamp } = reading;

      console.log(`\n📊 [${new Date(timestamp * 1000).toLocaleTimeString()}] IoT Reading Received`);
      console.log(`   Charger: ${charger_id}`);
      console.log(`   Session: ${session_id}`);
      console.log(`   kWh: ${kwh_reading}`);

      // Check if session is active
      if (!this.activeSessions.has(session_id)) {
        // Query contract to check if session exists
        const sessionData = await this.contract.get_session(session_id);
        
        if (sessionData && sessionData.status === 'Active') {
          this.activeSessions.set(session_id, sessionData);
          this.lastReadings.set(session_id, 0);
        } else {
          console.log(`   ⚠️  Session not active, ignoring`);
          return;
        }
      }

      // Check minimum increment
      const lastReading = this.lastReadings.get(session_id) || 0;
      const increment = kwh_reading - lastReading;

      if (increment >= CONFIG.minKwhIncrement) {
        console.log(`   ✓ Processing payment (increment: ${increment.toFixed(2)} kWh)`);
        await this.processPayment(session_id, kwh_reading);
        this.lastReadings.set(session_id, kwh_reading);
      } else {
        console.log(`   ℹ️  Increment too small, waiting for more consumption`);
      }

    } catch (error) {
      console.error(`\n❌ Error processing IoT reading:`, error.message);
    }
  }

  // Process payment on blockchain
  async processPayment(sessionId, kwhReading) {
    try {
      console.log(`\n💰 Processing Payment on Blockchain...`);
      console.log(`   Session ID: ${sessionId}`);
      console.log(`   kWh Reading: ${kwhReading}`);

      // Convert kWh to integer (multiply by 100 to keep 2 decimals)
      const kwhInt = Math.round(kwhReading * 100);

      // Call smart contract
      const result = await this.contract.update_consumption_reading(
        sessionId,
        kwhInt,
        { gasLimit: 50000 }
      );

      console.log(`✅ Payment Processed Successfully`);
      console.log(`   Transaction Hash: ${result.hash}`);
      console.log(`   Block Height: ${result.blockHeight || 'pending'}`);
      console.log(`   Gas Used: ${result.gasUsed || 'N/A'}\n`);

      // Emit event for monitoring/logging
      this.emitPaymentEvent({
        sessionId,
        kwhReading,
        txHash: result.hash,
        timestamp: Date.now()
      });

    } catch (error) {
      console.error(`\n❌ Payment Processing Failed:`, error.message);
      
      // Handle specific errors
      if (error.message.includes('INSUFFICIENT_BALANCE')) {
        console.log(`⚠️  Charger has insufficient balance`);
        console.log(`   Attempting to stop session...`);
        await this.stopSession(sessionId);
      } else if (error.message.includes('SESSION_NOT_ACTIVE')) {
        console.log(`ℹ️  Session already stopped, removing from active list`);
        this.activeSessions.delete(sessionId);
        this.lastReadings.delete(sessionId);
      }
    }
  }

  // Stop session
  async stopSession(sessionId) {
    try {
      console.log(`\n🛑 Stopping Session ${sessionId}...`);

      const lastReading = this.lastReadings.get(sessionId) || 0;
      const finalKwh = Math.round(lastReading * 100);

      const result = await this.contract.stop_consumption(
        sessionId,
        finalKwh
      );

      console.log(`✅ Session Stopped`);
      console.log(`   Final kWh: ${lastReading}`);
      console.log(`   Transaction: ${result.hash}\n`);

      // Cleanup
      this.activeSessions.delete(sessionId);
      this.lastReadings.delete(sessionId);

    } catch (error) {
      console.error(`❌ Error stopping session:`, error.message);
    }
  }

  // Emit payment event (for webhooks/logging)
  emitPaymentEvent(data) {
    // In production, send to logging service, webhook, database, etc.
    console.log(`📤 Event Emitted: PAYMENT_PROCESSED`);
    
    // Example: POST to webhook
    // axios.post('https://your-api.com/webhook/payment', data);
    
    // Example: Save to database
    // db.payments.insert(data);
  }

  // Monitor active sessions (cleanup stale sessions)
  startSessionMonitoring() {
    setInterval(async () => {
      console.log(`\n🔍 Monitoring ${this.activeSessions.size} active sessions...`);

      for (const [sessionId, sessionData] of this.activeSessions) {
        try {
          // Check session status on blockchain
          const currentSession = await this.contract.get_session(sessionId);
          
          if (!currentSession || currentSession.status !== 'Active') {
            console.log(`   ℹ️  Session ${sessionId} no longer active, removing`);
            this.activeSessions.delete(sessionId);
            this.lastReadings.delete(sessionId);
          }
        } catch (error) {
          console.error(`   ❌ Error checking session ${sessionId}:`, error.message);
        }
      }
    }, 60000); // Check every minute
  }

  // Start complete system
  async start() {
    try {
      await this.initialize();
      await this.connectToIoT();
      this.startSessionMonitoring();
      
      console.log('═══════════════════════════════════════════════════');
      console.log('✅ ORACLE SYSTEM FULLY OPERATIONAL');
      console.log('═══════════════════════════════════════════════════');
      console.log('📡 Listening for IoT meter readings...');
      console.log('💰 Auto-processing payments to blockchain...');
      console.log('🔍 Monitoring active sessions...\n');

    } catch (error) {
      console.error('❌ System startup failed:', error);
      process.exit(1);
    }
  }
}

// ============================================
// IoT METER SIMULATOR (For Testing)
// ============================================

class IoTMeterSimulator {
  constructor(mqttBroker, chargerId) {
    this.mqttClient = mqtt.connect(mqttBroker);
    this.chargerId = chargerId;
    this.sessionId = null;
    this.currentKwh = 0;
    this.interval = null;
  }

  startCharging(sessionId) {
    this.sessionId = sessionId;
    this.currentKwh = 0;

    console.log(`\n🔌 [IoT Simulator] Starting charge for ${this.chargerId}`);
    console.log(`   Session ID: ${sessionId}\n`);

    // Simulate kWh increment every 5 seconds
    this.interval = setInterval(() => {
      // Random increment between 0.5 and 2 kWh
      const increment = Math.random() * 1.5 + 0.5;
      this.currentKwh += increment;

      const reading = {
        charger_id: this.chargerId,
        session_id: this.sessionId,
        kwh_reading: Number(this.currentKwh.toFixed(2)),
        timestamp: Math.floor(Date.now() / 1000),
        voltage: 220 + Math.random() * 10 - 5,
        current: 30 + Math.random() * 4 - 2,
        power: 6600 + Math.random() * 400 - 200
      };

      // Publish to MQTT
      this.mqttClient.publish(
        `charger/${this.chargerId}/consumption`,
        JSON.stringify(reading)
      );

      console.log(`📊 [IoT Simulator] Reading: ${reading.kwh_reading} kWh`);

    }, 5000);
  }

  stopCharging() {
    if (this.interval) {
      clearInterval(this.interval);
      console.log(`\n🛑 [IoT Simulator] Charging stopped for ${this.chargerId}\n`);
    }
  }
}

// ============================================
// REST API (For Frontend Integration)
// ============================================

class OracleAPI {
  constructor(oracle) {
    this.oracle = oracle;
    this.app = express();
    this.app.use(express.json());
    
    this.setupRoutes();
  }

  setupRoutes() {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'operational',
        oracle_address: this.oracle.address,
        oracle_id: this.oracle.oracleId,
        active_sessions: this.oracle.activeSessions.size
      });
    });

    // Get active sessions
    this.app.get('/sessions', (req, res) => {
      const sessions = Array.from(this.oracle.activeSessions.entries()).map(([id, data]) => ({
        session_id: id,
        last_reading: this.oracle.lastReadings.get(id) || 0,
        ...data
      }));
      res.json({ sessions });
    });

    // Manually trigger session check
    this.app.post('/sessions/:id/check', async (req, res) => {
      try {
        const sessionId = parseInt(req.params.id);
        const session = await this.oracle.contract.get_session(sessionId);
        res.json({ session });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get oracle info
    this.app.get('/oracle', (req, res) => {
      res.json({
        address: this.oracle.address,
        oracle_id: this.oracle.oracleId,
        contract: CONFIG.contractAddress
      });
    });
  }

  start() {
    this.app.listen(CONFIG.apiPort, () => {
      console.log(`🌐 API Server running on port ${CONFIG.apiPort}`);
      console.log(`   Health: http://localhost:${CONFIG.apiPort}/health`);
      console.log(`   Sessions: http://localhost:${CONFIG.apiPort}/sessions\n`);
    });
  }
}

// ============================================
// MAIN EXECUTION
// ============================================

async function main() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('⚡ EV CHARGER ORACLE SYSTEM');
  console.log('═══════════════════════════════════════════════════\n');

  // Create and start oracle
  const oracle = new ChargerOracle();
  await oracle.start();

  // Start REST API
  const api = new OracleAPI(oracle);
  api.start();

  // OPTIONAL: Start IoT simulator for testing
  if (process.env.SIMULATE_IOT === 'true') {
    console.log('🔧 IoT Simulation Mode Enabled\n');
    
    const simulator = new IoTMeterSimulator(
      CONFIG.mqttBroker,
      'CHARGER_001'
    );

    // Example: Simulate a charging session
    // Replace with real session ID from contract
    setTimeout(() => {
      const mockSessionId = 1;
      simulator.startCharging(mockSessionId);
      
      // Stop after 2 minutes
      setTimeout(() => {
        simulator.stopCharging();
      }, 120000);
    }, 5000);
  }

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\n🛑 Shutting down oracle system...');
    if (oracle.mqttClient) {
      oracle.mqttClient.end();
    }
    process.exit(0);
  });
}

// Export for use as module
module.exports = {
  ChargerOracle,
  IoTMeterSimulator,
  OracleAPI
};

// Run if executed directly
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}