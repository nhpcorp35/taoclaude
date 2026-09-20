const HOTKEYS = [
  '5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u',
  '5Ckaoft1B1CQ9zBV2FLVju4KPuMQzJVn7QUf3JeTvTq1uUes',
  '5DXdHixxtCvoa6GHKs2Jgrdzc61882Ftx1zN2sYFQuwgL1S1',
];

async function main() {
  const resp = await fetch('https://raw.githubusercontent.com/opentensor/bittensor-delegates/main/public/delegates.json');
  const registry = await resp.json();
  for (const hk of HOTKEYS) {
    const entry = registry[hk];
    console.log(`${hk}: ${entry ? entry.name : '(not in registry)'}`);
  }
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
