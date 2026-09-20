import { ApiPromise, WsProvider } from '@polkadot/api';

const BITTENSOR_ENDPOINT = process.env.BITTENSOR_WS_URL || 'wss://entrypoint-finney.opentensor.ai:443';

async function main() {
  const provider = new WsProvider(BITTENSOR_ENDPOINT);
  const api = await ApiPromise.create({ provider, noInitWarn: true });

  const delegates = await api.call.delegateInfoRuntimeApi.getDelegates();
  const json = delegates.toJSON();
  console.log(`Total delegates: ${json.length}\n`);

  const ranked = [];
  for (const d of json) {
    let rootStakeRaw = 0n;
    for (const [nominatorAddr, netuidAmountPairs] of d.nominators) {
      for (const [netuid, amount] of netuidAmountPairs) {
        if (netuid === 0) rootStakeRaw += BigInt(amount);
      }
    }
    if (rootStakeRaw > 0n) {
      ranked.push({ hotkey: d.delegateSs58, owner: d.ownerSs58, takeBps: d.take, rootStakeTao: Number(rootStakeRaw) / 1e9 });
    }
  }

  ranked.sort((a, b) => b.rootStakeTao - a.rootStakeTao);
  console.log(`Delegates with nonzero root stake: ${ranked.length}\n`);
  console.log('=== Top 10 by root stake ===');
  for (let i = 0; i < Math.min(10, ranked.length); i++) {
    const r = ranked[i];
    const takePct = (r.takeBps / 65535 * 100).toFixed(2);
    console.log(`${i + 1}. ${r.hotkey} — ${r.rootStakeTao.toFixed(2)} TAO root stake, take ${takePct}%`);
  }

  await api.disconnect();
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
