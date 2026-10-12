import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { DemoSessions } from "../src/phase6/sessions.mjs";
const rsa = generateKeyPairSync("rsa",{modulusLength:2048});
const jwks = {keys:[{...rsa.publicKey.export({format:"jwk"}),kid:"test",alg:"RS256",use:"sig"}]};
const audience="test.apps.googleusercontent.com";
const context=()=>({sessionPublicKey:randomBytes(32).toString("base64url"),randomness:randomBytes(32).toString("base64url")});
function token(nonce, subject="123456789012345678901", now=1770000000){
  const message=[{alg:"RS256",kid:"test",typ:"JWT"},{iss:"https://accounts.google.com",aud:audience,sub:subject,nonce,iat:now,exp:now+3600}].map(v=>Buffer.from(JSON.stringify(v)).toString("base64url")).join(".");
  return `${message}.${sign("RSA-SHA256",Buffer.from(message),rsa.privateKey).toString("base64url")}`;
}
test("login challenge is single-use, key-bound and cannot consume another session's token",()=>{
  const sessions=new DemoSessions({genesisHash:randomBytes(32),audience,now:()=>1770000000});
  const a=sessions.start(context()),b=sessions.start(context());
  assert.notEqual(a.nonce,b.nonce);
  assert.throws(()=>sessions.login(b.sessionId,token(a.nonce),jwks),/nonce/i);
  assert.throws(()=>sessions.login(b.sessionId,token(b.nonce),jwks),/already consumed/);
  sessions.login(a.sessionId,token(a.nonce),jwks);
  assert.throws(()=>sessions.login(a.sessionId,token(a.nonce),jwks),/already consumed/);
});
test("renewal changes the session key/nonce while preserving the same salt-derived wallet identity",()=>{
  const sessions=new DemoSessions({genesisHash:randomBytes(32),audience,now:()=>1770000000});
  const salt=randomBytes(32).toString("base64url"); const owners=[];
  for(let i=0;i<2;i++){const start=sessions.start(context());sessions.login(start.sessionId,token(start.nonce),jwks);owners.push(sessions.salt(start.sessionId,salt).owner);}
  assert.deepEqual(owners[0],owners[1]);
  const other=sessions.start(context());sessions.login(other.sessionId,token(other.nonce,"different-google-subject"),jwks);
  assert.notDeepEqual(sessions.salt(other.sessionId,salt).owner,owners[0]);
  assert.throws(()=>sessions.salt(other.sessionId,randomBytes(32).toString("base64url")),/another salt/);
});
test("expired sessions are removed and their salt bytes cleared; capacity is bounded",()=>{
  let now=1770000000;const sessions=new DemoSessions({genesisHash:randomBytes(32),audience,now:()=>now});
  const start=sessions.start(context());assert.throws(()=>sessions.get(start.sessionId),/Sign in/);
  sessions.login(start.sessionId,token(start.nonce),jwks);const held=sessions.salt(start.sessionId,randomBytes(32).toString("base64url")).salt;
  now+=600;assert.throws(()=>sessions.get(start.sessionId),/expired/);assert.equal(held.every(v=>v===0),true);
  for(let i=0;i<20;i++)sessions.start(context());assert.throws(()=>sessions.start(context()),/Too many/);sessions.close();assert.equal(sessions.entries.size,0);
});
test("Slack sessions carry single-use login state and may outlive Slack's five-minute token",()=>{
  const slackAudience="1234567890.9876543210",now=1770000000;
  const slackToken=(nonce,exp=now+300)=>{
    const message=[{alg:"RS256",kid:"test",typ:"JWT"},{iss:"https://slack.com",sub:"U0123ABCDEF",aud:slackAudience,nonce,iat:now,exp,"https://slack.com/team_id":"T0123ABC456"}].map(v=>Buffer.from(JSON.stringify(v).replaceAll("/","\\/")).toString("base64url")).join(".");
    return `${message}.${sign("RSA-SHA256",Buffer.from(message),rsa.privateKey).toString("base64url")}`;
  };
  const sessions=new DemoSessions({genesisHash:randomBytes(32),audiences:{google:audience,slack:slackAudience},now:()=>now});
  const start=sessions.start({...context(),provider:"slack"});
  assert.equal(start.provider,"slack");
  const s=sessions.byState(sessions.get(start.sessionId,false).state);assert.equal(s.id,start.sessionId);
  assert.throws(()=>sessions.byState("unknown"),/login state unknown/);
  // Google tokens from the Slack session's nonce are rejected by issuer.
  assert.throws(()=>sessions.login(start.sessionId,token(start.nonce),jwks),/Invalid Slack issuer/);
  const next=sessions.start({...context(),provider:"slack"});
  const verified=sessions.login(next.sessionId,slackToken(next.nonce),jwks);
  assert.deepEqual(verified.identity,{issuer:"https://slack.com",audience:slackAudience,subject:"T0123ABC456/U0123ABCDEF"});
  assert.equal(verified.expiresAt,now+600);
  // Google keeps its rule: the session must end by the token's expiry.
  const google=sessions.start(context());
  const short=[{alg:"RS256",kid:"test",typ:"JWT"},{iss:"https://accounts.google.com",aud:audience,sub:"1",nonce:google.nonce,iat:now,exp:now+300}].map(v=>Buffer.from(JSON.stringify(v)).toString("base64url")).join(".");
  assert.throws(()=>sessions.login(google.sessionId,`${short}.${sign("RSA-SHA256",Buffer.from(short),rsa.privateKey).toString("base64url")}`,jwks),/outside the Google token window/);
  assert.throws(()=>new DemoSessions({genesisHash:randomBytes(32),audience,now:()=>now}).start({...context(),provider:"slack"}),/not configured/);
  assert.throws(()=>sessions.start({...context(),provider:"github"}),/Unsupported login provider/);
});
