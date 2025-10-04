// server-simulated-mqtt.js
const { AeSdk, Node, MemoryAccount, Oracle } = require('@aeternity/aepp-sdk');
require('dotenv').config({ path: '../.env' });

const NODE_URL = process.env.NODE_URL || 'https://testnet.aeternity.io';
const SECRET_KEY = process.env.ORACLE_SECRET_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS; // Dirección de tu SC
const ORACLE_ID = process.env.ORACLE_ID; // ID de Oracle registrado

async function main() {
  try {
    // Inicializar SDK
    const node = new Node(NODE_URL);
    let secretKey = SECRET_KEY;

    // Convertir a Base58 si es hexadecimal
    if (!secretKey.startsWith('sk_')) {
      const { encode, Encoding } = require('@aeternity/aepp-sdk');
      const secretKeyBuffer = Buffer.from(secretKey, 'hex');
      secretKey = encode(secretKeyBuffer, Encoding.AccountSecretKey);
    }

    const account = new MemoryAccount(secretKey);

    const sdk = new AeSdk({
      nodes: [{ name: 'testnet', instance: node }],
      accounts: [account],
    });

    console.log('✅ Wallet lista:', account.address);

    // Inicializar Oracle
    const oracle = new Oracle(sdk);

    console.log('🚀 Simulando servidor MQTT conectado a Oracle...');

    // Función simulada que genera lecturas de kWh
    function generateReading() {
      // Simular ID de cargador y lectura de kWh
      const chargerId = 'CHARGER_01';
      const kwhReading = Math.floor(Math.random() * 5) + 1; // 1-5 kWh
      const sessionId = Math.floor(Math.random() * 100) + 1; // Simulación de sesión

      console.log(`📡 Mensaje MQTT simulado: ${chargerId} -> ${kwhReading} kWh`);

      // Responder Oracle con la lectura
      sdk.sendOracleResponse(ORACLE_ID, `${chargerId}`, kwhReading)
        .then((res) => {
          console.log(`🔮 Oracle response enviada: ${res.hash || res.tx ? res.tx.hash : 'ok'}`);
        })
        .catch(console.error);

      // Actualizar contrato: llamar a update_consumption_reading
      sdk.contractCall(CONTRACT_ADDRESS, 'update_consumption_reading', [sessionId, kwhReading])
        .then(tx => console.log(`💰 Consumo actualizado en SC: ${tx.tx.hash}`))
        .catch(err => console.error('❌ Error actualizando SC:', err.message));
    }

    // Simular lectura cada 10 segundos
    setInterval(generateReading, 10000);

  } catch (err) {
    console.error('❌ Error inicializando servidor:', err.message);
    process.exit(1);
  }
}

main();
