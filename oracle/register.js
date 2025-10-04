// register-oracle.js
const { AeSdk, Node, MemoryAccount, CompilerHttp, encode, Encoding } = require('@aeternity/aepp-sdk');
require('dotenv').config({ path: '../.env' });

async function registerOracle() {
  try {
    console.log('🚀 INICIANDO REGISTRO DE ORACLE...\n');

    const node = new Node(process.env.NODE_URL || 'https://testnet.aeternity.io');
    let secretKey = process.env.ORACLE_SECRET_KEY;

    if (!secretKey) throw new Error('ORACLE_SECRET_KEY no encontrado en .env');

    // Convertir clave hexadecimal a Base58 si es necesario
    if (!secretKey.startsWith('sk_')) {
      const secretKeyBuffer = Buffer.from(secretKey, 'hex');
      secretKey = encode(secretKeyBuffer, Encoding.AccountSecretKey);
      console.log('✅ Clave convertida a Base58:', secretKey.substring(0, 10) + '...');
    }

    const account = new MemoryAccount(secretKey);
    console.log('✅ Address de wallet:', account.address);

    // Verificar balance
    const balance = await node.getAccountByPubkey(account.address);
    console.log('💰 Balance:', balance.balance, 'aettos');

    const sdk = new AeSdk({
      nodes: [{ name: 'testnet', instance: node }],
      accounts: [account],
      onCompiler: new CompilerHttp(process.env.COMPILER_URL || 'https://compiler.aepps.com')
    });

    console.log('\n🔮 Registrando Oracle...');

    // En SDK 14.x, usar spend para crear transacciones Oracle
    const oracleTx = await sdk.spend(
      0,
      account.address,
      {
        denomination: 'aettos',
        payload: encode(Buffer.from(JSON.stringify({
          queryFormat: 'string',
          responseFormat: 'int',
          queryFee: 0,
          oracleTtl: { type: 'delta', value: 500 }
        })), Encoding.Bytearray),
        onAccount: account
      }
    );

    console.log('📝 Transaction hash:', oracleTx.hash);
    console.log('⏳ Esperando confirmación en blockchain...');
    
    // Esperar confirmación
    let confirmed = false;
    let attempts = 0;
    
    while (!confirmed && attempts < 30) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      try {
        const txInfo = await node.getTransactionByHash(oracleTx.hash);
        if (txInfo.blockHeight) {
          confirmed = true;
          console.log('\n✅ Oracle registrado con éxito!');
          console.log('⛓️  Block height:', txInfo.blockHeight);
        }
      } catch {
        process.stdout.write('.');
        attempts++;
      }
    }
    
    if (!confirmed) {
      console.log('\n⏰ Timeout esperando confirmación.');
      console.log('🔍 Verifica el estado en: https://testnet.aescan.io/transactions/' + oracleTx.hash);
    }
    
    // El Oracle ID es tu address con prefijo "ok_"
    const oracleId = account.address.replace('ak_', 'ok_');
    
    console.log('\n🆔 Oracle ID:', oracleId);
    console.log('📋 Agrega esta línea a tu archivo .env:');
    console.log('\nORACLE_ID=' + oracleId);
    console.log('\n📌 Transaction hash:', oracleTx.hash);
    console.log('🔗 Ver en explorer: https://testnet.aescan.io/transactions/' + oracleTx.hash);

  } catch (error) {
    console.error('❌ Error registrando Oracle:', error.message);
    if (error.stack) console.error('\n🔍 Stack trace:', error.stack);
    process.exit(1);
  }
}

registerOracle();