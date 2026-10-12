// Own frontend module under Node/VM. Google, DOM, prover and RPC are stubs;
// these tests never launch a browser and cannot establish TestNet acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";
import {createPublicKey,verify,randomBytes,createHash} from "node:crypto";
import * as sdk from "../upstream/snarkjs-algorand/node_modules/algosdk/dist/esm/index.js";
import * as recovery from "../src/phase5/recovery.mjs";
import * as passkeys from "../src/phase5/passkey-prf.mjs";
import * as actions from "../src/phase6/action.mjs";
import {actionDigest} from "../src/phase4/action.mjs";
const source=readFileSync(new URL("../web/phase6-demo/client.mjs",import.meta.url),"utf8").replace(/^import .*;\n/gm,"");
async function page({changePlan=false,provider="google"}={}) {
  const elements=new Map(), requests=[], opened=[];let callback,downloaded,context,proof,commitment;
  const element=id=>{if(!elements.has(id))elements.set(id,{value:"",textContent:"",hidden:false,disabled:false,checked:false,files:[],children:[],append(child){this.children.push(child);}});return elements.get(id);};
  const clientId=provider==="slack"?"1234567890.9876543210":"test.apps.googleusercontent.com";
  const config={network:"testnet-v1.0",provider,providers:["google","slack"],genesisHash:randomBytes(32).toString("base64url"),audienceHash:createHash("sha256").update(clientId).digest("base64url"),registryId:"12",demoAssetId:"90",sponsor:sdk.generateAccount().addr.toString(),enrollmentDeposit:"454800",groupFeeMicroAlgos:"20000",clientId};
  const identity=provider==="slack"?{issuer:"https://slack.com",audience:clientId,subject:"T0123ABC456/U0123ABCDEF"}:{issuer:"https://accounts.google.com",audience:clientId,subject:"123456789012345678901"};
  let wallet={walletId:"0",address:null,nonce:"0",balanceMicroAlgos:"0",minBalanceMicroAlgos:"0",assets:[],enrolled:false};
  const copy=()=>structuredClone(wallet);const plans=new Map();let planCount=0;
  class TestURL extends URL {static createObjectURL(blob){downloaded=blob;return "blob:test";}static revokeObjectURL(){}}
  const fetch=async(url,options)=>{
    const body=options?.body?JSON.parse(options.body):undefined;requests.push({url,body});let value;
    if(url===`/demo/config?provider=${provider}`)value=config;
    else if(url==="/demo/login-start"){assert.equal(body.provider,provider);context={...body,sessionId:"session",nonce:"stub",expiresAt:Math.floor(Date.now()/1000)+600,...(provider==="slack"?{authorizeUrl:"https://slack.com/openid/connect/authorize?stub"}:{})};value=context;}
    else if(url==="/demo/login"&&provider==="google")value={identity,accountCase:"A",expiresAt:context.expiresAt};
    else if(url==="/demo/login-status"&&provider==="slack")value=opened.length?{verified:true,identity,accountCase:"A",expiresAt:context.expiresAt}:{verified:false};
    else if(url==="/demo/discover"){commitment=recovery.toBase64Url(await recovery.recoveryCommitment(identity,recovery.fromBase64Url(body.salt,32)));value={wallet:copy(),commitment};}
    else if(url==="/demo/proof"){
      assert.equal(body.backupVerified,true);
      const limbs=b=>[b.subarray(0,16),b.subarray(16)].map(v=>BigInt("0x"+Buffer.from(v).toString("hex")).toString());
      proof={publicSignals:[...limbs(Buffer.from(commitment,"base64url")),...limbs(randomBytes(32)),...limbs(Buffer.from(config.audienceHash,"base64url")),...limbs(Buffer.from(context.sessionPublicKey,"base64url")),...limbs(Buffer.from(config.genesisHash,"base64url")),String(context.expiresAt),String(context.expiresAt-660)],ready:true,stage:"ready",elapsedMs:1,measurement:{elapsedMs:1,peakRssBytes:1000}};value={jobId:"job"};
    } else if(url.startsWith("/demo/proof/"))value=proof;
    else if(url==="/demo/prepare"){
      const p={planId:String(planCount++),genesisHash:config.genesisHash,registryId:config.registryId,walletId:body.operation==="0"?"0":wallet.walletId,owner:commitment,operation:body.operation,recipient:body.recipient,recipientPublicKey:Buffer.from(sdk.decodeAddress(body.recipient).publicKey).toString("base64url"),assetId:body.assetId,amount:body.amount,nonce:body.operation==="0"?"0":wallet.nonce,sessionExpiresAt:String(context.expiresAt)};
      plans.set(p.planId,p);value=changePlan?{...p,amount:"9999"}:p;
    } else if(url==="/demo/submit"){
      const p=plans.get(body.planId);
      const digest=actionDigest({...p,genesisHash:Buffer.from(p.genesisHash,"base64url"),owner:Buffer.from(p.owner,"base64url"),recipient:sdk.decodeAddress(p.recipient).publicKey});
      const key=createPublicKey({key:{kty:"OKP",crv:"Ed25519",x:context.sessionPublicKey},format:"jwk"});
      assert.equal(verify(null,digest,key,Buffer.from(body.signature,"base64url")),true);
      if(p.operation==="0")wallet={...wallet,enrolled:true,walletId:"34",address:sdk.getApplicationAddress(34n).toString(),balanceMicroAlgos:"100000",minBalanceMicroAlgos:"100000"};
      else {assert.equal(p.nonce,wallet.nonce);wallet.nonce=String(BigInt(wallet.nonce)+1n);if(p.operation==="1")wallet.balanceMicroAlgos=String(BigInt(wallet.balanceMicroAlgos)-BigInt(p.amount));if(p.operation==="2"){wallet.assets=[{id:config.demoAssetId,amount:"0"}];wallet.minBalanceMicroAlgos="200000";}if(p.operation==="3")wallet.assets[0].amount=String(BigInt(wallet.assets[0].amount)-BigInt(p.amount));}
      value={wallet:copy(),measurement:{confirmedRound:"100",groupFeeMicroAlgos:"20000",transactionIds:["stub-tx"]}};
    } else if(url==="/demo/fund"){wallet.balanceMicroAlgos="1100000";value={wallet:copy()};}
    else if(url==="/demo/seed"){wallet.assets[0].amount="100";value={wallet:copy()};}
    else if(url==="/demo/replay")value={replayRejectedByNode:true,noncePreserved:true};
    else if(url==="/demo/isolation")value={available:false};
    else throw Error("Unexpected stub request");
    return {ok:true,json:async()=>value};
  };
  const google=provider==="google"?{accounts:{id:{initialize(options){callback=options.callback;},renderButton(){}}}}:undefined;
  const window={open(url){opened.push(url);return {};}};
  const sandbox=vm.createContext({...recovery,...passkeys,...actions,crypto,Uint8Array,TextEncoder,TextDecoder,Blob,URL:TestURL,URLSearchParams,Date,algosdk:sdk,fetch,window,navigator:{userAgent:"Node VM protocol test"},location:{hostname:"localhost",search:provider==="slack"?"?provider=slack":""},setInterval:()=>0,clearInterval(){},setTimeout:(callback)=>{queueMicrotask(callback);return 0;},addEventListener(){},document:{getElementById:element,head:{append(s){queueMicrotask(()=>s.onload());}},createElement:tag=>tag==="a"?{click(){}}:{}},google});
  await vm.runInContext(`(async()=>{${source}\n})()`,sandbox);
  if(provider==="google")assert.equal(typeof callback,"function",element("status").textContent);
  else assert.equal(element("login-button").children.length,1,element("status").textContent);
  const login=provider==="google"?()=>callback({credential:"stub-token"}):()=>element("login-button").children[0].onclick();
  return {element,requests,opened,login,click:id=>element(id).onclick(),downloaded:()=>downloaded.text(),import:async text=>{element("import").files=[{size:Buffer.byteLength(text),text:async()=>text}];await element("import").onchange();},wallet:copy};
}
test("full page flow enforces the backup gate and signs every enrollment/ALGO/ASA action with the browser key",async()=>{
  const p=await page();await p.login();await p.click("create");
  await p.click("run-demo");assert.equal(p.requests.some(r=>r.url==="/demo/submit"),false);
  await p.click("download");const text=await p.downloaded();await p.import(text);p.element("secret-saved").checked=true;p.element("restore-secret").value=p.element("new-secret").value;await p.click("restore-secret-button");
  assert.equal(p.element("prove").disabled,false,p.element("status").textContent);
  await p.click("prove");assert.equal(p.element("run-demo").disabled,false,p.element("status").textContent);
  await p.click("run-demo");assert.match(p.element("status").textContent,/demo passed/);
  assert.deepEqual(p.requests.filter(r=>r.url==="/demo/prepare").map(r=>r.body.operation),["0","1","2","3"]);
  assert.equal(p.wallet().nonce,"3");assert.equal(p.wallet().assets[0].amount,"93");
});
test("a changed server plan is rejected before the browser sends any action signature",async()=>{
  const p=await page({changePlan:true});await p.login();await p.click("create");await p.click("download");await p.import(await p.downloaded());p.element("secret-saved").checked=true;p.element("restore-secret").value=p.element("new-secret").value;await p.click("restore-secret-button");await p.click("prove");await p.click("run-demo");
  assert.match(p.element("status").textContent,/changed amount/);assert.equal(p.requests.some(r=>r.url==="/demo/submit"),false);
});
test("disabled proof generation explains the exact missing backup step",async()=>{
  const p=await page();
  assert.match(p.element("proof-next-step").textContent,/Sign in with Google/);
  await p.login();assert.match(p.element("proof-next-step").textContent,/create a recovery backup/);
  await p.click("create");assert.equal(p.element("prove").disabled,true);assert.match(p.element("proof-next-step").textContent,/Download encrypted backup/);
  await p.click("download");assert.match(p.element("proof-next-step").textContent,/tick the box/);
  p.element("secret-saved").checked=true;
  await p.import(await p.downloaded());assert.match(p.element("proof-next-step").textContent,/click Restore using secret/);
  await p.click("restore-secret-button");assert.equal(p.element("prove").disabled,true);assert.match(p.element("proof-next-step").textContent,/click Restore using secret/);
  p.element("restore-secret").value=p.element("new-secret").value;
  await p.click("restore-secret-button");assert.equal(p.element("prove").disabled,false,p.element("status").textContent);assert.match(p.element("proof-next-step").textContent,/Backup verified.*Generate local proof/);
  await p.click("prove");assert.match(p.element("proof-next-step").textContent,/Proof ready.*Run ALGO/);
});
test("a Slack tab signs in through the login window and runs the same wallet flow",async()=>{
  const p=await page({provider:"slack"});
  assert.match(p.element("proof-next-step").textContent,/Sign in with Slack/);
  assert.equal(p.element("provider-name").textContent,"Slack");
  await p.login();assert.deepEqual(p.opened,["https://slack.com/openid/connect/authorize?stub"]);
  assert.equal(p.requests.some(r=>r.url==="/demo/login"),false);
  assert.match(p.element("login-state").textContent,/Account A verified/);
  await p.click("create");await p.click("download");await p.import(await p.downloaded());p.element("secret-saved").checked=true;p.element("restore-secret").value=p.element("new-secret").value;await p.click("restore-secret-button");
  await p.click("prove");await p.click("run-demo");assert.match(p.element("status").textContent,/demo passed/);
  assert.deepEqual(p.requests.filter(r=>r.url==="/demo/prepare").map(r=>r.body.operation),["0","1","2","3"]);
});
