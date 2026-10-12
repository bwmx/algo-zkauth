import { oidcCircuitInput } from "./circuit-input.mjs";
import { PROVIDERS } from "./oidc-providers.mjs";

export { flatJsonHints } from "./circuit-input.mjs";

export const googleCircuitInput = (options) =>
  oidcCircuitInput({ ...options, provider: PROVIDERS.google });
