/**
 * AlphaChaser bot wallet tracker — chain data only (no TaoStats).
 *
 * Trades are read from on-chain events via the archive node. Verified
 * against spec v470 with diagnostic_alphachaser.js:
 *   StakeAdded / StakeRemoved = [coldkey, hotkey, tao, alpha, netuid, fee]
 * The bot trades through proxy.proxy, but the coldkey is on every event.
 *
 * Detection: sample the wallet's stake + free balance every STEP blocks.
 * Emissions only drift stake slowly, so an interval is scanned block by
 * block only when a subnet appears/disappears, any subnet's alpha moves
 * >1%, or free TAO changes. The same code path does the one-time backfill
 * and the ongoing incremental scan.
 */
import fs from 'fs';
import path from 'path';
import { ApiPromise, WsProvider } from '@polkadot/api';

const COLDKEY = process.env.AC_COLDKEY || '5H5aHNEKpT6wtyq1fTZB8aj3NT8JytE8FjxYmd5JBwGWtZBA';
const ARCHIVE = process.env.BITTENSOR_ARCHIVE_WS_URL || 'wss://archive.chain.opentensor.ai:443';
const BACKFILL_DAYS = Number(process.env.AC_BACKFILL_DAYS || 30);
const SCAN_INTERVAL_MS = Number(process.env.AC_SCAN_INTERVAL_MS || 10 * 60 * 1000);
const STEP = 50;
const BLOCKS_PER_DAY = 7200;
const rao = (v) => Number(String(v).replace(/,/g, '')) / 1e9;

let archive = null;
async function getArchive(forceFresh = false) {
  if (!forceFresh && archive && archive.isConnected) return archive;
  if (archive) { try { await archive.disconnect(); } catch { /* gone */ } }
  archive = await ApiPromise.create({ provider: new WsProvider(ARCHIVE), noInitWarn: true });
  return archive;
}

export function createAlphaChaser({ dataDir, taoSummary }) {
  const FILE = path.join(dataDir, 'alphachaser.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; } };
  const save = (s) => { fs.writeFileSync(FILE + '.tmp', JSON.stringify(s)); fs.renameSync(FILE + '.tmp', FILE); };

  let scanning = false;
  let lastError = null;
  let lastHead = 0;

  async function walletAt(api, n) {
    const at = await api.at(await api.rpc.chain.getBlockHash(n));
    const [rows, acct] = await Promise.all([
      at.call.stakeInfoRuntimeApi.getStakeInfoForColdkey(COLDKEY),
      at.query.system.account(COLDKEY),
    ]);
    const alpha = {};
    for (const r of rows.toJSON() || []) alpha[Number(r.netuid)] = (alpha[Number(r.netuid)] || 0) + Number(r.stake) / 1e9;
    return { alpha, free: Number(acct.data.free.toString()) / 1e9, at };
  }

  function traded(a, b) {
    if (Math.abs(a.free - b.free) > 0.0001) return true;
    for (const k of new Set([...Object.keys(a.alpha), ...Object.keys(b.alpha)])) {
      const x = a.alpha[k] || 0, y = b.alpha[k] || 0;
      if ((x > 0) !== (y > 0)) return true;
      if (Math.abs(y - x) / Math.max(x, 1e-9) > 0.01) return true;
    }
    return false;
  }

  async function valueTao(at, w) {
    let v = w.free;
    for (const [n, a] of Object.entries(w.alpha)) {
      if (Number(n) === 0) { v += a; continue; }
      const [t, al] = await Promise.all([at.query.subtensorModule.subnetTAO(Number(n)), at.query.subtensorModule.subnetAlphaIn(Number(n))]);
      v += a * (Number(t.toString()) / Math.max(Number(al.toString()), 1));
    }
    return v;
  }

  async function scanBlock(api, n, state) {
    const hash = await api.rpc.chain.getBlockHash(n);
    const at = await api.at(hash);
    const [events, tsRaw] = await Promise.all([at.query.system.events(), at.query.timestamp.now()]);
    const ts = Number(tsRaw.toString()) / 1000;
    const byExt = new Map();
    for (const { event, phase } of events) {
      if (!phase.isApplyExtrinsic) continue;
      const idx = phase.asApplyExtrinsic.toNumber();
      if (!byExt.has(idx)) byExt.set(idx, []);
      byExt.get(idx).push(event);
    }
    for (const [idx, evs] of byExt) {
      let hadStake = false;
      for (const ev of evs) {
        if (ev.section !== 'subtensorModule') continue;
        const d = ev.data.toJSON();
        if (ev.method === 'StakeAdded' || ev.method === 'StakeRemoved') {
          if (String(d[0]) !== COLDKEY) continue;
          hadStake = true;
          const tao = rao(d[2]), alpha = rao(d[3]);
          state.trades.push({
            block: n, ts, ext: idx,
            side: ev.method === 'StakeAdded' ? 'BUY' : 'SELL',
            netuid: Number(d[4]), tao, alpha, fee: rao(d[5]),
            price: alpha > 0 ? tao / alpha : null,
          });
        } else if (['StakeMoved', 'StakeSwapped', 'StakeTransferred'].includes(ev.method)) {
          if (!JSON.stringify(d).includes(COLDKEY)) continue;
          hadStake = true;
          state.other.push({ block: n, ts, ext: idx, method: ev.method, data: ev.data.toHuman() });
        }
      }
      if (hadStake) continue;
      // Plain transfers in/out of the wallet (not part of a stake op) = deposits/withdrawals
      for (const ev of evs) {
        if (ev.section !== 'balances' || ev.method !== 'Transfer') continue;
        const d = ev.data.toJSON();
        const from = String(d[0] ?? d.from), to = String(d[1] ?? d.to), amt = rao(d[2] ?? d.amount);
        if (to === COLDKEY) state.transfers.push({ block: n, ts, dir: 'IN', amount: amt, counterparty: from });
        else if (from === COLDKEY) state.transfers.push({ block: n, ts, dir: 'OUT', amount: amt, counterparty: to });
      }
    }
  }

  async function scan() {
    if (scanning) return;
    scanning = true;
    try {
      const api = await getArchive();
      const head = (await api.rpc.chain.getHeader()).number.toNumber();
      lastHead = head;
      let state = load();
      if (!state || state.coldkey !== COLDKEY) {
        const start = head - BACKFILL_DAYS * BLOCKS_PER_DAY;
        const w = await walletAt(api, start);
        state = {
          coldkey: COLDKEY, start_block: start,
          start_ts: Number((await w.at.query.timestamp.now()).toString()) / 1000,
          start_value_tao: await valueTao(w.at, w),
          scanned_to: start, trades: [], transfers: [], other: [], snapshots: [],
        };
        save(state);
        console.log(`alphachaser: backfill from block ${start}, start value ${state.start_value_tao.toFixed(4)} τ`);
      }
      let prev = await walletAt(api, state.scanned_to);
      let n = state.scanned_to;
      let sinceSave = 0;
      while (n < head) {
        const next = Math.min(n + STEP, head);
        let cur;
        try {
          cur = await walletAt(api, next);
          if (traded(prev, cur)) {
            for (let b = n + 1; b <= next; b++) await scanBlock(api, b, state);
          }
        } catch (e) {
          if (!api.isConnected) throw e; // connection problem: abort, resume next cycle
          // Don't let one undecodable interval (old runtime, node hiccup) stall
          // the scan forever — record the gap and move on.
          console.warn(`alphachaser: interval ${n}..${next} failed (${e.message}), recording gap`);
          state.gaps = state.gaps || [];
          state.gaps.push([n, next, e.message]);
          cur = await walletAt(api, next).catch(() => prev);
        }
        state.scanned_to = next;
        prev = cur; n = next;
        if (++sinceSave >= 40) { save(state); sinceSave = 0; }
      }
      save(state);
      lastError = null;
    } catch (e) {
      lastError = e.message;
      console.warn('alphachaser scan failed:', e.message);
      try { await getArchive(true); } catch { /* retry next cycle */ }
    } finally {
      scanning = false;
    }
  }

  async function snapshot() {
    const state = load();
    if (!state) return;
    try {
      const s = await taoSummary(COLDKEY);
      const staked = s.positions.reduce((a, p) => a + p.estimatedTao, 0);
      state.snapshots.push({ ts: Date.now() / 1000, value_tao: staked + s.liquidBalance, staked_tao: staked, free_tao: s.liquidBalance, tao_usd: s.taoPrice });
      save(state);
    } catch (e) {
      console.warn('alphachaser snapshot failed:', e.message);
    }
  }

  function fifo(trades, priceByNetuid) {
    const lots = {}, realized = {}, spent = {}, received = {};
    for (const t of [...trades].sort((a, b) => a.block - b.block || a.ext - b.ext)) {
      const k = t.netuid;
      lots[k] = lots[k] || []; realized[k] = realized[k] || 0; spent[k] = spent[k] || 0; received[k] = received[k] || 0;
      if (t.side === 'BUY') { lots[k].push([t.alpha, t.tao]); spent[k] += t.tao; continue; }
      received[k] += t.tao;
      let remaining = t.alpha, cost = 0;
      while (remaining > 1e-12 && lots[k].length) {
        const lot = lots[k][0];
        if (lot[0] <= remaining) { cost += lot[1]; remaining -= lot[0]; lots[k].shift(); }
        else { const f = remaining / lot[0]; cost += lot[1] * f; lot[0] -= remaining; lot[1] -= lot[1] * f; remaining = 0; }
      }
      // Alpha sold with no recorded buy (held before scan start): no cost basis, so exclude from realized
      const matchedFrac = t.alpha > 0 ? (t.alpha - remaining) / t.alpha : 0;
      realized[k] += t.tao * matchedFrac - cost;
    }
    const out = {};
    for (const k of Object.keys(lots)) {
      const openAlpha = lots[k].reduce((a, l) => a + l[0], 0);
      const openCost = lots[k].reduce((a, l) => a + l[1], 0);
      const px = priceByNetuid[k];
      const unrealized = px != null && openAlpha > 1e-9 ? openAlpha * px - openCost : 0;
      out[k] = { netuid: Number(k), realized_tao: realized[k], unrealized_tao: unrealized, total_tao: realized[k] + unrealized, open_alpha: openAlpha, open_cost_tao: openCost, spent_tao: spent[k], received_tao: received[k] };
    }
    return out;
  }

  async function summary() {
    const state = load();
    const s = await taoSummary(COLDKEY);
    const staked = s.positions.reduce((a, p) => a + p.estimatedTao, 0);
    const value = staked + s.liquidBalance;
    const priceByNetuid = {};
    for (const p of s.positions) priceByNetuid[p.netuid] = p.alpha > 0 ? p.estimatedTao / p.alpha : null;
    if (!state) {
      return { ok: true, syncing: true, error: lastError, coldkey: COLDKEY, tao_price: s.taoPrice, positions: s.positions, totals: { value_tao: value, staked_tao: staked, free_tao: s.liquidBalance } };
    }
    const byNetuid = fifo(state.trades, priceByNetuid);
    for (const p of s.positions) p.pnl = byNetuid[p.netuid] || null;
    const netDeposits = state.transfers.reduce((a, t) => a + (t.dir === 'IN' ? t.amount : -t.amount), 0);
    const pnl = value - state.start_value_tao - netDeposits;
    const px = s.taoPrice;
    const usd = (x) => (px == null ? null : x * px);
    const realized = Object.values(byNetuid).reduce((a, v) => a + v.realized_tao, 0);
    const unrealized = Object.values(byNetuid).reduce((a, v) => a + v.unrealized_tao, 0);
    return {
      ok: true,
      syncing: scanning && lastHead - state.scanned_to > 300,
      gaps: (state.gaps || []).length,
      error: lastError,
      coldkey: COLDKEY,
      tao_price: px,
      start: { block: state.start_block, ts: state.start_ts, value_tao: state.start_value_tao },
      scanned_to: state.scanned_to,
      positions: s.positions,
      by_subnet: Object.values(byNetuid),
      totals: {
        value_tao: value, value_usd: usd(value),
        staked_tao: staked, free_tao: s.liquidBalance,
        net_deposits_tao: netDeposits,
        pnl_tao: pnl, pnl_usd: usd(pnl),
        pnl_pct: state.start_value_tao + netDeposits > 0 ? (pnl / (state.start_value_tao + Math.max(netDeposits, 0))) * 100 : null,
        realized_tao: realized, unrealized_tao: unrealized,
      },
      trade_count: state.trades.length,
      trades: [...state.trades].sort((a, b) => b.block - a.block || b.ext - a.ext).slice(0, 300),
      transfers: [...state.transfers].sort((a, b) => b.block - a.block),
      other: state.other,
      snapshots: state.snapshots,
    };
  }

  function start() {
    setTimeout(() => scan().catch(() => {}), 5000);
    setInterval(() => scan().catch(() => {}), SCAN_INTERVAL_MS);
    setInterval(() => snapshot().catch(() => {}), 60 * 60 * 1000);
    setTimeout(() => snapshot().catch(() => {}), 60 * 1000);
  }

  return { start, summary, scan, _fifo: fifo, _traded: traded };
}
