// Diagnostic for the AlphaChaser page (chain data only).
// 1. Print current runtime field layouts for stake-related events.
// 2. Sample the bot wallet's stake every STEP blocks over the last 24h on
//    the archive node to find when it changed (= trades).
// 3. Dump every event touching the coldkey in the blocks where it changed.
import { ApiPromise, WsProvider } from '@polkadot/api';

const ARCHIVE = process.env.BITTENSOR_ARCHIVE_WS_URL || 'wss://archive.chain.opentensor.ai:443';
const COLDKEY = process.env.AC_COLDKEY || '5H5aHNEKpT6wtyq1fTZB8aj3NT8JytE8FjxYmd5JBwGWtZBA';
const HOURS = Number(process.env.AC_HOURS || 26);
const STEP = 50;

const agg = (rows) => {
  const m = {};
  for (const r of rows || []) m[Number(r.netuid)] = (m[Number(r.netuid)] || 0) + Number(r.stake) / 1e9;
  return m;
};
// A real trade: subnet set changes, or any subnet's alpha moves > 1% (emissions are far smaller per step)
const traded = (a, b) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = a[k] || 0, y = b[k] || 0;
    if ((x > 0) !== (y > 0)) return true;
    if (Math.abs(y - x) / Math.max(x, 1e-9) > 0.01) return true;
  }
  return false;
};

async function main() {
  const api = await ApiPromise.create({ provider: new WsProvider(ARCHIVE), noInitWarn: true });
  const rt = api.runtimeVersion;
  console.log(`Connected to ${ARCHIVE} — spec ${rt.specName} v${rt.specVersion}\n`);

  console.log('--- Event layouts ---');
  for (const name of Object.keys(api.events.subtensorModule)) {
    if (!/stake|swap|move|transfer/i.test(name)) continue;
    const meta = api.events.subtensorModule[name].meta;
    console.log(`${name}(${meta.fields.map(f => `${f.name.toString() || '_'}:${f.typeName.toString()}`).join(', ')})`);
  }

  const head = (await api.rpc.chain.getHeader()).number.toNumber();
  const start = head - Math.round(HOURS * 3600 / 12);
  console.log(`\nHead ${head}; scanning ${start}..${head} every ${STEP} blocks`);

  const stakeAt = async (n) => {
    const h = await api.rpc.chain.getBlockHash(n);
    const at = await api.at(h);
    const rows = (await at.call.stakeInfoRuntimeApi.getStakeInfoForColdkey(COLDKEY)).toJSON();
    return agg(rows);
  };

  // Coarse pass
  const changes = [];
  let prevN = start, prevFp = await stakeAt(start);
  for (let n = start + STEP; n <= head; n += STEP) {
    const cur = await stakeAt(n);
    if (traded(prevFp, cur)) changes.push([prevN, n]);
    prevN = n; prevFp = cur;
  }
  console.log(`Coarse intervals with stake changes: ${changes.length}`);

  const tsOf = async (n) => {
    const at = await api.at(await api.rpc.chain.getBlockHash(n));
    return new Date(Number((await at.query.timestamp.now()).toString())).toISOString();
  };

  // Fine pass: dump events in each changed interval
  for (const [a, b] of changes) {
    console.log(`\n=== Interval ${a}..${b} (${await tsOf(a)} → ${await tsOf(b)}) ===`);
    for (let n = a + 1; n <= b; n++) {
      const h = await api.rpc.chain.getBlockHash(n);
      const at = await api.at(h);
      const events = await at.query.system.events();
      const hits = events.filter(({ event }) => JSON.stringify(event.toJSON()).includes(COLDKEY) || (event.section === 'subtensorModule' && JSON.stringify(event.data.toHuman()).includes(COLDKEY)));
      if (!hits.length) continue;
      console.log(`block ${n} @ ${await tsOf(n)}`);
      for (const { event, phase } of hits) {
        console.log(`  ${event.section}.${event.method} phase=${phase.toString()} data=${JSON.stringify(event.data.toHuman())}`);
      }
      // Show the extrinsic shape for one hit (proxy? batch?)
      const blk = await api.rpc.chain.getBlock(h);
      for (const { phase } of hits) {
        if (phase.isApplyExtrinsic) {
          const ex = blk.block.extrinsics[phase.asApplyExtrinsic.toNumber()];
          console.log(`  extrinsic: ${ex.method.section}.${ex.method.method} signer=${ex.signer.toString()}`);
          break;
        }
      }
    }
  }
  await api.disconnect();
  console.log('\nDONE');
  process.exit(0);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
