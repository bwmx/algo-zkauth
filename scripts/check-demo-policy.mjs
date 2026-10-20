// Disposable TestNet key/session-policy checks for one provider's live keys.
// Usage (after scripts/prepare-demo.sh): node --env-file=.env --import <tsx> scripts/check-demo-policy.mjs [provider]
import {fetchJwks} from "../src/phase3/id-token.mjs";
import {DEFAULT_PROVIDER,providerById} from "../src/phase3/oidc-providers.mjs";
import {checkDemoPolicy} from "../upstream/snarkjs-algorand/src/phase6/policy.ts";
if(!process.env.TESTNET_MNEMONIC)throw new Error("Set the TestNet-only sponsor locally");
const root=new URL("../",import.meta.url).pathname;
const provider=providerById(process.argv[2]??DEFAULT_PROVIDER);
console.log(JSON.stringify(await checkDemoPolicy(root,process.env.TESTNET_MNEMONIC,provider,await fetchJwks(provider))));
