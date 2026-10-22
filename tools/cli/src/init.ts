// zkauth init: the admin, sponsor and guardian accounts and the prover token,
// in $ZKAUTH_STATE_DIR/secrets.env (mode 0600). Idempotent: an account or token
// that exists (in the file or the environment) is kept, and funding only tops
// up an account that holds less than it needs (from the LocalNet dispenser, or
// from a funding account named with --fund-from).
import { randomBytes } from "node:crypto";
import { generateAccount, secretKeyToMnemonic } from "../../../upstream/snarkjs-algorand/node_modules/algosdk/dist/esm/index.js";
import { AlgorandClient, microAlgos } from "../../../packages/chain/src/deps.ts";
import { guardianAddress, roleSigner, signerFromMnemonic, type Role } from "../../../packages/config/src/index.ts";
import type { Signer } from "../../../packages/chain/src/types.ts";
import { CliError, UsageError, algo, parse, writeSecrets, type Ctx } from "./lib.ts";

const ENV_NAME: Record<Role, string> = { admin: "ZKAUTH_ADMIN_MNEMONIC", sponsor: "ZKAUTH_SPONSOR_MNEMONIC", guardian: "ZKAUTH_GUARDIAN_MNEMONIC" };
const DISPENSER = "https://dispenser.testnet.aws.algodev.network/";
// LocalNet accounts are topped up to the target when they fall below the floor.
const LOCAL_FLOOR = 10_000_000n;
const LOCAL_TARGET = 100_000_000n;
// TestNet: what a first deployment needs. The quickstart asks for 5 ALGO per provider deployment.
const TESTNET_NEED: Record<"admin" | "sponsor", bigint> = { admin: 5_000_000n, sponsor: 10_000_000n };
// The guardian's veto transactions.
const GUARDIAN_NEED = 500_000n;
// An account's minimum balance once it exists.
const ACCOUNT_MIN = 100_000n;
const FEE = 1_000n;

export const INIT_HELP = `Usage: zkauth init [--wait] [--fund-from <ENV_VAR>] [--dry-run]

Creates the admin, sponsor and guardian accounts and a random prover token, and
writes them to $ZKAUTH_STATE_DIR/secrets.env (mode 0600). Accounts and tokens
already present, in that file or in the environment, are kept, so rerunning is safe.

  LocalNet  funds admin and sponsor from the LocalNet KMD dispenser (topped up
            to ${algo(LOCAL_TARGET)} when below ${algo(LOCAL_FLOOR)}), and a guardian
            held in secrets.env with ${algo(10_000_000n)} for its veto fees.
  TestNet   prints the addresses and how much to fund; --wait polls until the
            admin and sponsor can spend it. No network call is made without
            --wait or --fund-from.

The guardian may live elsewhere: set ZKAUTH_GUARDIAN_ADDRESS (and no guardian
mnemonic) and init keeps that address instead of creating an account.

Options:
  --wait                 TestNet: wait until the accounts are funded
  --fund-from <ENV_VAR>  TestNet or LocalNet: top up the admin to ${algo(TESTNET_NEED.admin)} and the sponsor
                         to ${algo(TESTNET_NEED.sponsor)} spendable, and the guardian to ${algo(GUARDIAN_NEED)}, from the
                         account whose mnemonic is in that environment variable
                         (on LocalNet instead of the KMD dispenser). The funder must
                         be none of the three; an account already holding enough
                         is left alone, so rerunning sends nothing.
  --dry-run              Say what would happen; write and send nothing`;

/** An account's balance above its minimum; an account that does not exist yet will need ACCOUNT_MIN. */
const spendableOf = async (algorand: AlgorandClient, address: string) => {
  const info = await algorand.account.getInformation(address);
  const minimum = info.minBalance.microAlgo > ACCOUNT_MIN ? info.minBalance.microAlgo : ACCOUNT_MIN;
  return info.balance.microAlgo - minimum;
};

/** The funder for --fund-from: its signer, read from the named variable. The mnemonic is never printed. */
function funderFrom(ctx: Ctx, variable: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) throw new UsageError("--fund-from takes the name of an environment variable, such as ZKAUTH_FUNDER_MNEMONIC");
  const value = ctx.env[variable];
  if (!value) throw new CliError(`${variable} is unset or empty; set it to the funding account's mnemonic`);
  return signerFromMnemonic(value);
}

/** Tops each role up to what it needs from the funder, checking first that the funder can cover all of it. */
async function fundRoles(ctx: Ctx, funder: Signer, needs: [string, string, bigint][]) {
  const { service } = ctx;
  const algorand = AlgorandClient.fromConfig({ algodConfig: { server: service.algodUrl, token: service.algodToken } });
  const sends: [string, string, bigint][] = [];
  for (const [role, address, need] of needs) {
    const spendable = await spendableOf(algorand, address);
    if (spendable >= need) ctx.print(`  ${role} has ${algo(spendable)} spendable`);
    else sends.push([role, address, need - spendable]);
  }
  if (!sends.length) return;
  const total = sends.reduce((sum, [, , amount]) => sum + amount + FEE, 0n);
  const available = await spendableOf(algorand, funder.addr);
  if (available < total)
    throw new CliError(`The funder ${funder.addr} has ${algo(available)} spendable and needs ${algo(total)}; fund it${service.network === "testnet" ? ` (${DISPENSER})` : ""} and rerun`);
  for (const [role, address, amount] of sends) {
    await algorand.send.payment({ sender: funder.addr, signer: funder.signer as never, receiver: address, amount: microAlgos(amount), note: `zkauth init: fund ${role}` });
    ctx.print(`  funded ${role} with ${algo(amount)} from ${funder.addr}`);
  }
}

const spendable = async (algodUrl: string, address: string): Promise<bigint> => {
  const response = await fetch(`${algodUrl.replace(/\/$/, "")}/v2/accounts/${address}?exclude=all`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new CliError(`TestNet node returned HTTP ${response.status}`);
  const account = await response.json() as { amount: number | string; "min-balance"?: number | string };
  return BigInt(account.amount) - BigInt(account["min-balance"] ?? 0);
};

export async function init(ctx: Ctx, args: string[]): Promise<number> {
  const { values } = parse(args, { wait: { type: "boolean" }, "fund-from": { type: "string" }, "dry-run": { type: "boolean" }, help: { type: "boolean" } });
  const { service, env } = ctx;
  const dry = values["dry-run"] === true;
  const funder = values["fund-from"] !== undefined ? funderFrom(ctx, values["fund-from"]) : undefined;
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
  // A role account paying itself would leave the roles unfunded and mix the funder's keys into them.
  if (funder && Object.values(addresses).includes(funder.addr))
    throw new CliError(`--fund-from ${values["fund-from"]} names the admin, sponsor or guardian account; the funder must be a separate account`);

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

  const needs: [string, string, bigint][] = [["admin", addresses.admin!, TESTNET_NEED.admin], ["sponsor", addresses.sponsor!, TESTNET_NEED.sponsor], ["guardian", addresses.guardian!, GUARDIAN_NEED]];
  if (dry) {
    if (funder) ctx.print(`Would top up from ${funder.addr}: ${needs.map(([role, , need]) => `${role} to ${algo(need)}`).join(", ")} spendable.`);
    return 0;
  }
  if (funder) {
    ctx.print(`Funding from ${funder.addr}:`);
    await fundRoles(ctx, funder, needs);
    return 0;
  }
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
