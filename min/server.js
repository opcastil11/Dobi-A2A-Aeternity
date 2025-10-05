// ============================================
// INTEGRACIÓN COMPLETA: HARDWARE IoT → ORÁCULO → SMART CONTRACT
// ============================================

require('dotenv').config();

const { AeSdk, Node, MemoryAccount, CompilerHttp } = require('@aeternity/aepp-sdk');
const mqtt = require('mqtt'); // Para recibir datos del medidor IoT
const axios = require('axios');

// ============================================
// 1. CONFIGURACIÓN
// ============================================

// Procesar variables de entorno y agregar prefijos necesarios
const oracleSecretKey = process.env.ORACLE_SECRET_KEY || process.env.SECRET_KEY;
const contractAddress = process.env.CONTRACT_ADDRESS;

// Agregar prefijo sk_ si no lo tiene
const formattedSecretKey = oracleSecretKey && !oracleSecretKey.startsWith('sk_') 
  ? `sk_${oracleSecretKey}` 
  : oracleSecretKey;

// Validar formato (incluyendo 0 en la expresión regular)
if (!formattedSecretKey || !/^sk_[0-9A-HJ-NP-Za-km-z]+$/.test(formattedSecretKey)) {
  throw new Error('ORACLE_SECRET_KEY no tiene formato válido');
}
if (!contractAddress || !/^ct_[0-9A-HJ-NP-Za-km-z]+$/.test(contractAddress)) {
  throw new Error('CONTRACT_ADDRESS no tiene formato válido');
}

const CONFIG = {
  // æternity Network
  nodeUrl: process.env.NODE_URL || 'https://testnet.aeternity.io',
  compilerUrl: process.env.COMPILER_URL || 'https://compiler.aepps.com',
  
  // Smart Contract
  contractAddress: contractAddress,
  
  // Cuenta del oráculo
  oracleSecretKey: formattedSecretKey,
  
  // MQTT (Medidor IoT)
  mqttBroker: process.env.MQTT_BROKER || 'mqtt://test.mosquitto.org:1883',
  mqttTopic: process.env.MQTT_TOPIC || 'charger/+/consumption',
  
  // Configuración de pagos
  updateInterval: parseInt(process.env.UPDATE_INTERVAL) * 1000 || 10000, // Convertir segundos a ms
  minKwhIncrement: parseFloat(process.env.MIN_KWH_INCREMENT) || 0.1,
  
  // API Server
  apiPort: parseInt(process.env.API_PORT) || 3000,
  
  // Testing
  simulateIot: process.env.SIMULATE_IOT === 'true'
};

// ============================================
// 2. CLASE PRINCIPAL DEL ORÁCULO
// ============================================

class EVChargingOracle {
  constructor() {
    this.aeSdk = null;
    this.contract = null;
    this.mqttClient = null;
    this.activeSessions = new Map(); // sessionId -> sessionData
    this.lastReadings = new Map();   // sessionId -> lastKwhReading
  }

  // Inicializar conexión a æternity
  async initialize() {
    console.log('🚀 Inicializando Oracle...');
    
    const node = new Node(CONFIG.nodeUrl);
    const account = new MemoryAccount(CONFIG.oracleSecretKey);
    
    this.aeSdk = new AeSdk({
      nodes: [{ name: 'testnet', instance: node }],
      accounts: [account],
      onCompiler: new CompilerHttp(CONFIG.compilerUrl)
    });

    // Conectar al smart contract
    const contractSource = await this.loadContractSource();
    this.contract = await this.aeSdk.initializeContract({
      sourceCode: contractSource,
      address: CONFIG.contractAddress
    });

    console.log('✅ Conectado a æternity');
    console.log('📍 Contract:', CONFIG.contractAddress);
    console.log('🔑 Oracle Address:', account.address);

    // Registrar como oráculo en la red
    await this.registerAsOracle();
  }

  // Registrar oráculo en æternity
  async registerAsOracle() {
    try {
      const oracleId = await this.aeSdk.registerOracle(
        'string',  // Query format: "station_id,kwh_reading"
        'int',     // Response format: kWh como entero (x100 para decimales)
        {
          queryFee: 0,
          oracleTtl: { type: 'delta', value: 500 }
        }
      );
      
      console.log('✅ Oráculo registrado:', oracleId);
      return oracleId;
    } catch (error) {
      console.log('ℹ️ Oráculo ya registrado o error:', error.message);
    }
  }

  // Conectar a MQTT (recibir datos del medidor IoT)
  async connectToIoT() {
    console.log('🔌 Conectando a medidor IoT via MQTT...');
    
    this.mqttClient = mqtt.connect(CONFIG.mqttBroker);

    this.mqttClient.on('connect', () => {
      console.log('✅ Conectado a MQTT Broker');
      this.mqttClient.subscribe(CONFIG.mqttTopic, (err) => {
        if (err) {
          console.error('❌ Error subscribing:', err);
        } else {
          console.log('📡 Escuchando lecturas del medidor...');
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

  // Procesar lectura del medidor IoT
  async handleIoTReading(topic, message) {
    try {
      const reading = JSON.parse(message.toString());
      
      // Formato esperado del mensaje IoT:
      // {
      //   "station_id": "station_001",
      //   "session_id": 12345,
      //   "kwh_reading": 5.75,
      //   "timestamp": 1234567890,
      //   "voltage": 220,
      //   "current": 32
      // }

      console.log('📊 Lectura recibida:', reading);

      const { session_id, station_id, kwh_reading } = reading;

      // Verificar si esta sesión está activa
      if (!this.activeSessions.has(session_id)) {
        // Consultar smart contract si la sesión existe
        const sessionData = await this.contract.get_session(session_id);
        if (sessionData && sessionData.status === 'Active') {
          this.activeSessions.set(session_id, sessionData);
        } else {
          console.log('⚠️ Sesión no activa:', session_id);
          return;
        }
      }

      // Verificar incremento mínimo
      const lastReading = this.lastReadings.get(session_id) || 0;
      const increment = kwh_reading - lastReading;

      if (increment >= CONFIG.minKwhIncrement) {
        // Procesar pago en blockchain
        await this.processPayment(session_id, kwh_reading, reading);
        this.lastReadings.set(session_id, kwh_reading);
      }

    } catch (error) {
      console.error('❌ Error procesando lectura IoT:', error);
    }
  }

  // Procesar pago en el smart contract
  async processPayment(sessionId, kwhReading, rawData) {
    try {
      console.log(`💰 Procesando pago para sesión ${sessionId}...`);
      
      // Convertir kWh a entero (multiplicar por 100 para mantener decimales)
      const kwhInt = Math.round(kwhReading * 100);

      // Llamar al smart contract
      const result = await this.contract.update_charging_reading(
        sessionId,
        kwhInt,
        {
          gasLimit: 50000
        }
      );

      console.log('✅ Pago procesado:', result);
      console.log(`   kWh: ${kwhReading}`);
      console.log(`   Tx Hash: ${result.hash}`);

      // Emitir evento (opcional, para logging/monitoring)
      this.emitPaymentEvent({
        sessionId,
        kwhReading,
        txHash: result.hash,
        timestamp: Date.now(),
        rawIoTData: rawData
      });

    } catch (error) {
      console.error('❌ Error procesando pago:', error);
      
      // Si el balance es insuficiente, detener sesión
      if (error.message.includes('INSUFFICIENT_BALANCE')) {
        console.log('⚠️ Balance insuficiente, deteniendo sesión...');
        await this.stopSession(sessionId);
      }
    }
  }

  // Detener sesión
  async stopSession(sessionId) {
    try {
      const lastReading = this.lastReadings.get(sessionId) || 0;
      const finalKwh = Math.round(lastReading * 100);

      await this.contract.stop_charging(sessionId, finalKwh);
      
      this.activeSessions.delete(sessionId);
      this.lastReadings.delete(sessionId);
      
      console.log(`🛑 Sesión ${sessionId} detenida`);
    } catch (error) {
      console.error('❌ Error deteniendo sesión:', error);
    }
  }

  // Iniciar nueva sesión (llamado desde app/Dobi)
  async startSession(stationId, vehicleAgent, estimatedKwh, metadata) {
    try {
      // Registrar oráculo para esta sesión
      const oracleId = await this.aeSdk.getOracleObject(
        this.aeSdk.selectedAddress
      );

      // Iniciar sesión en smart contract
      const sessionId = await this.contract.start_charging(
        stationId,
        vehicleAgent,
        oracleId.id,
        Math.round(estimatedKwh * 100),
        metadata
      );

      console.log(`✅ Sesión iniciada: ${sessionId}`);
      
      this.activeSessions.set(sessionId, {
        stationId,
        vehicleAgent,
        startTime: Date.now()
      });

      this.lastReadings.set(sessionId, 0);

      return sessionId;

    } catch (error) {
      console.error('❌ Error iniciando sesión:', error);
      throw error;
    }
  }

  // Emitir evento de pago (para webhook/logging)
  emitPaymentEvent(data) {
    // Enviar a sistema de logging/monitoring
    // Puede ser webhook, database, etc.
    console.log('📤 Emitiendo evento de pago:', data);
    
    // Ejemplo: POST a webhook
    // axios.post('https://your-api.com/webhook/payment', data);
  }

  // Monitorear sesiones activas
  async monitorActiveSessions() {
    setInterval(async () => {
      for (const [sessionId, sessionData] of this.activeSessions) {
        try {
          // Verificar estado en blockchain
          const currentSession = await this.contract.get_session(sessionId);
          
          if (!currentSession || currentSession.status !== 'Active') {
            console.log(`ℹ️ Sesión ${sessionId} ya no está activa`);
            this.activeSessions.delete(sessionId);
            this.lastReadings.delete(sessionId);
          }
        } catch (error) {
          console.error(`❌ Error monitoreando sesión ${sessionId}:`, error);
        }
      }
    }, 30000); // Cada 30 segundos
  }

  // Cargar código fuente del contrato
  async loadContractSource() {
    // En producción, cargar desde archivo
    // return fs.readFileSync('./EVChargingPayment.aes', 'utf-8');
    
    // Para testing, retornar el código directamente
    return `/* Smart contract code here */`;
  }

  // Iniciar sistema completo
  async start() {
    try {
      await this.initialize();
      await this.connectToIoT();
      this.monitorActiveSessions();
      
      console.log('\n✅ Sistema de pagos EV completamente operativo');
      console.log('📡 Esperando lecturas del medidor IoT...\n');
    } catch (error) {
      console.error('❌ Error iniciando sistema:', error);
      process.exit(1);
    }
  }
}

// ============================================
// 3. SIMULADOR DE HARDWARE IoT (Para testing)
// ============================================

class IoTMeterSimulator {
  constructor(mqttBroker, stationId) {
    this.mqttClient = mqtt.connect(mqttBroker);
    this.stationId = stationId;
    this.sessionId = null;
    this.currentKwh = 0;
  }

  startCharging(sessionId) {
    this.sessionId = sessionId;
    this.currentKwh = 0;

    console.log(`🔌 [IoT Simulator] Iniciando carga en ${this.stationId}`);

    // Simular incremento de kWh cada 5 segundos
    this.interval = setInterval(() => {
      // Incremento random entre 0.5 y 2 kWh
      const increment = Math.random() * 1.5 + 0.5;
      this.currentKwh += increment;

      const reading = {
        station_id: this.stationId,
        session_id: this.sessionId,
        kwh_reading: Number(this.currentKwh.toFixed(2)),
        timestamp: Math.floor(Date.now() / 1000),
        voltage: 220,
        current: 32,
        power_factor: 0.95
      };

      // Publicar lectura via MQTT
      this.mqttClient.publish(
        `ev_charger/${this.stationId}/kwh_reading`,
        JSON.stringify(reading)
      );

      console.log(`📊 [IoT Simulator] Lectura: ${reading.kwh_reading} kWh`);

    }, 5000);
  }

  stopCharging() {
    if (this.interval) {
      clearInterval(this.interval);
      console.log(`🛑 [IoT Simulator] Carga detenida en ${this.stationId}`);
    }
  }
}

// ============================================
// 4. API REST (Para integración con frontend/Dobi)
// ============================================

const express = require('express');
const app = express();
app.use(express.json());

let oracleInstance = null;

// Iniciar sesión de carga
app.post('/api/charging/start', async (req, res) => {
  try {
    const { station_id, vehicle_agent, estimated_kwh, metadata } = req.body;
    
    const sessionId = await oracleInstance.startSession(
      station_id,
      vehicle_agent,
      estimated_kwh,
      JSON.stringify(metadata)
    );

    res.json({
      success: true,
      session_id: sessionId,
      message: 'Charging session started'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Detener sesión
app.post('/api/charging/stop', async (req, res) => {
  try {
    const { session_id } = req.body;
    
    await oracleInstance.stopSession(session_id);

    res.json({
      success: true,
      message: 'Charging session stopped'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Obtener estado de sesión
app.get('/api/charging/session/:id', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    
    const session = await oracleInstance.contract.get_session(sessionId);

    res.json({
      success: true,
      session: session
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// 5. MAIN - EJECUTAR SISTEMA
// ============================================

async function main() {
  console.log('⚡ Sistema de Pago para Cargadores EV');
  console.log('=====================================\n');

  // Inicializar oráculo
  oracleInstance = new EVChargingOracle();
  await oracleInstance.start();

  // Iniciar API REST
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🌐 API REST ejecutándose en puerto ${PORT}`);
  });

  // OPCIONAL: Iniciar simulador IoT para testing
  if (process.env.SIMULATE_IOT === 'true') {
    console.log('\n🔧 Modo simulación IoT activado\n');
    
    const simulator = new IoTMeterSimulator(
      CONFIG.mqttBroker,
      'station_001'
    );

    // Ejemplo: simular una sesión
    setTimeout(() => {
      simulator.startCharging(12345); // Session ID de ejemplo
      
      // Detener después de 1 minuto
      setTimeout(() => {
        simulator.stopCharging();
      }, 60000);
    }, 5000);
  }
}

// Ejecutar si es el archivo principal
if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  EVChargingOracle,
  IoTMeterSimulator
};

// ============================================
// 6. EJEMPLO DE USO CON DOBI (Agente IA)
// ============================================

/*
class DobiEVAgent {
  constructor(apiUrl) {
    this.apiUrl = apiUrl;
    this.activeSession = null;
  }

  async startCharging(stationId, estimatedKwh) {
    const response = await axios.post(`${this.apiUrl}/api/charging/start`, {
      station_id: stationId,
      vehicle_agent: this.address,
      estimated_kwh: estimatedKwh,
      metadata: {
        vehicle_model: 'Tesla Model 3',
        battery_capacity: 75,
        requested_by: 'Dobi AI Agent'
      }
    });

    this.activeSession = response.data.session_id;
    console.log(`🤖 Dobi: Carga iniciada, sesión ${this.activeSession}`);
    
    // Monitorear balance
    this.monitorBalance();
  }

  async monitorBalance() {
    const interval = setInterval(async () => {
      const balance = await this.getBalance();
      
      if (balance < 10) {
        console.log('⚠️ Dobi: Balance bajo, deteniendo carga...');
        await this.stopCharging();
        clearInterval(interval);
      }
    }, 10000);
  }

  async stopCharging() {
    await axios.post(`${this.apiUrl}/api/charging/stop`, {
      session_id: this.activeSession
    });
    
    console.log('🤖 Dobi: Carga detenida');
  }
}
*/