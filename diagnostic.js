// Verifying the ported logic against the real coldkey before building
// the real app on top of it — same numbers should come back as the
// v3.lptracker screenshots (35.0572 TAO total, $225.48 TAO price,
// 4 subnet positions, Root netuid 0 = 25.9002 TAO, netuid 64 Chutes
// = 3.1383 TAO / 45.4076 alpha).
import { ApiPromise, WsProvider } from '@polkadot/api';

const BITTENSOR_ENDPOINT = process.env.BITTENSOR_WS_URL || 'wss://entrypoint-finney.opentensor.ai:443';
const coldkey = process.env.DEFAULT_COLDKEY;

const taoAmount = (value) => Number(value || 0) / 1e9;
const bytesText = (value) => {
  if (!value) return '';
  const hex = typeof value === 'string' ? value : value.toString();
  return hex.startsWith('0x') ? Buffer.from(hex.slice(2), 'hex').toString('utf8') : String(value);
};

async function loadTaoUsdPrice() {
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bittensor&vs_currencies=usd', { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    return Number((await response.json())?.bittensor?.usd) || null;
  } catch { return null; }
}

async function main() {
  console.log(`Connecting to ${BITTENSOR_ENDPOINT} ...`);
  const provider = new WsProvider(BITTENSOR_ENDPOINT);
  const api = await ApiPromise.create({ provider, noInitWarn: true });
  console.log('Connected.');

  const [account, stakeInfo, price] = await Promise.all([
    api.query.system.account(coldkey),
    api.call.stakeInfoRuntimeApi.getStakeInfoForColdkey(coldkey),
    loadTaoUsdPrice(),
  ]);

  const liquidBalance = taoAmount(account.data.free.toString());
  console.log(`\nLiquid balance: ${liquidBalance} TAO`);
  console.log(`TAO price: $${price}`);

  const rawRows = stakeInfo.toJSON() || [];
  console.log(`\nRaw stake rows: ${rawRows.length}`);
  const netuids = [...new Set(rawRows.map(row => Number(row.netuid)))];
  console.log(`Unique netuids: ${netuids}`);

  const subnetData = await Promise.all(netuids.map(async (netuid) => {
    const [identity, taoReserve, alphaReserve, symbol] = await Promise.all([
      api.query.subtensorModule.subnetIdentitiesV3(netuid),
      api.query.subtensorModule.subnetTAO(netuid),
      api.query.subtensorModule.subnetAlphaIn(netuid),
      api.query.subtensorModule.tokenSymbol(netuid),
    ]);
    const humanIdentity = identity.toHuman();
    return {
      netuid,
      name: humanIdentity?.subnetName || (netuid === 0 ? 'Root network' : `Subnet ${netuid}`),
      symbol: bytesText(symbol.toJSON()) || (netuid === 0 ? 'TAO' : 'α'),
      taoReserve: taoAmount(taoReserve.toString()),
      alphaReserve: taoAmount(alphaReserve.toString()),
    };
  }));
  const subnetById = new Map(subnetData.map(row => [row.netuid, row]));

  const validatorAllocations = rawRows.map(row => {
    const subnet = subnetById.get(Number(row.netuid));
    const alpha = taoAmount(row.stake);
    const estimatedTao = Number(row.netuid) === 0 ? alpha : alpha * ((subnet?.taoReserve || 0) / Math.max(subnet?.alphaReserve || 0, 1e-12));
    return {
      netuid: Number(row.netuid), subnet: subnet?.name, symbol: subnet?.symbol,
      hotkey: row.hotkey, alpha, estimatedTao, registered: Boolean(row.isRegistered),
    };
  });

  const grouped = new Map();
  for (const row of validatorAllocations) {
    const current = grouped.get(row.netuid) || { netuid: row.netuid, subnet: row.subnet, alpha: 0, estimatedTao: 0, validatorCount: 0 };
    current.alpha += row.alpha;
    current.estimatedTao += row.estimatedTao;
    current.validatorCount += 1;
    grouped.set(row.netuid, current);
  }

  console.log('\n--- Subnet positions ---');
  let total = 0;
  for (const row of grouped.values()) {
    console.log(`  netuid ${row.netuid} (${row.subnet}): alpha=${row.alpha.toFixed(4)}, estimatedTao=${row.estimatedTao.toFixed(4)}, validators=${row.validatorCount}`);
    total += row.estimatedTao;
  }
  console.log(`\nTotal estimated staked TAO: ${total.toFixed(4)} (expect ~35.0572)`);
  console.log(`Total estimated USD: $${(total * price).toFixed(2)} (expect ~$7,904.71)`);

  await api.disconnect();
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
