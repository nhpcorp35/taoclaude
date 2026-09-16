import { ApiPromise, WsProvider } from '@polkadot/api';

const BITTENSOR_ENDPOINT = process.env.BITTENSOR_WS_URL || 'wss://entrypoint-finney.opentensor.ai:443';
const NETUID = 78;
const ALPHA = 1.067917192;
const taoAmount = (v) => Number(v || 0) / 1e9;

async function main() {
  const provider = new WsProvider(BITTENSOR_ENDPOINT);
  const api = await ApiPromise.create({ provider, noInitWarn: true });

  const [taoReserve, alphaReserve, priceResp] = await Promise.all([
    api.query.subtensorModule.subnetTAO(NETUID),
    api.query.subtensorModule.subnetAlphaIn(NETUID),
    fetch('https://api.coingecko.com/api/v3/simple/price?ids=bittensor&vs_currencies=usd').then(r => r.json()),
  ]);

  const tao = taoAmount(taoReserve.toString());
  const alphaR = taoAmount(alphaReserve.toString());
  const estimatedTao = ALPHA * (tao / alphaR);
  const taoUsd = priceResp?.bittensor?.usd;

  console.log(`netuid ${NETUID} pool: taoReserve=${tao}, alphaReserve=${alphaR}`);
  console.log(`Position: ${ALPHA} alpha -> ~${estimatedTao.toFixed(6)} TAO -> ~$${(estimatedTao * taoUsd).toFixed(2)}`);

  await api.disconnect();
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
