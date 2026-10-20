// zkauth init: the admin, sponsor and guardian accounts and the prover token,
// in $ZKAUTH_STATE_DIR/secrets.env (mode 0600). Idempotent: an account or token
// that exists (in the file or the environment) is kept.
import { randomBytes } from "node:crypto";
import { generateAccount, secretKeyToMnemonic } from "../../../upstream/snarkjs-algorand/node_modules/algosdk/dist/esm/index.js";
import { AlgorandClient, microAlgos } from "../../../packages/chain/src/deps.ts";
import { guardianAddress, roleSigner, type Role } from "../../../packages/config/src/index.ts";
import { CliError, algo, parse, writeSecrets, type Ctx } from "./lib.ts";

const ENV_NAME: Record<Role, string> = { admin: "ZKAUTH_ADMIN_MNEMONIC", sponsor: "ZKAUTH_SPONSOR_MNEMONIC", guardian: "ZKAUTH_GUARDIAN_MNEMONIC" };
const DISPENSER = "https://dispenser.testnet.aws.algodev.network/";
// LocalNet accounts are topped up to the target when they fall below the floor.
const LOCAL_FLOOR = 10_000_000n;
const LOCAL_TARGET = 100_000_000n;
// TestNet: what a first deployment needs. The quickstart asks for 5 ALGO per provider deployment.
const TESTNET_NEED: Record<"admin" | "sponsor", bigint> = { admin: 5_000_000n, sponsor: 10_000_000n };

export const INIT_HELP = `Usage: zkauth init [--wait] [--dry-run]

Creates the admin, sponsor and guardian accounts and a random prover token, and
writes them to $ZKAUTH_STATE_DIR/secrets.env (mode 0600). Accounts and tokens
already present, in that file or in the environment, are kept, so rerunning is safe.

  LocalNet  funds admin and sponsor from the LocalNet KMD dispenser (topped up
            to ${algo(LOCAL_TARGET)} when below ${algo(LOCAL_FLOOR)}), and a guardian
            held in secrets.env with ${algo(10_000_000n)} for its veto fees.
  TestNet   prints the addresses and how much to fund; --wait polls until the
            admin and sponsor can spend it. No network call is made without --wait.

The guardian may live elsewhere: set ZKAUTH_GUARDIAN_ADDRESS (and no guardian
mnemonic) and init keeps that address instead of creating an account.

Options:
  --wait      TestNet: wait until the accounts are funded
  --dry-run   Say what would happen; write and send nothing`;

const spendable = async (algodUrl: string, address: string): Promise<bigint> => {
  const response = await fetch(`${algodUrl.replace(/\/$/, "")}/v2/accounts/${address}?exclude=all`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new CliError(`TestNet node returned HTTP ${response.status}`);
  const account = await response.json() as { amount: number | string; "min-balance"?: number | string };
  return BigInt(account.amount) - BigInt(account["min-balance"] ?? 0);
};

export async function init(ctx: Ctx, args: string[]): Promise<number> {
  const { values } = parse(args, { wait: { type: "boolean" }, "dry-run": { type: "boolean" }, help: { type: "boolean" } });
  const { service, env } = ctx;
  const dry = values["dry-run"] === true;
  const updates: Record<string, string> = {};
  const created: string[] = [];

  const addresses: Partial<Record<Role, string>> = {};
  for (const role of ["admin", "sponsor"] as const) {
    const existing = roleSigner(role, service, env);
    if (existing) { addresses[role] = existing.addr; continue; }
    created.push(role);
    if (dry) continue;
    const account = generateAccount();
    updates[ENV_NAME[role]] = secretKeyToMnemonic(account.sk);
    addresses[role] = account.addr.toString();
  }
  // The guardian: a mnemonic here, or only an address when it is held elsewhere.
  const guardianSigner = roleSigner("guardian", service, env);
  if (guardianSigner) addresses.guardian = guardianSigner.addr;
  else if (guardianAddress(service, env)) addresses.guardian = guardianAddress(service, env);
  else {
    created.push("guardian");
    if (!dry) {
      const account = generateAccount();
      updates[ENV_NAME.guardian] = secretKeyToMnemonic(account.sk);
      addresses.guardian = account.addr.toString();
    }
  }
  if (addresses.guardian && !env.ZKAUTH_GUARDIAN_ADDRESS) updates.ZKAUTH_GUARDIAN_ADDRESS = addresses.guardian;
  if (!env.ZKAUTH_PROVER_TOKEN) { updates.ZKAUTH_PROVER_TOKEN = randomBytes(32).toString("hex"); created.push("prover token"); }
  if (addresses.admin && addresses.admin === addresses.guardian) throw new CliError("The guardian must differ from the admin: give ZKAUTH_GUARDIAN_ADDRESS another address");

  if (guardianSigner && env.ZKAUTH_GUARDIAN_ADDRESS && env.ZKAUTH_GUARDIAN_ADDRESS !== guardianSigner.addr)
    throw new CliError("ZKAUTH_GUARDIAN_ADDRESS does not match ZKAUTH_GUARDIAN_MNEMONIC");

  ctx.print(`network: ${service.network}${dry ? " (dry run: nothing is written or sent)" : ""}`);
  if (!dry && Object.keys(updates).length) {
    writeSecrets(ctx.secretsPath, updates);
    ctx.print(`Wrote ${ctx.secretsPath} (mode 0600). It holds the account mnemonics: keep it private and out of version control.`);
  } else if (!dry) {
    ctx.print(`${ctx.secretsPath} is complete; nothing to create.`);
  }
  if (dry && created.length) ctx.print(`Would create: ${created.join(", ")}.`);

  const row = (role: string, address: string | undefined, note = "") => ctx.print(`  ${role.padEnd(9)} ${address ?? "(created on a real run)"}${note ? `  ${note}` : ""}`);
  ctx.print("Accounts:");
  row("admin", addresses.admin, "key-registry creator and keysync signer");
  row("sponsor", addresses.sponsor, "pays enrollment deposits and fees");
  row("guardian", addresses.guardian, guardianSigner || updates.ZKAUTH_GUARDIAN_MNEMONIC ? "mnemonic is in secrets.env; keep it off service hosts" : "mnemonic is held elsewhere");

  if (dry) return 0;
  if (service.network === "localnet") {
    const kmd = new URL(service.kmdUrl!);
    const algorand = AlgorandClient.fromConfig({
      algodConfig: { server: service.algodUrl, token: service.algodToken },
      // algosdk's Kmd defaults to port 7833 unless one is given, so split the URL.
      kmdConfig: { server: `${kmd.protocol}//${kmd.hostname}`, port: Number(kmd.port || (kmd.protocol === "https:" ? 443 : 80)), token: service.kmdToken! },
    });
    let dispenser;
    try { dispenser = await algorand.account.localNetDispenser(); } catch { throw new CliError(`No LocalNet dispenser at ${service.kmdUrl}; is LocalNet running (algokit localnet start)?`); }
    // The guardian needs fees for its veto actions, so a guardian held here is funded too.
    const funded: [string, string, bigint, bigint][] = [
      ["admin", addresses.admin!, LOCAL_FLOOR, LOCAL_TARGET], ["sponsor", addresses.sponsor!, LOCAL_FLOOR, LOCAL_TARGET],
      ...(guardianSigner || updates.ZKAUTH_GUARDIAN_MNEMONIC ? [["guardian", addresses.guardian!, 1_000_000n, 10_000_000n] as [string, string, bigint, bigint]] : []),
    ];
    for (const [role, address, floor, target] of funded) {
      const balance = (await algorand.account.getInformation(address)).balance.microAlgo;
      if (balance >= floor) { ctx.print(`  ${role} has ${algo(balance)}`); continue; }
      await algorand.send.payment({ sender: dispenser, receiver: address, amount: microAlgos(target - balance) });
      ctx.print(`  funded ${role} to ${algo(target)}`);
    }
    return 0;
  }

  // TestNet: say what to fund; wait only when asked.
  ctx.print("");
  ctx.print(`Fund these TestNet accounts (dispenser: ${DISPENSER}):`);
  for (const role of ["admin", "sponsor"] as const) ctx.print(`  ${role}: at least ${algo(TESTNET_NEED[role])}  ${addresses[role]}`);
  ctx.print(`  guardian: about 0.50 ALGO is enough for its veto transactions, when you need them  ${addresses.guardian}`);
  if (!values.wait) { ctx.print("Run `zkauth init --wait` to wait until they are funded."); return 0; }
  ctx.print("Waiting for funds (Ctrl-C to stop; rerun to resume)...");
  for (const role of ["admin", "sponsor"] as const) {
    while ((await spendable(service.algodUrl, addresses[role]!)) < TESTNET_NEED[role]) await new Promise((done) => setTimeout(done, 10_000));
    ctx.print(`  ${role} is funded`);
  }
  return 0;
}
