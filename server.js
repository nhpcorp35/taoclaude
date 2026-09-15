/**
 * taoclaude — Bittensor coldkey + subnet stake tracker.
 *
 * Genuinely different stack from every other tracker tonight: Substrate,
 * not EVM or Solana. Ported directly from v3.lptracker's own verified
 * server.mjs (using @polkadot/api) rather than translating to a Python
 * Substrate library and risking new translation bugs — confirmed correct
 * against the real coldkey before building on it (see git history).
 *
 * Read-only: only ever queries public RPC state, never holds or touches
 * a signing key.
 */
import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { ApiPromise, WsProvider } from '@polkadot/api';

const app = express();
app.use(cors());

const PASSWORD = process.env.PASSWORD || '';
const DEFAULT_COLDKEY = process.env.DEFAULT_COLDKEY || '';
const BITTENSOR_ENDPOINT = process.env.BITTENSOR_WS_URL || 'wss://entrypoint-finney.opentensor.ai:443';
const TAO_ADDRESS_RE = /^5[1-9A-HJ-NP-Za-km-z]{46,50}$/;

app.use((req, res, next) => {
  if (!PASSWORD) return next();
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const pw = decoded.split(':')[1];
    if (pw === PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="tao tracker"');
  return res.status(401).send('Unauthorized');
});

const taoAmount = (value) => Number(value || 0) / 1e9;
const bytesText = (value) => {
  if (!value) return '';
  const hex = typeof value === 'string' ? value : value.toString();
  return hex.startsWith('0x') ? Buffer.from(hex.slice(2), 'hex').toString('utf8') : String(value);
};

let cachedApi = null;
async function getApi() {
  if (cachedApi && cachedApi.isConnected) return cachedApi;
  const provider = new WsProvider(BITTENSOR_ENDPOINT);
  cachedApi = await ApiPromise.create({ provider, noInitWarn: true });
  return cachedApi;
}

let priceCache = { at: 0, value: null };
async function loadTaoUsdPrice() {
  if (priceCache.value !== null && Date.now() - priceCache.at < 5 * 60 * 1000) return priceCache.value;
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bittensor&vs_currencies=usd', { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return priceCache.value;
    const price = Number((await response.json())?.bittensor?.usd) || null;
    if (price !== null) priceCache = { at: Date.now(), value: price };
    return price;
  } catch { return priceCache.value; }
}

const summaryCache = new Map();
const SUMMARY_CACHE_TTL = 60 * 1000;

async function taoSummary(coldkey) {
  const key = String(coldkey || '').trim();
  if (!TAO_ADDRESS_RE.test(key)) throw new Error('Invalid Bittensor coldkey');

  const cached = summaryCache.get(key);
  if (cached && Date.now() - cached.at < SUMMARY_CACHE_TTL) return cached.value;

  const api = await getApi();
  const [account, stakeInfo, price] = await Promise.all([
    api.query.system.account(key),
    api.call.stakeInfoRuntimeApi.getStakeInfoForColdkey(key),
    loadTaoUsdPrice(),
  ]);

  const liquidBalance = taoAmount(account.data.free.toString());
  const rawRows = stakeInfo.toJSON() || [];
  const netuids = [...new Set(rawRows.map(row => Number(row.netuid)))];

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
    // Netuid 0 is TAO directly. Dynamic subnet positions are alpha — this
    // is a spot-value estimate using the current TAO/alpha pool ratio,
    // not an unstake quote (slippage isn't modeled).
    const estimatedTao = Number(row.netuid) === 0 ? alpha : alpha * ((subnet?.taoReserve || 0) / Math.max(subnet?.alphaReserve || 0, 1e-12));
    return {
      netuid: Number(row.netuid),
      subnet: subnet?.name || `Subnet ${row.netuid}`,
      symbol: subnet?.symbol || 'α',
      hotkey: row.hotkey,
      alpha,
      estimatedTao,
      registered: Boolean(row.isRegistered),
      locked: taoAmount(row.locked),
    };
  });

  // A coldkey may allocate to several validators within one subnet — roll
  // those up into one position row while retaining the count.
  const grouped = new Map();
  for (const row of validatorAllocations) {
    const current = grouped.get(row.netuid) || {
      netuid: row.netuid, subnet: row.subnet, symbol: row.symbol,
      alpha: 0, estimatedTao: 0, locked: 0, validatorCount: 0, registeredValidators: 0, validators: [],
    };
    current.alpha += row.alpha;
    current.estimatedTao += row.estimatedTao;
    current.locked += row.locked;
    current.validatorCount += 1;
    current.registeredValidators += row.registered ? 1 : 0;
    current.validators.push({ hotkey: row.hotkey, alpha: row.alpha, estimatedTao: row.estimatedTao, registered: row.registered });
    grouped.set(row.netuid, current);
  }

  const positions = [...grouped.values()]
    .map(row => ({ ...row, estimatedUsd: price == null ? null : row.estimatedTao * price, registered: row.registeredValidators > 0 }))
    .sort((a, b) => b.estimatedTao - a.estimatedTao);

  const totalStakedTao = positions.reduce((sum, p) => sum + p.estimatedTao, 0);
  const totalStakedUsd = price == null ? null : totalStakedTao * price;

  const result = {
    coldkey: key,
    liquidBalance,
    liquidBalanceUsd: price == null ? null : liquidBalance * price,
    taoPrice: price,
    positions,
    portfolio: {
      total_value_usd: totalStakedUsd,
      liquid_balance_tao: liquidBalance,
      position_count: positions.length,
    },
    fetched_at: Date.now() / 1000,
  };
  summaryCache.set(key, { at: Date.now(), value: result });
  return result;
}

app.get('/', (req, res) => res.sendFile(new URL('./static/index.html', import.meta.url).pathname));

app.get('/api/positions', async (req, res) => {
  const coldkey = (req.query.coldkey || DEFAULT_COLDKEY || '').trim();
  if (!coldkey) return res.status(400).json({ error: 'No coldkey specified and no default coldkey configured' });
  try {
    const result = await taoSummary(coldkey);
    res.json(result);
  } catch (e) {
    console.error('taoSummary failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Listening on ${PORT}`));
