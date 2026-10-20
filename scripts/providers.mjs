// Provider data for shell scripts (src/phase3/oidc-providers.mjs).
//   node scripts/providers.mjs configured          ids with <PREFIX>_CLIENT_ID set in the environment
//   node scripts/providers.mjs all                 every provider id
//   node scripts/providers.mjs field <id> <path>   one field, e.g. circuit.directory or deployment
import { PROVIDERS, configuredAudiences, providerById } from "../src/phase3/oidc-providers.mjs";

const [command, id, path] = process.argv.slice(2);
if (command === "configured") console.log(Object.keys(configuredAudiences()).join(" "));
else if (command === "all") console.log(Object.keys(PROVIDERS).join(" "));
else if (command === "field" && id && path) {
  const value = path.split(".").reduce((v, key) => (v !== null && typeof v === "object" && Object.hasOwn(v, key) ? v[key] : undefined), providerById(id));
  if (typeof value !== "string") throw new Error(`Provider ${id} has no text field ${path}`);
  console.log(value);
} else {
  console.error("Usage: node scripts/providers.mjs configured | all | field <id> <path>");
  process.exit(2);
}
