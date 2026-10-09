// Adapt the installed client generator's output to the pinned project's strict
// TypeScript settings. These changes affect types only, not transaction behavior.
import { readFileSync, writeFileSync } from "node:fs";
import ts from "../upstream/snarkjs-algorand/node_modules/typescript/lib/typescript.js";

const runtimeImports = new Set([
  "getArc56ReturnValue",
  "getABIStructFromABITuple",
  "AppClient",
  "AppFactory",
  "TransactionComposer",
  "Address",
  "encodeAddress",
  "modelsv2",
  "OnApplicationComplete",
  "Transaction",
]);
const names = process.argv.slice(2);
for (const name of names.length
  ? names
  : ["GoogleKeyRegistry", "GoogleJwtAuthorization"]) {
  if (!["GoogleKeyRegistry", "GoogleJwtAuthorization", "UserWallet", "WalletRegistry"].includes(name))
    throw new Error("Unknown Google policy client");
  const path = new URL(
    `../upstream/snarkjs-algorand/contracts/clients/${name}.ts`,
    import.meta.url,
  );
  let source = readFileSync(path, "utf8");
  const parsed = ts.createSourceFile(
    path.pathname,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const insertions = [];
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const specifier of bindings.elements) {
      const original = (specifier.propertyName ?? specifier.name).text;
      if (!specifier.isTypeOnly && !runtimeImports.has(original))
        insertions.push(specifier.getStart(parsed));
    }
  }
  for (const offset of insertions.sort((a, b) => b - a))
    source = source.slice(0, offset) + "type " + source.slice(offset);
  source = source.replace(
    /APP_SPEC\.structs\.(\w+),/g,
    "APP_SPEC.structs.$1!,",
  );
  writeFileSync(path, source);
}
