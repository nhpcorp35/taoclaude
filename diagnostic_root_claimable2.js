import { ApiPromise, WsProvider } from '@polkadot/api';

const BITTENSOR_ENDPOINT = process.env.BITTENSOR_WS_URL || 'wss://entrypoint-finney.opentensor.ai:443';
const COLDKEY = process.env.DEFAULT_COLDKEY;

async function tryCall(label, fn) {
  try {
    const result = await fn();
    console.log(`${label}: ${JSON.stringify(result.toHuman ? result.toHuman() : result.toString())}`);
    return result;
  } catch (e) {
    console.log(`${label} FAILED: ${e.message}`);
    return null;
  }
}

async function main() {
  const provider = new WsProvider(BITTENSOR_ENDPOINT);
  const api = await ApiPromise.create({ provider, noInitWarn: true });

  // Get the REAL, exact hotkey address — don't reconstruct from a
  // truncated display string (that was a real mistake in the last run,
  // caught by the address checksum failing).
  const stakeInfo = await api.call.stakeInfoRuntimeApi.getStakeInfoForColdkey(COLDKEY);
  const rows = stakeInfo.toJSON() || [];
  const rootRow = rows.find(r => r.netuid === 0);
  if (!rootRow) {
    console.log('No root network stake row found for this coldkey.');
    await api.disconnect();
    return;
  }
  const HOTKEY = rootRow.hotkey;
  console.log(`Coldkey: ${COLDKEY}\nReal root hotkey: ${HOTKEY}\n`);

  const claimable = await tryCall('rootClaimable(coldkey)', () => api.query.subtensorModule.rootClaimable(COLDKEY));
  await tryCall('rootClaimable(hotkey)', () => api.query.subtensorModule.rootClaimable(HOTKEY));
  await tryCall('basketShares(coldkey)', () => api.query.subtensorModule.basketShares(COLDKEY));
  await tryCall('basketShares(hotkey)', () => api.query.subtensorModule.basketShares(HOTKEY));
  await tryCall('getRootBasketOwed(hotkey)', () => api.call.betaBasketRuntimeApi.getRootBasketOwed(HOTKEY));
  await tryCall('getRootBasketOwed(coldkey)', () => api.call.betaBasketRuntimeApi.getRootBasketOwed(COLDKEY));
  await tryCall('getValidatorBasketNav(hotkey)', () => api.call.betaBasketRuntimeApi.getValidatorBasketNav(HOTKEY));
  await tryCall('getValidatorBasket(hotkey)', () => api.call.betaBasketRuntimeApi.getValidatorBasket(HOTKEY));
  await tryCall('getBasketTradingStatus(hotkey)', () => api.call.betaBasketRuntimeApi.getBasketTradingStatus(HOTKEY));

  if (claimable !== null) {
    console.log('\nraw claimable type:', claimable.toRawType ? claimable.toRawType() : typeof claimable);
  }

  await api.disconnect();
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
