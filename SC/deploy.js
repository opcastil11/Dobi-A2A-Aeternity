// deploy.js
const { AeSdk, Node, MemoryAccount, CompilerHttp } = require('@aeternity/aepp-sdk');

async function deploy() {
  const node = new Node('https://testnet.aeternity.io');
  const account = new MemoryAccount('TU_SECRET_KEY');
  
  const aeSdk = new AeSdk({
    nodes: [{ name: 'testnet', instance: node }],
    accounts: [account],
    onCompiler: new CompilerHttp('https://compiler.aepps.com')
  });

  const sourceCode = fs.readFileSync('./AIPaymentManager.aes', 'utf-8');
  const contract = await aeSdk.initializeContract({ sourceCode });
  
  await contract.$deploy([]);
  
  console.log('✅ Contrato deployado:', contract.$options.address);
  return contract;
}

deploy();