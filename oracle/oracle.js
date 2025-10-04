// server-simulated-mqtt.js
const { AeSdk, Node, MemoryAccount, encode, Encoding, Contract, CompilerHttp } = require('@aeternity/aepp-sdk');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: '../.env' });

const NODE_URL = process.env.NODE_URL || 'https://testnet.aeternity.io';
const COMPILER_URL = process.env.COMPILER_URL || 'https://compiler.aepps.com';
const SECRET_KEY = process.env.ORACLE_SECRET_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const ORACLE_ID = process.env.ORACLE_ID;

async function main() {
  try {
    console.log('🚀 Inicializando servidor MQTT simulado...\n');

    // Inicializar SDK
    const node = new Node(NODE_URL);
    let secretKey = SECRET_KEY;

    // Convertir a Base58 si es hexadecimal
    if (!secretKey.startsWith('sk_')) {
      const secretKeyBuffer = Buffer.from(secretKey, 'hex');
      secretKey = encode(secretKeyBuffer, Encoding.AccountSecretKey);
    }

    const account = new MemoryAccount(secretKey);

    const sdk = new AeSdk({
      nodes: [{ name: 'testnet', instance: node }],
      accounts: [account],
      onCompiler: new CompilerHttp(COMPILER_URL)
    });

    console.log('✅ Wallet lista:', account.address);
    console.log('🔮 Oracle ID:', ORACLE_ID);
    console.log('📄 Contract Address:', CONTRACT_ADDRESS);

    // Cargar source code del contrato
    const sourcePath = path.join(__dirname, '../SC/AIPaymentManager.aes');
    const contractSource = fs.readFileSync(sourcePath, 'utf8');
    console.log('✅ Source code cargado\n');

    // Inicializar contrato
    const contract = await Contract.initialize({
      ...sdk.getContext(),
      sourceCode: contractSource,
      address: CONTRACT_ADDRESS
    });

    console.log('📡 Servidor MQTT simulado activo...\n');

    // Función para responder queries del Oracle
    async function pollOracleQueries() {
      try {
        // Intentar obtener queries del Oracle
        const queries = await node.getOracleQueriesByPubkey(ORACLE_ID).catch(() => ({ oracleQueries: [] }));
        
        if (queries.oracleQueries && queries.oracleQueries.length > 0) {
          console.log(`📬 ${queries.oracleQueries.length} query(s) pendiente(s)`);
          
          for (const query of queries.oracleQueries) {
            const kwhReading = Math.floor(Math.random() * 5) + 1;
            
            try {
              const accountData = await node.getAccountByPubkey(account.address);
              const currentHeight = await node.getCurrentKeyBlockHeight();
              
              const respondTx = await sdk.buildTx({
                tag: 'OracleRespondTx',
                oracleId: ORACLE_ID,
                queryId: query.id,
                response: encode(Buffer.from(kwhReading.toString()), Encoding.OracleResponse),
                responseTtl: { type: 'delta', value: 100 },
                fee: 20000000000000,
                ttl: currentHeight + 100,
                nonce: accountData.nonce + 1
              });
              
              const signed = await sdk.signTransaction(respondTx);
              const result = await sdk.sendTransaction(signed);
              
              console.log(`✅ Query respondida: ${kwhReading} kWh (tx: ${result.hash})`);
            } catch (err) {
              console.error('❌ Error respondiendo query:', err.message);
            }
          }
        }
      } catch (error) {
        if (!error.message.includes('not found') && !error.message.includes('404')) {
          // console.error('⚠️  Error polling queries:', error.message);
        }
      }
    }

    // Función simulada que genera lecturas de kWh
    async function generateReading() {
      try {
        const chargerId = 'CHARGER_01';
        const kwhReading = Math.floor(Math.random() * 5) + 1; // 1-5 kWh
        const sessionId = Math.floor(Math.random() * 100) + 1;

        console.log(`\n📊 Lectura generada: ${chargerId} -> ${kwhReading} kWh (Sesión: ${sessionId})`);

        // Actualizar consumo en el contrato
        try {
          const result = await contract.update_consumption_reading(sessionId, kwhReading);
          console.log(`💰 Consumo actualizado en SC: ${result.hash}`);
          
          // Esperar confirmación
          console.log('⏳ Esperando confirmación...');
          let confirmed = false;
          let attempts = 0;
          
          while (!confirmed && attempts < 10) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            try {
              const txInfo = await node.getTransactionByHash(result.hash);
              if (txInfo.blockHeight) {
                confirmed = true;
                console.log(`✅ Confirmado en bloque ${txInfo.blockHeight}`);
              }
            } catch {
              process.stdout.write('.');
              attempts++;
            }
          }
          
          if (!confirmed) {
            console.log('\n⏰ Timeout, pero tx enviada: ' + result.hash);
          }
          
        } catch (err) {
          if (err.message.includes('SESSION_NOT_FOUND')) {
            console.log('⚠️  Sesión no encontrada - necesitas crear una sesión primero');
            console.log('💡 Tip: Ejecuta un script para crear sesión con start_consumption()');
          } else if (err.message.includes('SESSION_NOT_ACTIVE')) {
            console.log('⚠️  Sesión no activa');
          } else if (err.message.includes('NOT_AUTHORIZED')) {
            console.log('⚠️  No autorizado - solo el provider puede actualizar');
          } else {
            console.error('❌ Error actualizando SC:', err.message);
          }
        }

        // Poll por queries pendientes del Oracle
        await pollOracleQueries();

      } catch (error) {
        console.error('❌ Error en generateReading:', error.message);
      }
    }

    // Simular lectura cada 15 segundos
    console.log('⏰ Generando lecturas cada 15 segundos...\n');
    setInterval(generateReading, 15000);

    // Primera lectura inmediata
    await generateReading();

  } catch (err) {
    console.error('❌ Error inicializando servidor:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
}

main();