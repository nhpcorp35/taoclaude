// Last verification step: do these fields return real, sane values for
// a known subnet (64, Chutes — already confirmed real in taoclaude)?
import { ApiPromise, WsProvider } from '@polkadot/api';

const BITTENSOR_ENDPOINT = process.env.BITTENSOR_WS_URL || 'wss://entrypoint-finney.opentensor.ai:443';
const NETUID = 64;

async function main() {
  const provider = new WsProvider(BITTENSOR_ENDPOINT);
  const api = await ApiPromise.create({ provider, noInitWarn: true });
  console.log(`Connected. Checking netuid ${NETUID} (Chutes) ...\n`);

  const fields = [
    'subnetProtocolAlpha', 'subnetProtocolFlow', 'subnetEmaProtocolFlow',
    'subnetTaoInEmission', 'subnetAlphaInEmission', 'subnetAlphaOutEmission',
    'subnetOwnerCut', 'pendingServerEmission', 'pendingValidatorEmission',
    'pendingOwnerCut', 'taoWeight',
  ];
  for (const field of fields) {
    try {
      const val = await api.query.subtensorModule[field](NETUID);
      console.log(`${field}(${NETUID}) = ${val.toString()} (${val.toHuman ? JSON.stringify(val.toHuman()) : ''})`);
    } catch (e) {
      console.log(`${field}(${NETUID}) FAILED: ${e.message}`);
    }
  }

  console.log('\n--- swapRuntimeApi.mechanismEmissionSplit ---');
  try {
    const split = await api.call.swapRuntimeApi.mechanismEmissionSplit(NETUID);
    console.log('Result:', JSON.stringify(split.toHuman ? split.toHuman() : split.toString()));
  } catch (e) {
    console.log('FAILED:', e.message);
  }

  console.log('\n--- swapRuntimeApi.currentAlphaPrice (cross-check vs known reserves) ---');
  try {
    const price = await api.call.swapRuntimeApi.currentAlphaPrice(NETUID);
    console.log('Result:', price.toString(), price.toHuman ? JSON.stringify(price.toHuman()) : '');
  } catch (e) {
    console.log('FAILED:', e.message);
  }

  await api.disconnect();
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
