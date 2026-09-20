async function main() {
  const resp = await fetch('https://raw.githubusercontent.com/opentensor/bittensor-delegates/main/public/delegates.json');
  const registry = await resp.json();
  const hk = '5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5';
  const entry = registry[hk];
  console.log(entry ? JSON.stringify(entry, null, 2) : '(not in registry)');
}
main().catch(e => { console.error('FAILED:', e); process.exit(1); });
