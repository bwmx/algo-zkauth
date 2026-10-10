import { generateWalletSalt, generateRecoverySecret, createRecoveryPackage, restoreRecoveryPackage, recoveryCommitment, parsePackage, toBase64Url, fromBase64Url, MAX_PACKAGE_BYTES } from "/modules/phase5/recovery.mjs";
import { enrollPasskey, unlockPasskey } from "/modules/phase5/passkey-prf.mjs";
import { browserActionDigest, validateActionPlan } from "/modules/phase6/action.mjs";
const $ = id => document.getElementById(id);
const status = (text, kind = "") => { $("status").textContent = text; $("status").className = kind; };
let config, session, identity, keyPair, salt, secret, passkey, packageText, imported, wallet, commitment, proofReady = false, backupVerified = false, downloaded = false, busy = false, lastExecution = false;
const activity = [];
const log = text => { activity.push(text); $("activity").textContent = activity.join("\n"); };
const pendingBinding = () => ({ stage: "pre-enrollment", networkGenesisHash: config.genesisHash, registryAppId: "0", walletAppId: "0", walletAddress: null });
const currentBinding = () => wallet?.enrolled ? { stage: "wallet", networkGenesisHash: config.genesisHash, registryAppId: config.registryId, walletAppId: wallet.walletId, walletAddress: wallet.address } : pendingBinding();
const active = () => session && session.expiresAt > Math.floor(Date.now() / 1000);
const update = () => {
  const auth = !!identity && active(); const ready = auth && proofReady && backupVerified && !busy;
  $("renew").disabled = busy || !config;
  $("create").disabled = busy || !auth || !!salt;
  $("download").disabled = busy || !packageText;
  $("add-passkey").disabled = busy || !packageText || !secret;
  $("restore-secret-button").disabled = busy || !auth || !imported;
  $("restore-passkey-button").disabled = busy || !auth || !imported || !parsePackage(imported).slots.some(s => s.kind === "prf");
  $("prove").disabled = busy || !auth || !salt || !backupVerified;
  $("refresh").disabled = busy || !auth || !salt;
  $("enroll").disabled = !ready || !!wallet?.enrolled;
  $("run-demo").disabled = !ready;
  for (const id of ["fund", "opt-in", "seed", "transfer"]) $(id).disabled = !ready || !wallet?.enrolled;
  $("replay").disabled = !ready || !lastExecution;
  let nextStep, nextLink = "#step-backup", linkLabel = "Go to step 2";
  if (busy) { nextStep = "An action is running. Wait for it to finish; proof progress appears below."; nextLink = undefined; }
  else if (!identity) { nextStep = "First complete Sign in with Google in step 1."; nextLink = "#step-login"; linkLabel = "Go to step 1"; }
  else if (!active()) { nextStep = "Your Google session expired. Click Renew Google session in step 1 and sign in to the same account. Your backup and selected salt stay in this tab."; nextLink = "#step-login"; linkLabel = "Renew in step 1"; }
  else if (!salt) nextStep = "Complete step 2: create a recovery backup, or import an existing backup and restore it using its saved secret.";
  else if (!backupVerified && !packageText) { nextStep = "Backup creation or discovery did not finish. Check the error message above. Preserve any saved backup and secret before reloading."; nextLink = undefined; }
  else if (!backupVerified && !downloaded) nextStep = "Step 2: save the recovery secret separately and click Download encrypted backup. Then import that downloaded file and restore it using the secret.";
  else if (!backupVerified && !$("secret-saved").checked) nextStep = "Step 2: tick the box confirming you saved the secret separately. Then import the downloaded backup, enter its saved secret, and click Restore using secret.";
  else if (!backupVerified && !imported) nextStep = "Step 2: select the downloaded file under Import encrypted backup, enter its saved secret, and click Restore using secret.";
  else if (!backupVerified) nextStep = "Step 2: enter the saved recovery secret and click Restore using secret. Selecting the file alone does not verify the backup.";
  else if (!proofReady) { nextStep = "Backup verified. Click Generate local proof below. After it finishes, click Run ALGO / ASA demo in step 4."; nextLink = undefined; }
  else { nextStep = "Proof ready. Click Run ALGO / ASA demo in step 4."; nextLink = "#step-transfer"; linkLabel = "Go to step 4"; }
  $("proof-next-step").textContent = nextStep;
  $("proof-next-link").hidden = !nextLink;
  if (nextLink) { $("proof-next-link").href = nextLink; $("proof-next-link").textContent = linkLabel; }
};
const action = callback => async () => {
  if (busy) return; busy = true; update();
  try { await callback(); } catch (error) { status(error.message || "Demo action failed", "error"); }
  finally { busy = false; update(); }
};
const post = async (path, data) => {
  const r = await fetch(`/demo/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: session?.sessionId, ...data }) });
  const value = await r.json(); if (!r.ok) throw new Error(value.error || "Local demo request failed"); return value;
};
const algo = value => `${(BigInt(value) / 1000000n)}.${(BigInt(value) % 1000000n).toString().padStart(6,"0")} ALGO`;
function showWallet(value) {
  wallet = value;
  if (wallet.enrolled && algosdk.getApplicationAddress(BigInt(wallet.walletId)).toString() !== wallet.address) throw new Error("Wallet address does not match its application ID");
  $("wallet-id").textContent = wallet.enrolled ? wallet.walletId : "Not enrolled";
  $("address").textContent = wallet.address || "—";
  $("balance").textContent = wallet.enrolled ? `${algo(wallet.balanceMicroAlgos)} / ${algo(wallet.minBalanceMicroAlgos)}` : "—";
  $("nonce").textContent = wallet.nonce;
  $("asset-balance").textContent = wallet.assets.find(a => a.id === config.demoAssetId)?.amount || "0 (or not opted in)";
}
async function discover(restored = false) {
  const result = await post("discover", { salt: toBase64Url(salt), restored });
  if (result.commitment !== commitment) throw new Error("Server identity commitment differs from the browser");
  showWallet(result.wallet); return wallet;
}
async function seal() {
  packageText = await createRecoveryPackage({ salt, identity, binding: currentBinding(), recoverySecret: secret, passkeys: passkey ? [passkey] : [] });
  $("backup").hidden = false; $("new-secret").value = secret; downloaded = false;
  $("backup-state").textContent = "Download this package and import/restore it with the separately saved secret to verify the export.";
}
async function login() {
  const pendingKey = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pendingKey.publicKey));
  const pending = await post("login-start", { sessionPublicKey: toBase64Url(publicKey), randomness: toBase64Url(crypto.getRandomValues(new Uint8Array(32))) });
  $("google-button").hidden = false; $("google-button").textContent = "";
  google.accounts.id.initialize({ client_id: config.clientId, nonce: pending.nonce, auto_select: false, callback: async ({ credential }) => {
    try {
      const result = await post("login", { sessionId: pending.sessionId, token: credential, userAgent: navigator.userAgent });
      if (identity && JSON.stringify(identity) !== JSON.stringify(result.identity)) throw new Error("Renew using the original Google account. Open a separate tab for a different account.");
      identity = result.identity; keyPair = pendingKey; session = pending; proofReady = false; lastExecution = false;
      $("google-button").hidden = true; $("login-state").textContent = `Account ${result.accountCase} verified. Session signing key stays in this tab.`;
      $("proof-state").textContent = "Fresh login ready. Generate a new proof for this session.";
      if (salt) await discover();
      status(salt ? "Session renewed. The original salt is preserved; generate a fresh proof." : "Google identity verified. Create and verify a backup, or restore an existing backup.");
      log(`Account ${result.accountCase}: fresh Google login verified.`); update();
    } catch (error) { status(error.message, "error"); }
  } });
  google.accounts.id.renderButton($("google-button"), { theme: "outline", size: "large", text: "signin_with" });
  $("login-state").textContent = "Choose the Google account for this tab. Login expires in ten minutes.";
}
$("renew").onclick = action(async () => { await login(); status("Choose the original account to renew this tab's session."); });
$("create").onclick = action(async () => {
  salt = generateWalletSalt(); secret = await generateRecoverySecret();
  commitment = toBase64Url(await recoveryCommitment(identity, salt)); $("commitment").textContent = commitment;
  await discover(); await seal(); backupVerified = false;
  status("Backup created. Save its secret separately, download the encrypted file, and import/restore that file below.");
});
$("show-secret").onclick = () => { $("new-secret").type = $("new-secret").type === "password" ? "text" : "password"; };
$("copy-secret").onclick = action(async () => { await navigator.clipboard.writeText(secret); status("Secret copied. Save it privately, then clear the clipboard."); });
$("add-passkey").onclick = action(async () => {
  status("Approve passkey creation and then its PRF verification prompt…");
  const p = await enrollPasskey(); passkey?.output.fill(0); passkey = p; await seal(); backupVerified = false;
  status("Passkey added. Download and verify the updated package. The recovery secret remains the fallback.");
});
$("download").onclick = action(async () => {
  const url = URL.createObjectURL(new Blob([packageText + "\n"], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = `algo-zkauth-${parsePackage(packageText).header.packageId}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); downloaded = true;
  status("Backup download started. Import that exact file and restore with your saved secret to verify it.");
});
$("import").onchange = action(async () => {
  imported = undefined; const file = $("import").files[0]; if (!file) return;
  if (file.size > MAX_PACKAGE_BYTES) throw new Error("Recovery package is too large");
  const text = await file.text(); const p = parsePackage(text);
  if (p.header.binding.networkGenesisHash !== config.genesisHash || (p.header.binding.stage === "wallet" && p.header.binding.registryAppId !== config.registryId)) throw new Error("Backup belongs to a different network/registry. Use its original deployment.");
  imported = text; status("Package selected. Use its saved secret or original passkey to restore.");
});
async function restore(usePasskey) {
  const p = parsePackage(imported); let key;
  try {
    const binding = p.header.binding.stage === "wallet" ? await post("wallet-binding", { commitment: p.header.commitment }) : pendingBinding();
    if (usePasskey) { const slot = p.slots.find(s => s.kind === "prf" && s.rpId === location.hostname); if (!slot) throw new Error("No passkey for this hostname; use the secret"); key = await unlockPasskey(slot); }
    const recovered = await restoreRecoveryPackage({ packageText: imported, identity, expectedBinding: binding, ...(usePasskey ? { passkey: key } : { recoverySecret: $("restore-secret").value.trim() }) });
    if (salt && toBase64Url(salt) !== toBase64Url(recovered.salt)) { recovered.salt.fill(0); throw new Error("Imported backup differs from this tab's identity. Use a fresh tab to restore it."); }
    const verifyingNew = !!salt && packageText && imported.trimEnd() === packageText;
    if (verifyingNew && (!downloaded || !$("secret-saved").checked || usePasskey)) { recovered.salt.fill(0); throw new Error("Confirm separate secret storage and verify the downloaded file using the secret before enrollment."); }
    salt?.fill(0); salt = recovered.salt; commitment = toBase64Url(recovered.commitment); $("commitment").textContent = commitment;
    if (!usePasskey) secret = $("restore-secret").value.trim();
    backupVerified = true; await discover(true);
    if (!packageText) packageText = imported.trimEnd();
    if (secret) { $("new-secret").value = secret; $("backup").hidden = false; }
    $("backup-state").textContent = "Export/import restoration verified. Preserve the backup and separate secret.";
    $("restore-secret").value = "";
    status(wallet.enrolled ? "Original wallet discovered. Its owner, address and policy match. Generate a fresh proof to authorize transfers." : "Backup verified. Generate the proof, then enroll this identity.", "success");
  } finally { key?.output.fill(0); }
}
$("restore-secret-button").onclick = action(() => restore(false));
$("restore-passkey-button").onclick = action(() => restore(true));
$("refresh").onclick = action(async () => { await discover(); status("Wallet refreshed from TestNet."); });
$("prove").onclick = action(async () => {
  proofReady = false; status("Preparing the full JWT witness on this Mac…");
  const { jobId } = await post("proof", { salt: toBase64Url(salt), backupVerified });
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const r = await fetch(`/demo/proof/${jobId}`, { headers: { "X-Demo-Session": session.sessionId }, cache: "no-store" }); const result = await r.json();
    if (!r.ok) throw new Error(result.error || "Proof status unavailable");
    $("proof-state").textContent = `${result.stage} · ${(result.elapsedMs / 1000).toFixed(1)} seconds`;
    if (result.stage === "failed") throw new Error("The local proof worker failed. Check the local server status, then renew the session and retry.");
    if (result.ready) {
      const signals = result.publicSignals.map(BigInt);
      const digest = index => {
        const bytes = new Uint8Array(32);
        for (let i=0;i<2;i++) {
          let value = signals[index+i];
          if (value < 0n || value >= (1n<<128n)) throw new Error("Noncanonical proof digest limb");
          for (let j=15;j>=0;j--) { bytes[i*16+j]=Number(value&255n); value >>= 8n; }
        }
        return toBase64Url(bytes);
      };
      // Independently check the public bindings before any browser signing.
      if (digest(0) !== commitment || digest(4) !== config.audienceHash || digest(8) !== config.genesisHash || digest(6) !== toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey))) || String(signals[10]) !== String(session.expiresAt)) throw new Error("Proof public bindings differ from this browser session");
      proofReady = true; $("proof-state").textContent = `Verified full proof in ${(result.measurement.elapsedMs/1000).toFixed(1)} seconds. Peak Node RSS ${(result.measurement.peakRssBytes/1024/1024).toFixed(0)} MiB.`;
      await discover(); status("Proof verified. Run this account's ALGO / ASA demo, or use individual wallet actions.", "success"); log($("proof-state").textContent); return;
    }
    status(`Local proof: ${result.stage}. Keep this tab open; ${(result.elapsedMs/1000).toFixed(0)} seconds elapsed.`);
  }
});
async function execute(operation, recipient, assetId, amount) {
  if (!active() || !proofReady || !backupVerified) throw new Error("A verified backup and active proof are required");
  await discover();
  const expected = { walletId: operation === "0" ? "0" : wallet.walletId, operation, recipient, assetId, amount, nonce: operation === "0" ? "0" : wallet.nonce, owner: commitment, sessionExpiresAt: String(session.expiresAt) };
  const plan = validateActionPlan(await post("prepare", { operation, recipient, assetId, amount }), expected, config, algosdk.decodeAddress);
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", keyPair.privateKey, await browserActionDigest(plan)));
  status(`Submitting signed ${operation === "0" ? "enrollment" : "wallet action"} to TestNet…`);
  const result = await post("submit", { planId: plan.planId, signature: toBase64Url(signature) });
  showWallet(result.wallet); lastExecution = operation !== "0";
  log(`Confirmed ${["enrollment","ALGO transfer","ASA opt-in","ASA transfer"][Number(operation)]} in round ${result.measurement.confirmedRound}; fee ${algo(result.measurement.groupFeeMicroAlgos)}; tx ${result.measurement.transactionIds[0]}`);
  if (operation === "0" && secret) { await seal(); $("backup-state").textContent = "Wallet enrolled. Download and verify the updated wallet-bound backup. Your earlier verified salt backup also remains usable."; }
  return result;
}
$("enroll").onclick = action(async () => { await execute("0",config.sponsor,"0",config.enrollmentDeposit); status("Wallet enrolled. Download the updated backup before closing this tab.","success"); });
$("fund").onclick = action(async () => { showWallet((await post("fund",{})).wallet); status("One-time test funding is available.","success"); });
$("opt-in").onclick = action(async () => { await execute("2",wallet.address,config.demoAssetId,"0"); status("Demo ASA opt-in confirmed.","success"); });
$("seed").onclick = action(async () => { showWallet((await post("seed",{})).wallet); status("Demo ASA funding is available.","success"); });
$("transfer").onclick = action(async () => {
  const assetId = $("asset").value, amount = $("amount").value.trim(), recipient = $("recipient").value.trim();
  if (!/^[1-9][0-9]{0,19}$/.test(amount) || BigInt(amount)>0xffffffffffffffffn) throw new Error("Enter a positive whole amount in smallest units");
  await execute(assetId === "0" ? "1" : "3",recipient,assetId,amount); status("Transfer confirmed and wallet balance refreshed.","success");
});
async function checkReplay() {
  const result = await post("replay",{});
  if (!result.replayRejectedByNode || !result.noncePreserved) throw new Error("Replay rejection check did not pass");
  log("Node rejected replay at the wallet's nonce check; nonce unchanged."); return result;
}
$("replay").onclick = action(async () => { await checkReplay(); status("Replay rejected by TestNet. Wallet nonce is unchanged.","success"); });
$("run-demo").onclick = action(async () => {
  if (!wallet.enrolled) await execute("0",config.sponsor,"0",config.enrollmentDeposit);
  showWallet((await post("fund",{})).wallet);
  await execute("1",config.sponsor,"0","10000");
  if (!wallet.assets.some(a=>a.id===config.demoAssetId)) await execute("2",wallet.address,config.demoAssetId,"0");
  showWallet((await post("seed",{})).wallet);
  await execute("3",config.sponsor,config.demoAssetId,"7");
  await checkReplay();
  const isolation = await post("isolation",{});
  if (isolation.available) {
    if (!isolation.wrongOwnerRejectedByNode || !isolation.otherNonceAndBalancePreserved) throw new Error("Wallet isolation check did not pass");
    log(`TestNet rejected this identity at the other wallet's owner check; wallet ${isolation.otherWalletId} remained unchanged.`);
  }
  status("This account's TestNet demo passed: original wallet discovery, ALGO transfer, ASA opt-in/transfer and replay rejection. Download and retain your updated wallet-bound backup.","success");
});
const timer = setInterval(() => { $("session-time").textContent = session ? `Session ${active() ? "expires in " + Math.max(0,session.expiresAt-Math.floor(Date.now()/1000)) + " seconds" : "expired; renew login and generate a fresh proof"}.` : ""; update(); },1000);
addEventListener("pagehide", () => { clearInterval(timer); salt?.fill(0); passkey?.output.fill(0); secret = undefined; identity = undefined; keyPair = undefined; });
try {
  config = await (await fetch("/demo/config",{cache:"no-store"})).json();
  if (config.network !== "testnet-v1.0" || !config.registryId || !config.clientId) throw new Error("TestNet deployment configuration unavailable");
  $("registry").textContent = config.registryId; $("recipient").value = config.sponsor;
  const option = document.createElement("option"); option.value = config.demoAssetId; option.textContent = `Demo ASA ${config.demoAssetId}`; $("asset").append(option);
  $("costs").textContent = `Enrollment deposit ${algo(config.enrollmentDeposit)}; tested group fee ${algo(config.groupFeeMicroAlgos)} paid by the local sponsor. Funding: 1 test ALGO and 100 demo ASA units once per wallet.`;
  await new Promise((resolve,reject) => { const s = document.createElement("script"); s.src="https://accounts.google.com/gsi/client"; s.async=true; s.onload=resolve; s.onerror=()=>reject(new Error("Google sign-in library failed to load")); document.head.append(s); });
  await login(); status("Sign in to Google to prepare this account's wallet.");
} catch (error) { status(error.message,"error"); }
update();
