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
import fs from 'fs';
import path from 'path';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { createAlphaChaser } from './alphachaser.js';

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
async function getApi(forceFresh = false) {
  if (!forceFresh && cachedApi && cachedApi.isConnected) return cachedApi;
  if (cachedApi) {
    // Don't leak the old connection — a stale one after a runtime
    // upgrade is exactly what caused this bug in the first place.
    try { await cachedApi.disconnect(); } catch { /* already gone */ }
    cachedApi = null;
  }
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

  let result;
  try {
    result = await taoSummaryInner(key, await getApi());
  } catch (e) {
    // A stale connection after a chain runtime upgrade is the known
    // failure mode here (confirmed directly: every call broke right
    // after a live spec-version bump, despite the socket staying
    // "connected") — force a fresh connection and retry once before
    // giving up for real.
    console.warn(`taoSummary first attempt failed (${e.message}), retrying with a fresh connection...`);
    result = await taoSummaryInner(key, await getApi(true));
  }
  summaryCache.set(key, { at: Date.now(), value: result });
  return result;
}

async function taoSummaryInner(key, api) {
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

  const validatorAllocations = await Promise.all(rawRows.map(async (row) => {
    const subnet = subnetById.get(Number(row.netuid));
    const alpha = taoAmount(row.stake);
    // Netuid 0 is TAO directly. Dynamic subnet positions are alpha — this
    // is a spot-value estimate using the current TAO/alpha pool ratio,
    // not an unstake quote (slippage isn't modeled).
    const estimatedTao = Number(row.netuid) === 0 ? alpha : alpha * ((subnet?.taoReserve || 0) / Math.max(subnet?.alphaReserve || 0, 1e-12));

    // Root Reborn: dividends now flow into a validator-curated basket
    // rather than compounding directly into root stake. What's actually
    // owed to this staker sits in getBasketPosition, keyed by BOTH
    // hotkey and coldkey together — confirmed directly tonight after an
    // earlier, wrong attempt using a single-key call
    // (getRootBasketOwed) returned a figure ~1000x too small. Only
    // meaningful for root (netuid 0); dynamic subnets have no basket.
    let basketClaimableTao = null;
    if (Number(row.netuid) === 0) {
      try {
        const basketPos = await api.call.betaBasketRuntimeApi.getBasketPosition(row.hotkey, key);
        const json = basketPos.toJSON();
        if (json && json.valueTao != null) basketClaimableTao = taoAmount(json.valueTao);
      } catch {
        // No basket position for this validator (trading not curated
        // there, or the call isn't supported) — leave null, not zero,
        // so the frontend can distinguish "none" from "unavailable".
      }
    }

    return {
      netuid: Number(row.netuid),
      subnet: subnet?.name || `Subnet ${row.netuid}`,
      symbol: subnet?.symbol || 'α',
      hotkey: row.hotkey,
      alpha,
      estimatedTao,
      registered: Boolean(row.isRegistered),
      locked: taoAmount(row.locked),
      basketClaimableTao,
    };
  }));

  // A coldkey may allocate to several validators within one subnet — roll
  // those up into one position row while retaining the count.
  const grouped = new Map();
  for (const row of validatorAllocations) {
    const current = grouped.get(row.netuid) || {
      netuid: row.netuid, subnet: row.subnet, symbol: row.symbol,
      alpha: 0, estimatedTao: 0, locked: 0, validatorCount: 0, registeredValidators: 0, validators: [],
      basketClaimableTao: null,
    };
    current.alpha += row.alpha;
    current.estimatedTao += row.estimatedTao;
    current.locked += row.locked;
    current.validatorCount += 1;
    current.registeredValidators += row.registered ? 1 : 0;
    current.validators.push({ hotkey: row.hotkey, alpha: row.alpha, estimatedTao: row.estimatedTao, registered: row.registered });
    if (row.basketClaimableTao != null) {
      current.basketClaimableTao = (current.basketClaimableTao || 0) + row.basketClaimableTao;
    }
    grouped.set(row.netuid, current);
  }

  const positions = [...grouped.values()]
    .map(row => ({
      ...row,
      estimatedUsd: price == null ? null : row.estimatedTao * price,
      registered: row.registeredValidators > 0,
      basketClaimableUsd: (price == null || row.basketClaimableTao == null) ? null : row.basketClaimableTao * price,
    }))
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
  return result;
}

app.get('/', (req, res) => res.sendFile(new URL('./static/index.html', import.meta.url).pathname));

// ── History / baseline tracking ─────────────────────────────────────
const HISTORY_DIR = process.env.HISTORY_DIR || '/data';
fs.mkdirSync(HISTORY_DIR, { recursive: true });
const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, name), 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(name, data) {
  fs.writeFileSync(path.join(HISTORY_DIR, name), JSON.stringify(data));
}
function appendHistory(name, snapshot) {
  const arr = readJson(`history_${name}.json`, []);
  arr.push(snapshot);
  writeJson(`history_${name}.json`, arr);
}
function loadHistory(name) {
  return readJson(`history_${name}.json`, []);
}

async function captureSnapshot() {
  if (!DEFAULT_COLDKEY) return;
  let summary;
  try {
    summary = await taoSummary(DEFAULT_COLDKEY);
  } catch (e) {
    console.warn('Snapshot capture failed:', e.message);
    return;
  }

  const now = Date.now() / 1000;
  const known = readJson('known_positions.json', {});

  for (const p of summary.positions) {
    const key = String(p.netuid);
    const prior = known[key] || {};
    let baselineUsd = prior.baseline_usd;
    let baselineTs = prior.baseline_ts;

    // A meaningfully changed alpha amount means a stake/unstake happened,
    // not organic price movement — reset the baseline so P&L doesn't
    // misattribute your own capital move as a gain or loss. Small
    // fractional drift from emissions isn't a reset trigger.
    const priorAlpha = prior.last_alpha;
    const alphaChanged = priorAlpha !== undefined && Math.abs(p.alpha - priorAlpha) / Math.max(priorAlpha, 1e-9) > 0.005;

    if (baselineUsd === undefined || alphaChanged) {
      baselineUsd = p.estimatedUsd;
      baselineTs = now;
    }
    known[key] = { subnet: p.subnet, last_alpha: p.alpha, baseline_usd: baselineUsd, baseline_ts: baselineTs, last_usd: p.estimatedUsd, last_seen: now };

    appendHistory(`pos_${key}`, { ts: now, estimated_usd: p.estimatedUsd, estimated_tao: p.estimatedTao, alpha: p.alpha, basket_claimable_tao: p.basketClaimableTao });
  }
  writeJson('known_positions.json', known);

  appendHistory('portfolio', {
    ts: now,
    total_value_usd: summary.portfolio.total_value_usd,
    liquid_balance_tao: summary.liquidBalance,
    position_count: summary.portfolio.position_count,
  });
}

function attachPnl(positions) {
  const known = readJson('known_positions.json', {});
  for (const p of positions) {
    const entry = known[String(p.netuid)];
    p.baseline_usd = entry ? entry.baseline_usd : null;
    if (entry && entry.baseline_usd && p.estimatedUsd !== null) {
      p.pnl_usd = p.estimatedUsd - entry.baseline_usd;
      p.pnl_pct = (p.pnl_usd / entry.baseline_usd) * 100;
    } else {
      p.pnl_usd = null;
      p.pnl_pct = null;
    }
    attachDailyStakeGrowth(p);
  }
  return positions;
}

function attachDailyStakeGrowth(p) {
  // Genuine stake growth, separate from USD value change (which
  // conflates this with TAO price movement). Uses history already
  // stored by captureSnapshot, no new tracking infrastructure.
  //
  // Root (netuid 0) is measured differently from dynamic subnets,
  // confirmed necessary tonight: under Root Reborn, dividends land in
  // the validator's basket as claimable TAO rather than compounding
  // into raw stake — raw root alpha is now structurally near-static,
  // so measuring its delta (the old approach here) reads zero even
  // while real yield is accruing. Cross-checked against v3.lptracker's
  // own independent implementation, which does the same thing for the
  // same reason (their code comment: "Root rewards accrue in live
  // basket spot NAV or as claimable TAO without changing the raw Root
  // stake") — this isn't a guess, it's the verified correct approach.
  // Dynamic subnets have no basket concept, so raw alpha delta is
  // still the right (and only) measure there.
  const isRoot = p.netuid === 0;
  const history = loadHistory(`pos_${p.netuid}`);
  if (history.length < 2) {
    p.daily_stake_growth = null;
    p.daily_stake_growth_pct = null;
    return;
  }
  const now = Date.now() / 1000;
  const sevenDaysAgo = now - 7 * 86400;
  const windowed = history.filter(s => s.ts >= sevenDaysAgo);
  const snapshots = windowed.length >= 2 ? windowed : history.slice(-Math.min(history.length, 48));

  if (isRoot) {
    const currentValue = p.basketClaimableTao;
    // Basket claimable only ever grows from accrual or shrinks from an
    // actual claim — both are genuine yield-related events, not a
    // capital move to exclude, so no jump-filtering needed here (unlike
    // raw stake, which needs to exclude voluntary stake/unstake).
    const usable = snapshots.filter(s => s.basket_claimable_tao != null);
    if (usable.length < 2 || currentValue == null) {
      p.daily_stake_growth = null;
      p.daily_stake_growth_pct = null;
      return;
    }
    const reference = usable[0];
    const daysElapsed = (now - reference.ts) / 86400;
    if (daysElapsed < 0.1) {
      p.daily_stake_growth = null;
      p.daily_stake_growth_pct = null;
      return;
    }
    const growth = currentValue - reference.basket_claimable_tao;
    p.daily_stake_growth = growth / daysElapsed;
    p.daily_stake_growth_pct = p.alpha > 0 ? (p.daily_stake_growth / p.alpha) * 100 : null;
    return;
  }

  // A single interval is "organic" if the rate it implies, annualized,
  // is under a generous cap — real staking dividends don't remotely
  // approach this; a manual stake/unstake easily does in one snapshot.
  const MAX_ORGANIC_ANNUALIZED_RATE = 0.5; // 50%/year
  let organicGrowth = 0;
  let organicDays = 0;
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const cur = snapshots[i];
    const intervalDays = (cur.ts - prev.ts) / 86400;
    if (intervalDays <= 0 || !(prev.alpha > 0)) continue;
    const delta = cur.alpha - prev.alpha;
    const impliedAnnualRate = Math.abs(delta / prev.alpha) * (365 / intervalDays);
    if (impliedAnnualRate > MAX_ORGANIC_ANNUALIZED_RATE) continue; // manual action — excluded
    organicGrowth += delta;
    organicDays += intervalDays;
  }

  if (organicDays < 0.5) {
    p.daily_stake_growth = null;
    p.daily_stake_growth_pct = null;
    return;
  }
  p.daily_stake_growth = organicGrowth / organicDays;
  p.daily_stake_growth_pct = p.alpha > 0 ? (p.daily_stake_growth / p.alpha) * 100 : null;
}

const RANGE_TO_SECONDS = { '7d': 7 * 86400, '30d': 30 * 86400, '90d': 90 * 86400, all: null };

app.get('/api/history', (req, res) => {
  const range = req.query.range || '30d';
  if (!(range in RANGE_TO_SECONDS)) return res.status(400).json({ error: 'range must be one of: 7d, 30d, 90d, all' });
  let snapshots = loadHistory('portfolio');
  const windowSeconds = RANGE_TO_SECONDS[range];
  if (windowSeconds !== null) {
    const cutoff = Date.now() / 1000 - windowSeconds;
    snapshots = snapshots.filter(s => s.ts >= cutoff);
  }
  res.json({ snapshots, range });
});

app.get('/api/history/:netuid', (req, res) => {
  const range = req.query.range || '30d';
  if (!(range in RANGE_TO_SECONDS)) return res.status(400).json({ error: 'range must be one of: 7d, 30d, 90d, all' });
  let snapshots = loadHistory(`pos_${req.params.netuid}`);
  const windowSeconds = RANGE_TO_SECONDS[range];
  if (windowSeconds !== null) {
    const cutoff = Date.now() / 1000 - windowSeconds;
    snapshots = snapshots.filter(s => s.ts >= cutoff);
  }
  res.json({ snapshots, range, netuid: req.params.netuid });
});

setInterval(() => { captureSnapshot().catch(e => console.error('Snapshot loop error:', e)); }, SNAPSHOT_INTERVAL_MS);
captureSnapshot().catch(e => console.error('Initial snapshot error:', e));

app.get('/api/positions', async (req, res) => {
  const coldkey = (req.query.coldkey || DEFAULT_COLDKEY || '').trim();
  if (!coldkey) return res.status(400).json({ error: 'No coldkey specified and no default coldkey configured' });
  try {
    const result = await taoSummary(coldkey);
    if (coldkey === DEFAULT_COLDKEY) attachPnl(result.positions);
    res.json(result);
  } catch (e) {
    console.error('taoSummary failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── AlphaChaser bot wallet (chain data only) ────────────────────────
const alphaChaser = createAlphaChaser({ dataDir: HISTORY_DIR, taoSummary });
alphaChaser.start();
app.get('/alphachaser', (req, res) => res.sendFile(new URL('./static/alphachaser.html', import.meta.url).pathname));
app.get('/api/alphachaser', async (req, res) => {
  try { res.json(await alphaChaser.summary()); }
  catch (e) { console.error('alphachaser summary failed:', e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Listening on ${PORT}`));
