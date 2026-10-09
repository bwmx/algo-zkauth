import {fetchGoogleJwks} from "../src/phase3/google-id-token.mjs";
import {checkDemoPolicy} from "../upstream/snarkjs-algorand/src/phase6/policy.ts";
if(!process.env.TESTNET_MNEMONIC)throw new Error("Set the TestNet-only sponsor locally");
const root=new URL("../",import.meta.url).pathname;
console.log(JSON.stringify(await checkDemoPolicy(root,process.env.TESTNET_MNEMONIC,await fetchGoogleJwks())));
