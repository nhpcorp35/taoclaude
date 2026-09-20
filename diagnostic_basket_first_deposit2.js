import { ApiPromise, WsProvider } from '@polkadot/api';

const BITTENSOR_ENDPOINT = process.env.BITTENSOR_WS_URL || 'wss://entrypoint-finney.opentensor.ai:443';
const COLDKEY = process.env.DEFAULT_COLDKEY;
const HOTKEY = '5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5';

async function main() {
  const provider = new WsProvider(BITTENSOR_ENDPOINT);
  const api = await ApiPromise.create({ provider, noInitWarn: true });
  const currentBlock = (await api.rpc.chain.getHeader()).number.toNumber();
  console.log(`Current block: ${currentBlock}`);

  async function betaAt(blockNum) {
    const hash = await api.rpc.chain.getBlockHash(blockNum);
    try {
      const apiAt = await api.at(hash);
      const pos = await apiAt.call.betaBasketRuntimeApi.getBasketPosition(HOTKEY, COLDKEY);
      const json = pos.toJSON();
      return { ok: true, beta: json ? Number(json.beta || 0) : 0 };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Find the retention boundary — how far back is state actually queryable.
  const daysBack = [1, 3, 7, 14, 30];
  for (const d of daysBack) {
    const block = Math.max(1, currentBlock - Math.floor(d * 86400 / 12));
    const result = await betaAt(block);
    console.log(`${d}d back (block ${block}): ${result.ok ? `beta=${result.beta}` : `unavailable (${result.error})`}`);
  }

  await api.disconnect();
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
