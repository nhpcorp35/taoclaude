// Verification-only: introspect the live chain's actual metadata for
// the exact runtime API / storage surface around "chain buys" (protocol
// TAO/alpha) and the miner emission split, rather than guess names.
import { ApiPromise, WsProvider } from '@polkadot/api';

const BITTENSOR_ENDPOINT = process.env.BITTENSOR_WS_URL || 'wss://entrypoint-finney.opentensor.ai:443';
const TEST_NETUID = 64; // Chutes — known real subnet, already verified in taoclaude

async function main() {
  console.log(`Connecting to ${BITTENSOR_ENDPOINT} ...`);
  const provider = new WsProvider(BITTENSOR_ENDPOINT);
  const api = await ApiPromise.create({ provider, noInitWarn: true });
  console.log('Connected.\n');

  // 1. What runtime API sections/methods actually exist that look relevant?
  console.log('=== api.call sections matching relevant keywords ===');
  for (const section of Object.keys(api.call)) {
    const lower = section.toLowerCase();
    if (lower.includes('swap') || lower.includes('subnet') || lower.includes('stake') || lower.includes('emission')) {
      console.log(`\n[${section}]`);
      for (const method of Object.keys(api.call[section])) {
        console.log(`  .${method}`);
      }
    }
  }

  // 2. What storage items exist under subtensorModule matching keywords?
  console.log('\n=== api.query.subtensorModule keys matching keywords ===');
  const keywords = ['protocol', 'owner', 'emission', 'pending', 'cut', 'inject', 'buy', 'coinbase', 'weight', 'issuance'];
  for (const key of Object.keys(api.query.subtensorModule)) {
    const lower = key.toLowerCase();
    if (keywords.some(k => lower.includes(k))) {
      console.log(`  ${key}`);
    }
  }

  await api.disconnect();
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
