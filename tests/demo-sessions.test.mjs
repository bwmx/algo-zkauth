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
