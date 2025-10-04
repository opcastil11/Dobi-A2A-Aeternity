// deploy.js (versión alternativa)
const { 
    AeSdk, 
    Node, 
    MemoryAccount, 
    CompilerHttp,
    encode,
    Encoding,
    Contract
  } = require('@aeternity/aepp-sdk');
  
  const fs = require('fs');
  require('dotenv').config({ path: '../.env' });
  
  async function deploy() {
    try {
      console.log('🚀 INIT...\n');
      
      const node = new Node('https://testnet.aeternity.io');
      let secretKey = process.env.SECRET_KEY;
      
      if (!secretKey) {
        throw new Error('SECRET_KEY no encontrado en las variables de entorno. Verifica tu archivo .env');
      }
      
      console.log('🔑 Procesando clave secreta...');
      
      // Si la clave es hexadecimal (no empieza con sk_), convertirla
      if (!secretKey.startsWith('sk_')) {
        console.log('⚙️  Convirtiendo clave hexadecimal a formato Aeternity...');
        const secretKeyBuffer = Buffer.from(secretKey, 'hex');
        secretKey = encode(secretKeyBuffer, Encoding.AccountSecretKey);
        console.log('✅ Clave convertida:', secretKey.substring(0, 10) + '...');
      }
      
      console.log('🔑 Creando cuenta...');
      const account = new MemoryAccount(secretKey);
      
      console.log('✅ Address:', account.address);
      
      const aeSdk = new AeSdk({
        nodes: [{ name: 'testnet', instance: node }],
        accounts: [account],
        onCompiler: new CompilerHttp('https://compiler.aepps.com')
      });
  
      console.log('\n📄 Leyendo contrato...');
      const sourceCode = fs.readFileSync('./AIPaymentManager.aes', 'utf-8');
      
      console.log('⚙️  Inicializando contrato...');
      const contract = await Contract.initialize({ 
        ...aeSdk.getContext(),
        sourceCode 
      });
      
      console.log('🚀 Desplegando...\n');
      const deployInfo = await contract.$deploy([]);
      
      console.log('═══════════════════════════════════════');
      console.log('✅ CONTRATO DESPLEGADO EXITOSAMENTE!');
      console.log('═══════════════════════════════════════');
      console.log('Address:', deployInfo.address || contract.$options.address);
      console.log('═══════════════════════════════════════\n');
      
      return contract;
      
    } catch (error) {
      console.error('❌ Error:', error.message);
      if (error.stack) console.error('\n', error.stack);
      process.exit(1);
    }
  }
  
  deploy();