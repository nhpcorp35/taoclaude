// Binary search historical chain state to find the exact block where
// this coldkey's basket position first became nonzero, for a precise
// APR calc instead of assuming the network-wide Root Reborn launch
// date (which may be later than when this specific validator's
// basket actually started depositing).
import { ApiPromise, WsProvider } from '@polkadot/api';

const BITTENSOR_ENDPOINT = process.env.BITTENSOR_WS_URL || 'wss://entrypoint-finney.opentensor.ai:443';
const COLDKEY = process.env.DEFAULT_COLDKEY;
const HOTKEY = '5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5';

async function main() {
  const provider = new WsProvider(BITTENSOR_ENDPOINT);
  const api = await ApiPromise.create({ provider, noInitWarn: true });

  const currentHeader = await api.rpc.chain.getHeader();
  const currentBlock = currentHeader.number.toNumber();
  console.log(`Current block: ${currentBlock}`);

  async function betaAt(blockNum) {
    const hash = await api.rpc.chain.getBlockHash(blockNum);
    const apiAt = await api.at(hash);
    try {
      const pos = await apiAt.call.betaBasketRuntimeApi.getBasketPosition(HOTKEY, COLDKEY);
      const json = pos.toJSON();
      return json ? Number(json.beta || 0) : 0;
    } catch (e) {
      return null; // call not available at this historical block (pre-upgrade)
    }
  }

  // Confirm nonzero now, and find a lower bound where it's zero/null.
  const nowBeta = await betaAt(currentBlock);
  console.log(`beta at current block: ${nowBeta}`);

  // Root Reborn launched ~Aug 4 2026; ~12s/block, so estimate a
  // starting lower bound comfortably before that as our zero point.
  let lo = Math.max(1, currentBlock - Math.floor(60 * 86400 / 12)); // ~60 days back
  let hi = currentBlock;
  const loBeta = await betaAt(lo);
  console.log(`beta at lo bound (block ${lo}, ~60d ago): ${loBeta}`);

  if (loBeta !== 0 && loBeta !== null) {
    console.log('Lower bound already nonzero — need to search further back. Stopping here for review.');
    await api.disconnect();
    return;
  }

  // Binary search for the first block where beta > 0.
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const midBeta = await betaAt(mid);
    if (midBeta === null || midBeta === 0) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const firstBlock = hi;
  const hash = await api.rpc.chain.getBlockHash(firstBlock);
  const apiAt = await api.at(hash);
  const timestamp = await apiAt.query.timestamp.now();
  const firstDepositTs = Number(timestamp.toString()) / 1000;

  console.log(`\nFirst nonzero-beta block: ${firstBlock}`);
  console.log(`Timestamp: ${new Date(firstDepositTs * 1000).toISOString()}`);
  console.log(`Days elapsed since then: ${((Date.now() / 1000 - firstDepositTs) / 86400).toFixed(2)}`);

  await api.disconnect();
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
