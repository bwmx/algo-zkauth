import { generateWalletSalt, generateRecoverySecret, createRecoveryPackage, restoreRecoveryPackage, parsePackage, toBase64Url, MAX_PACKAGE_BYTES } from "./recovery.mjs";
import { enrollPasskey, unlockPasskey } from "./passkey-prf.mjs";
const $ = id => document.getElementById(id);
const status = (text, kind = "") => { $("status").textContent = text; $("status").className = kind; };
let config, identity, salt, secret, packageText, imported, passkey, downloaded = false;
let busy = false;
const binding = () => ({ stage: "pre-enrollment", networkGenesisHash: config.genesisHash, registryAppId: "0", walletAppId: "0", walletAddress: null });
const update = () => {
  $("create").disabled = busy || !identity || !!salt;
  for (const id of ["add-passkey", "download"]) $(id).disabled = busy || !packageText;
  $("restore-secret-button").disabled = busy || !identity || !imported;
  $("restore-passkey-button").disabled = busy || !identity || !imported || !parsePackage(imported).slots.some(s => s.kind === "prf");
};
const action = callback => async () => {
  if (busy) return;
  busy = true; update();
  try { await callback(); } catch (error) { status(error.message || "Recovery operation failed", "error"); }
  finally { busy = false; update(); }
};
async function post(path, body) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Local verification failed");
  return result;
}
const record = outcome => post("/recovery/result", { outcome, userAgent: navigator.userAgent });
async function seal() {
  packageText = await createRecoveryPackage({ salt, identity, binding: binding(), recoverySecret: secret, passkeys: passkey ? [passkey] : [] });
  downloaded = false;
  $("setup-state").textContent = "Setup incomplete. Download this backup and import it below to verify restoration.";
  $("original-commitment").textContent = parsePackage(packageText).header.commitment;
}
$("create").onclick = action(async () => {
  salt = generateWalletSalt(); secret = await generateRecoverySecret();
  await seal(); $("backup").hidden = false; $("new-secret").value = secret;
  status("Test backup created. Save the secret separately, optionally add a passkey, then download and verify the backup.");
});
$("show-secret").onclick = () => { $("new-secret").type = $("new-secret").type === "password" ? "text" : "password"; };
$("copy-secret").onclick = action(async () => { await navigator.clipboard.writeText(secret); status("Secret copied. Save it privately and clear the clipboard when finished."); });
$("add-passkey").onclick = action(async () => {
  status("Approve passkey creation and then a second prompt to verify its PRF output…");
  let next;
  try { next = await enrollPasskey(); }
  catch (error) {
    const outcome = error.name === "PrfUnavailableError" ? "prf-unavailable" : "prf-cancelled";
    $("prf-state").textContent = error.message + " The recovery secret still works.";
    await record(outcome); throw error;
  }
  passkey?.output.fill(0); passkey = next;
  await seal();
  $("prf-state").textContent = "Passkey returned PRF material. Download the updated backup; a restore must still verify it.";
  await record("prf-ready");
  status("Passkey added. Download the updated backup and verify both the secret and passkey restore paths.");
});
$("download").onclick = action(async () => {
  const url = URL.createObjectURL(new Blob([packageText + "\n"], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = `zklogin-recovery-${parsePackage(packageText).header.packageId}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000); downloaded = true;
  status("Backup download started. Confirm it is saved, then select that file below and restore using your saved secret.");
});
$("import").onchange = action(async () => {
  imported = undefined; $("restored-commitment").hidden = true;
  const file = $("import").files[0];
  if (!file) return;
  if (file.size > MAX_PACKAGE_BYTES) throw new Error("Recovery package is too large");
  const text = await file.text(); const p = parsePackage(text);
  if (JSON.stringify(p.header.binding) !== JSON.stringify(binding())) throw new Error("This page accepts only pre-enrollment TestNet recovery tests. Existing wallet backups require chain-verified wallet discovery.");
  imported = text;
  $("restore-detail").textContent = `Backup selected. ${p.slots.length - 1} optional passkey slot(s). Choose a restore method.`;
  status("Backup parsed. Authentication and identity matching will run on restore.");
});
async function restore(usePasskey) {
  let key;
  try {
    if (usePasskey) {
      const slot = parsePackage(imported).slots.find(s => s.kind === "prf" && s.rpId === location.hostname);
      if (!slot) throw new Error("No passkey for this hostname; use the recovery secret");
      status("Approve the original passkey to unlock the backup…"); key = await unlockPasskey(slot);
    }
    const recovered = await restoreRecoveryPackage({ packageText: imported, identity, expectedBinding: binding(), ...(usePasskey ? { passkey: key } : { recoverySecret: $("restore-secret").value.trim() }) });
    try {
      const sameOriginal = salt && toBase64Url(salt) === toBase64Url(recovered.salt);
      if (salt && !sameOriginal) throw new Error("The imported backup is not this tab's test identity");
      $("restored-commitment").textContent = toBase64Url(recovered.commitment); $("restored-commitment").hidden = false;
      if (!usePasskey && sameOriginal && downloaded && $("secret-saved").checked && imported.trimEnd() === packageText) {
        $("setup-state").textContent = "Setup verified: the exported backup and saved secret restored the original salt.";
        await record("setup-verified");
      }
      await record(usePasskey ? "restore-passkey" : "restore-secret");
      $("restore-secret").value = "";
      status(`Restored the original identity commitment using ${usePasskey ? "the passkey" : "the recovery secret"}. The verified Google identity matched. Browser recovery evidence was saved. This test has no enrolled wallet or transfer.`, "success");
    } finally { recovered.salt.fill(0); }
  } finally { key?.output.fill(0); }
}
$("restore-secret-button").onclick = action(() => restore(false));
$("restore-passkey-button").onclick = action(() => restore(true));
addEventListener("pagehide", () => { salt?.fill(0); passkey?.output.fill(0); secret = undefined; identity = undefined; });
try {
  const response = await fetch("/recovery/config", { cache: "no-store" });
  if (!response.ok) throw new Error("Local recovery configuration unavailable");
  config = await response.json();
  await new Promise((resolve, reject) => {
    const s = document.createElement("script"); s.src = "https://accounts.google.com/gsi/client"; s.async = true;
    s.onload = resolve; s.onerror = () => reject(new Error("Google sign-in did not load")); document.head.append(s);
  });
  google.accounts.id.initialize({ client_id: config.clientId, nonce: config.nonce, auto_select: false, callback: async ({ credential }) => {
    try {
      const result = await post("/recovery/identity", { token: credential, challengeId: config.challengeId });
      identity = result.identity;
      $("login-state").textContent = "Google identity verified for this tab. You can create or restore a backup.";
      $("google-button").hidden = true; update(); status("Signed in. Create a new test backup here, or import your existing test backup.");
    } catch (error) { status(error.message, "error"); }
  } });
  google.accounts.id.renderButton($("google-button"), { theme: "outline", size: "large", text: "signin_with" });
  $("login-state").textContent = "Sign in to begin. If the page has been idle for ten minutes, reload first.";
} catch (error) { status(error.message, "error"); }
update();
