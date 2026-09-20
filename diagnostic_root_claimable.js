import { ApiPromise, WsProvider } from '@polkadot/api';

const BITTENSOR_ENDPOINT = process.env.BITTENSOR_WS_URL || 'wss://entrypoint-finney.opentensor.ai:443';
const COLDKEY = process.env.DEFAULT_COLDKEY;
const HOTKEY = '5G9hfkx9dRhCU4XenPKvpupdQEqShnMWaFmvfF9BskQihjwrc5';

async function tryCall(label, fn) {
  try {
    const result = await fn();
    console.log(`${label}: ${JSON.stringify(result.toHuman ? result.toHuman() : result.toString())}`);
  } catch (e) {
    console.log(`${label} FAILED: ${e.message}`);
  }
}

async function main() {
  const provider = new WsProvider(BITTENSOR_ENDPOINT);
  const api = await ApiPromise.create({ provider, noInitWarn: true });
  console.log(`Coldkey: ${COLDKEY}, Hotkey: ${HOTKEY}\n`);

  await tryCall('rootClaimable(coldkey)', () => api.query.subtensorModule.rootClaimable(COLDKEY));
  await tryCall('rootClaimable(hotkey)', () => api.query.subtensorModule.rootClaimable(HOTKEY));
  await tryCall('rootClaimable(coldkey, hotkey)', () => api.query.subtensorModule.rootClaimable(COLDKEY, HOTKEY));
  await tryCall('rootClaimed(coldkey)', () => api.query.subtensorModule.rootClaimed(COLDKEY));
  await tryCall('basketShares(coldkey, hotkey)', () => api.query.subtensorModule.basketShares(COLDKEY, HOTKEY));
  await tryCall('basketShares(hotkey, coldkey)', () => api.query.subtensorModule.basketShares(HOTKEY, COLDKEY));

  await tryCall('getRootBasketOwed(hotkey, coldkey)', () => api.call.betaBasketRuntimeApi.getRootBasketOwed(HOTKEY, COLDKEY));
  await tryCall('getRootBasketOwed(coldkey, hotkey)', () => api.call.betaBasketRuntimeApi.getRootBasketOwed(COLDKEY, HOTKEY));
  await tryCall('getValidatorBasketNav(hotkey)', () => api.call.betaBasketRuntimeApi.getValidatorBasketNav(HOTKEY));
  await tryCall('getRootBasketTotalNav()', () => api.call.betaBasketRuntimeApi.getRootBasketTotalNav());
  await tryCall('getBasketTradingStatus()', () => api.call.betaBasketRuntimeApi.getBasketTradingStatus());

  await api.disconnect();
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
