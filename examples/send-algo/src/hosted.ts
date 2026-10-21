// The hosted alternative to main.ts: the dApp holds no login, salt or key. Two calls:
// connectWallet (inside a click) and wallet.sendAlgo, which the user approves in the wallet window.
import { connectWallet, algo, type HostedWallet } from "@algozkauth/sdk";

const walletOrigin = import.meta.env.VITE_ZKAUTH_WALLET ?? "http://localhost:8770";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const log = (line: string) => { $("log").textContent = `${line}\n${$("log").textContent}`; };
let wallet: HostedWallet;

$("connect").onclick = () => {
  connectWallet({ walletOrigin }).then((w) => {
    wallet = w;
    $("wallet").textContent = `Wallet ${w.address}.`;
    $("send").hidden = false;
  }, (e) => log(`Error: ${(e as Error).message}`));
};

$("send").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const { txId } = await wallet.sendAlgo({ to: $<HTMLInputElement>("to").value.trim(), amount: algo("0.1") });
    log(`Sent 0.1 ALGO: ${txId}`);
  } catch (e) { log(`Error: ${(e as Error).message}`); }
};
