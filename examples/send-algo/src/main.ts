// The smallest AlgoZKAuth dApp. Everything chain-related is four SDK calls:
// signIn, backup.create, wallet().enroll and wallet.sendAlgo; a fifth,
// session.createSignIn, signs in to the dApp's own backend (./backend.ts).
import { createZkAuth, algo, downloadBackup, formatAlgo, type Session, type Wallet } from "@algozkauth/sdk";
import { signInToBackend } from "./backend.ts";

const zk = createZkAuth({
  service: import.meta.env.VITE_ZKAUTH_SERVICE ?? "http://localhost:8780",
  app: import.meta.env.VITE_ZKAUTH_APP ?? "example",
});
void zk.config(); // so the login window can open inside the click

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const log = (line: string) => { $("log").textContent = `${line}\n${$("log").textContent}`; };
let session: Session;
let wallet: Wallet;

$("go").onclick = async () => {
  try {
    session = await zk.signIn();
    log(`Signed in as ${session.identity.subject}`);
    const backup = await session.backup.create();     // a real dApp would also offer restore
    downloadBackup(backup);
    log(`Backup downloaded. Recovery secret (keep it apart from the file): ${backup.secret}`);
    wallet = await session.wallet();
    await wallet.enroll();                              // the service sponsor pays the deposit and fees
    $("wallet").textContent = `Wallet ${wallet.address}. Fund it, then send.`;
    $("send").hidden = false;
    $("backend").hidden = false;
  } catch (e) { log(`Error: ${(e as Error).message}`); }
};

$("backend").onclick = async () => {
  try {
    const me = await signInToBackend((o) => session.createSignIn(o));
    $("backend-user").textContent = `The backend signed you in as ${me.address}.`;
  } catch (e) { log(`Error: ${(e as Error).message}`); }
};

$("send").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const { txId } = await wallet.sendAlgo({ to: $<HTMLInputElement>("to").value.trim(), amount: algo("0.1") });
    log(`Sent 0.1 ALGO: ${txId}. Balance ${formatAlgo((await wallet.balance()).microAlgos, { trim: true })}`);
  } catch (e) { log(`Error: ${(e as Error).message}`); }
};
