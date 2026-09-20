// Probe the live chain for the actual Root Reborn basket/claim storage
// and runtime-API surface — the docs describe CLI-level commands
// (btcli query validator-basket, etc.) but not the raw chain interface
// needed to query this directly.
import { ApiPromise, WsProvider } from '@polkadot/api';

const BITTENSOR_ENDPOINT = process.env.BITTENSOR_WS_URL || 'wss://entrypoint-finney.opentensor.ai:443';

async function main() {
  const provider = new WsProvider(BITTENSOR_ENDPOINT);
  const api = await ApiPromise.create({ provider, noInitWarn: true });
  console.log('Connected.\n');

  console.log('=== api.query.subtensorModule keys matching basket/claim/nav ===');
  const keywords = ['basket', 'claim', 'nav', 'rootclaim', 'entitlement', 'fund'];
  for (const key of Object.keys(api.query.subtensorModule)) {
    const lower = key.toLowerCase();
    if (keywords.some(k => lower.includes(k))) {
      console.log(`  ${key}`);
    }
  }

  console.log('\n=== api.call sections/methods matching basket/claim/root ===');
  for (const section of Object.keys(api.call)) {
    const lower = section.toLowerCase();
    for (const method of Object.keys(api.call[section])) {
      const mLower = method.toLowerCase();
      if (keywords.some(k => lower.includes(k) || mLower.includes(k))) {
        console.log(`  ${section}.${method}`);
      }
    }
  }

  await api.disconnect();
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
