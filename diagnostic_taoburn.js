// Check the taoburn wallet's actual on-chain state — liquid balance
// and any open stake positions — before that Railway delete is
// confirmed.
import { ApiPromise, WsProvider } from '@polkadot/api';

const BITTENSOR_ENDPOINT = process.env.BITTENSOR_WS_URL || 'wss://entrypoint-finney.opentensor.ai:443';
const COLDKEY = '5GpcQWHJDb8gpSWCcRvKbcQ8bJpD8Z3F25JpbAyAn5gtEbcA';
const HOTKEY = '5ELCHWEYYcg79WRbskcMqN56bpUwzvHXVxBK55R8nvA3wvVT';

const taoAmount = (v) => Number(v || 0) / 1e9;

async function main() {
  console.log(`Connecting to ${BITTENSOR_ENDPOINT} ...`);
  const provider = new WsProvider(BITTENSOR_ENDPOINT);
  const api = await ApiPromise.create({ provider, noInitWarn: true });
  console.log('Connected.\n');

  const [account, stakeInfo] = await Promise.all([
    api.query.system.account(COLDKEY),
    api.call.stakeInfoRuntimeApi.getStakeInfoForColdkey(COLDKEY),
  ]);

  const liquidBalance = taoAmount(account.data.free.toString());
  console.log(`Liquid balance (coldkey): ${liquidBalance} TAO`);

  const rows = stakeInfo.toJSON() || [];
  console.log(`\nStake rows found: ${rows.length}`);
  if (rows.length === 0) {
    console.log('No open stake positions for this coldkey.');
  } else {
    for (const row of rows) {
      const alpha = taoAmount(row.stake);
      const isTaoburnHotkey = String(row.hotkey).toLowerCase() === HOTKEY.toLowerCase();
      console.log(`  netuid ${row.netuid}: alpha=${alpha}, hotkey=${row.hotkey}${isTaoburnHotkey ? ' <-- matches taoburn hotkey' : ' (different hotkey)'}, registered=${row.isRegistered}`);
    }
  }

  await api.disconnect();
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
