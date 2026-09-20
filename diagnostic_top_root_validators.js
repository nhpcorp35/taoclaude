import { ApiPromise, WsProvider } from '@polkadot/api';

const BITTENSOR_ENDPOINT = process.env.BITTENSOR_WS_URL || 'wss://entrypoint-finney.opentensor.ai:443';

async function main() {
  const provider = new WsProvider(BITTENSOR_ENDPOINT);
  const api = await ApiPromise.create({ provider, noInitWarn: true });
  console.log('Connected.\n');

  // Probe for a delegate-info style runtime API first
  console.log('=== api.call sections matching "delegate" ===');
  for (const section of Object.keys(api.call)) {
    if (section.toLowerCase().includes('delegate')) {
      console.log(`[${section}]`);
      for (const method of Object.keys(api.call[section])) console.log(`  .${method}`);
    }
  }

  console.log('\n=== Trying getDelegates() ===');
  try {
    const delegates = await api.call.delegateInfoRuntimeApi.getDelegates();
    const json = delegates.toJSON();
    console.log(`Got ${json.length} delegates.`);
    // Each delegate has nominators per netuid presumably — inspect one entry's shape
    console.log('Sample entry keys:', Object.keys(json[0] || {}));
    console.log(JSON.stringify(json[0], null, 2).slice(0, 1000));
  } catch (e) {
    console.log('FAILED:', e.message);
  }

  await api.disconnect();
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
