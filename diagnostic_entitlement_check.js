// My earlier getRootBasketOwed() gave ~$0.04, this other page shows
// ~$35.85 claimable. Re-check more carefully — my single-key probe
// may have missed a per-staker (coldkey+hotkey) entitlement storage
// item, since basketShares(hotkey) alone is likely the VALIDATOR'S
// total, not this specific coldkey's own share of it.
import { ApiPromise, WsProvider } from '@polkadot/api';

const BITTENSOR_ENDPOINT = process.env.BITTENSOR_WS_URL || 'wss://entrypoint-finney.opentensor.ai:443';
const COLDKEY = process.env.DEFAULT_COLDKEY;
const HOTKEY = '5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5';

async function main() {
  const provider = new WsProvider(BITTENSOR_ENDPOINT);
  const api = await ApiPromise.create({ provider, noInitWarn: true });

  console.log('=== Double-map basket-related storage items ===');
  const meta = api.runtimeMetadata.asLatest;
  const pallets = meta.pallets;
  const subtensorPallet = pallets.find(p => p.name.toString() === 'SubtensorModule');
  if (subtensorPallet && subtensorPallet.storage.isSome) {
    const items = subtensorPallet.storage.unwrap().items;
    for (const item of items) {
      const name = item.name.toString();
      if (name.toLowerCase().includes('basket') || name.toLowerCase().includes('share')) {
        console.log(`  ${name}: ${item.type.toString()}`);
      }
    }
  }

  console.log('\n=== Trying compound-key queries ===');
  async function tryCall(label, fn) {
    try {
      const r = await fn();
      console.log(`${label}: ${JSON.stringify(r.toHuman ? r.toHuman() : r.toString())}`);
    } catch (e) { console.log(`${label} FAILED: ${e.message}`); }
  }
  await tryCall('stakerBasketShares(coldkey, hotkey)', () => api.query.subtensorModule.stakerBasketShares?.(COLDKEY, HOTKEY));
  await tryCall('basketShareOf(coldkey, hotkey)', () => api.query.subtensorModule.basketShareOf?.(COLDKEY, HOTKEY));
  await tryCall('getBasketPosition(hotkey, coldkey)', () => api.call.betaBasketRuntimeApi.getBasketPosition(HOTKEY, COLDKEY));
  await tryCall('getBetaPosition(hotkey, coldkey)', () => api.call.betaBasketRuntimeApi.getBetaPosition?.(HOTKEY, COLDKEY));

  await api.disconnect();
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
