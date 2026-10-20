// The one place @algozkauth/chain loads its Algorand and proving dependencies.
// They come from the pinned upstream/snarkjs-algorand checkout (scripts/fetch-upstream.sh),
// by path, so the repository needs no second install and every module, including
// the Groth16 verifier and the generated contract clients that import these
// packages by name from inside that checkout, shares one algosdk and one
// algokit-utils instance. See ../README.md.
import { readFileSync, existsSync } from "node:fs";

const upstream = new URL("../../../upstream/snarkjs-algorand/", import.meta.url);

export { AlgorandClient, microAlgos } from "../../../upstream/snarkjs-algorand/node_modules/@algorandfoundation/algokit-utils/index.mjs";
export { Address, decodeAddress, getApplicationAddress } from "../../../upstream/snarkjs-algorand/node_modules/algosdk/dist/esm/index.js";
export * as snarkjs from "../../../upstream/snarkjs-algorand/node_modules/snarkjs/main.js";
export { Groth16Bn254LsigVerifier, encodeGroth16Bn254Proof } from "../../../upstream/snarkjs-algorand/src/groth16.ts";

const CLIENTS = ["KeyRegistry", "WalletRegistry", "UserWallet"] as const;

/**
 * The generated contract clients. They run from the upstream checkout, where
 * scripts/prepare-demo.sh and scripts/build-wallets.sh install them; a copy that
 * differs from the committed contracts/clients would deploy other programs.
 */
export async function loadContracts() {
  for (const name of CLIENTS) {
    const committed = new URL(`../../../contracts/clients/${name}.ts`, import.meta.url);
    const installed = new URL(`contracts/clients/${name}.ts`, upstream);
    if (!existsSync(installed) || !readFileSync(installed).equals(readFileSync(committed)))
      throw new Error("Contract clients are not installed in the upstream checkout; run sh scripts/prepare-demo.sh");
  }
  const [keys, registry, wallet] = await Promise.all([
    import("../../../upstream/snarkjs-algorand/contracts/clients/KeyRegistry.ts"),
    import("../../../upstream/snarkjs-algorand/contracts/clients/WalletRegistry.ts"),
    import("../../../upstream/snarkjs-algorand/contracts/clients/UserWallet.ts"),
  ]);
  return {
    KeyRegistryFactory: keys.KeyRegistryFactory,
    WalletRegistryFactory: registry.WalletRegistryFactory,
    UserWalletFactory: wallet.UserWalletFactory,
    WALLET_SPEC: wallet.APP_SPEC,
  };
}
