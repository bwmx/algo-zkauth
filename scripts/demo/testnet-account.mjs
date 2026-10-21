// The TestNet account that deploys this clone's contracts and sponsors fees, and
// the key-registry guardian.
//
//   node scripts/demo/testnet-account.mjs create           add new accounts to .env unless they exist
//   node scripts/demo/testnet-account.mjs wait <microAlgos>  wait until it can spend that much
//
// The mnemonic is written only to the ignored .env (mode 600), never printed.
import { appendFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { generateAccount, mnemonicToSecretKey, secretKeyToMnemonic } from "../../upstream/snarkjs-algorand/node_modules/algosdk/dist/esm/index.js";

const root = new URL("../../", import.meta.url).pathname;
const envPath = `${root}.env`;
const ALGOD = "https://testnet-api.algonode.cloud";
const DISPENSER = "https://dispenser.testnet.aws.algodev.network/";
const algo = micro => `${(Number(micro) / 1e6).toFixed(2)} ALGO`;

function stored(name = "TESTNET_MNEMONIC") {
  if (!existsSync(envPath)) return undefined;
  const line = readFileSync(envPath, "utf8").split("\n").find(l => l.startsWith(`${name}=`));
  return line?.slice(name.length + 1).trim().replace(/^"(.*)"$/, "$1") || undefined;
}

function append(name, account) {
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  appendFileSync(envPath, `${existing && !existing.endsWith("\n") ? "\n" : ""}${name}=${secretKeyToMnemonic(account.sk)}\n`, { mode: 0o600 });
  chmodSync(envPath, 0o600);
}

async function spendable(address) {
  const response = await fetch(`${ALGOD}/v2/accounts/${address}?exclude=all`);
  if (!response.ok) throw new Error(`TestNet node returned HTTP ${response.status}`);
  const account = await response.json();
  return BigInt(account.amount) - BigInt(account["min-balance"]);
}

const [command, amount] = process.argv.slice(2);
if (command === "create") {
  if (stored()) {
    console.log(`Using the TestNet account in .env: ${mnemonicToSecretKey(stored()).addr}`);
  } else {
    const account = generateAccount();
    append("TESTNET_MNEMONIC", account);
    console.log(`Created a new TestNet account and saved it in .env: ${account.addr}`);
  }
  // A guardian kept beside the administrator shows the mechanism; set
  // KEY_GUARDIAN_ADDRESS instead to use one held on another device.
  if (stored("KEY_GUARDIAN_ADDRESS")) console.log(`Using the key-registry guardian in .env: ${stored("KEY_GUARDIAN_ADDRESS")}`);
  else if (stored("KEY_GUARDIAN_MNEMONIC")) console.log(`Using the key-registry guardian in .env: ${mnemonicToSecretKey(stored("KEY_GUARDIAN_MNEMONIC")).addr}`);
  else {
    const guardian = generateAccount();
    append("KEY_GUARDIAN_MNEMONIC", guardian);
    console.log(`Created a key-registry guardian account and saved it in .env: ${guardian.addr}`);
  }
} else if (command === "wait" && /^[0-9]+$/.test(amount ?? "")) {
  const mnemonic = stored();
  if (!mnemonic) throw new Error("No TESTNET_MNEMONIC in .env; run: node scripts/demo/testnet-account.mjs create");
  const address = mnemonicToSecretKey(mnemonic).addr.toString();
  const needed = BigInt(amount);
  let available = await spendable(address);
  if (available < needed) {
    console.log(`\nFund this TestNet account with at least ${algo(needed - available)} more:\n\n  ${address}\n\nUse the TestNet dispenser: ${DISPENSER}\nWaiting for funds (Ctrl-C to stop; rerun the quickstart to resume)…`);
    while (available < needed) {
      await new Promise(resolve => setTimeout(resolve, 10_000));
      available = await spendable(address);
    }
  }
  console.log(`TestNet account has ${algo(available)} available.`);
} else {
  console.error("Usage: node scripts/demo/testnet-account.mjs create | wait <microAlgos>");
  process.exit(2);
}
