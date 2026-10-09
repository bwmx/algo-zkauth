// Disposable TestNet policy tests. Never changes the demo wallet key registry.
import { AlgorandClient, microAlgos } from "@algorandfoundation/algokit-utils";
import { GoogleKeyRegistryFactory, APP_SPEC } from "../../contracts/clients/GoogleKeyRegistry";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
export async function checkDemoPolicy(root: string, mnemonic: string, jwks: any) {
  const algorand = AlgorandClient.testNet(); const payer = algorand.account.fromMnemonic(mnemonic);
  if ((await algorand.client.algod.getTransactionParams().do()).genesisID !== "testnet-v1.0") throw new Error("Policy acceptance requires TestNet");
  const fingerprints = jwks.keys.filter((k: any) => k.kty === "RSA" && k.e === "AQAB" && k.alg === "RS256" && Buffer.from(k.n,"base64url").length === 256).map((k: any) => createHash("sha256").update(Buffer.from(k.n,"base64url")).digest());
  if (fingerprints.length < 2) throw new Error("Two current Google keys are required for the overlap check");
  const time = async () => { const s=await algorand.client.algod.status().do();return (await algorand.client.algod.block(s.lastRound).do()).block.header.timestamp; };
  const {appClient:keys}=await new GoogleKeyRegistryFactory({algorand,defaultSender:payer}).send.create.createApplication({args:{}});
  await algorand.send.payment({sender:payer,receiver:keys.appAddress,amount:microAlgos(200_000)});
  const box=(hash:Uint8Array)=>Buffer.concat([Buffer.from("gk:"),hash]);const start=await time();const checks: any[]=[];
  for(const keyHash of fingerprints.slice(0,2))await keys.send.registerKey({args:{keyHash,validFrom:start-60n,validUntil:start+86400n},boxReferences:[box(keyHash)]});
  const valid=async(keyHash:Uint8Array)=>(await keys.send.isKeyValid({args:{keyHash},boxReferences:[box(keyHash)]})).return;
  if(!(await valid(fingerprints[0]))||!(await valid(fingerprints[1])))throw new Error("Google key overlap failed");
  checks.push({check:"two authenticated current Google fingerprints overlap",passed:true});
  const reject=async(name:string,group:any,errorMessage:string)=>{
    const signed=await(await(await group.composer()).build()).atc.gatherSignatures();
    try{await algorand.client.algod.sendRawTransaction(signed).do();}
    catch(error:any){
      const pcs=APP_SPEC.sourceInfo?.approval.sourceInfo.filter(s=>s.errorMessage===errorMessage).flatMap(s=>s.pc)??[];
      if(!String(error.message).includes(errorMessage)&&!pcs.some(pc=>new RegExp(`pc[= :]+${pc}(?:\\D|$)`).test(String(error.message))))throw new Error(`Unclassified policy rejection: ${name}`);
      checks.push({check:name,passed:true,nodeRejected:true,mappedAssertion:errorMessage});return;
    }
    throw new Error(`Unexpected policy acceptance: ${name}`);
  };
  const window=async(keyHash:Uint8Array,expiresAt:bigint,notBefore:bigint)=>keys.newGroup().assertAuthorizationWindow({args:{keyHash,sessionExpiresAt:expiresAt,notBefore},boxReferences:[box(keyHash)]});
  let now=await time();
  await keys.send.assertAuthorizationWindow({args:{keyHash:fingerprints[1],sessionExpiresAt:now+300n,notBefore:now-60n},boxReferences:[box(fingerprints[1])]});
  checks.push({check:"bounded active authorization window accepted",passed:true});
  now=await time();await reject("expired authorization rejected",await window(fingerprints[1],now-1n,now-60n),"Session expired");
  await reject("authorization above ten minutes rejected",await window(fingerprints[1],now+3600n,now-60n),"Session exceeds maximum duration");
  await reject("future not-before rejected",await window(fingerprints[1],now+300n,now+600n),"Session not yet active");
  await keys.send.setPaused({args:{paused:true}});now=await time();
  await reject("emergency pause rejects current key",await window(fingerprints[1],now+300n,now-60n),"Google key inactive");
  await keys.send.setPaused({args:{paused:false}});
  await keys.send.retireKey({args:{keyHash:fingerprints[0],validUntil:await time()},boxReferences:[box(fingerprints[0])]});
  if(await valid(fingerprints[0])||!(await valid(fingerprints[1])))throw new Error("Retirement did not preserve replacement key");
  checks.push({check:"retiring one key preserves the overlapping key",passed:true});
  await keys.send.revokeKey({args:{keyHash:fingerprints[1]},boxReferences:[box(fingerprints[1])]});now=await time();
  await reject("revoked key rejects authorization",await window(fingerprints[1],now+300n,now-60n),"Google key inactive");
  await reject("revoked fingerprint cannot be re-registered",keys.newGroup().registerKey({args:{keyHash:fingerprints[1],validFrom:start-60n,validUntil:start+86400n},boxReferences:[box(fingerprints[1])]}),"Key already registered");
  const result={recordedAt:new Date().toISOString(),network:"testnet-v1.0",policyRegistryId:String(keys.appId),scope:"disposable policy registry / authenticated current Google public keys; no wallet or proof mutation",actualGoogleRotationTriggered:false,mainDemoRegistryUnchanged:true,checks};
  writeFileSync(`${root}benchmarks/phase6-policy.testnet.json`,JSON.stringify(result,null,2)+"\n");return{passed:true,checks:checks.length,policyRegistryId:result.policyRegistryId};
}
