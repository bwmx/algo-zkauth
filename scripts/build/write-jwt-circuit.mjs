// Writes a provider's JWT circuit from its circuit profile and provider data.
// Usage: node scripts/build/write-jwt-circuit.mjs <provider>
import { writeFileSync } from "node:fs";
import { HEADER_KEYS, circuitProfile, packedKey, rawJsonText } from "../../packages/protocol/src/circuit-profile.mjs";
import { providerById } from "../../packages/protocol/src/oidc-providers.mjs";

const provider = providerById(process.argv[2]);
const profile = circuitProfile(provider);
const { circuit, subjectScope: scope } = provider;

const array = (values) => `[${values.join(",")}]`;
const bytes = (text) => [...Buffer.from(text, "ascii")];
// The provider's signed spelling of keys and issuer, e.g. Slack's "\/".
const signed = (text) => rawJsonText(text, profile.escapedSlashes);
const at = (key) => {
  const index = profile.payloadKeys.indexOf(key);
  if (index < 0) throw new Error(`Circuit profile lacks the ${key} claim`);
  return index;
};
const [ISS, SUB, AUD, EXP, IAT, NONCE] = ["iss", "sub", "aud", "exp", "iat", "nonce"].map(at);
const AZP = profile.authorizedPartyClaim && at(profile.authorizedPartyClaim);
const NBF = profile.notBeforeClaim && at(profile.notBeforeClaim);
const SCOPE = scope && at(scope.claim);
const required = profile.requiredClaims.map(at);
const fields = profile.payloadKeys.length;
const template = circuit.name.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join("");

const canonicalIssuer = bytes(provider.issuer);
const otherIssuers = provider.issuers.filter((issuer) => issuer !== provider.issuer);
if (otherIssuers.length > 1 || (otherIssuers.length && profile.escapedSlashes)) {
  throw new Error("The circuit supports one escaped issuer spelling, or the canonical and one unescaped short spelling");
}
const signedIssuer = bytes(signed(provider.issuer));
const shortIssuer = otherIssuers.length ? bytes(otherIssuers[0]) : undefined;
const identityDomain = bytes("algorand-zklogin-identity-v1\0");
const nonceDomain = bytes("algorand-zklogin-session-v1\0");
const audienceOffset = identityDomain.length + 2 + canonicalIssuer.length + 2;
const maxIdentity = audienceOffset + 255 + 2 + 255 + 32;
const identityPadded = Math.ceil((maxIdentity + 9) / 64) * 64;
const nonceLength = nonceDomain.length + 32 + 32 + 8 + 32;
const lines = (...parts) => parts.filter((part) => part !== false && part !== undefined).join("\n");

const headerChecks = profile.requireTyp
  ? String.raw`    for (var k = 0; k < 3; k++) header.counts[k] === 1;
    header.lengths[0] === 5;
    header.lengths[2] === 3;`
  : String.raw`    // alg and kid are required; typ is optional and must be JWT when present.
    header.counts[0] === 1;
    header.counts[1] === 1;
    header.lengths[0] === 5;
    header.counts[2]*(header.lengths[2]-3) === 0;`;
const typCheck = profile.requireTyp
  ? String.raw`    for (var i = 0; i < 3; i++) header.values[2][i] === jwt[i];`
  : String.raw`    for (var i = 0; i < 3; i++) header.counts[2]*(header.values[2][i]-jwt[i]) === 0;`;

// Either the canonical issuer or its one short spelling (Google), or the one
// signed spelling (Slack's escaped slashes) of the canonical issuer.
const issuerCheck = shortIssuer
  ? String.raw`    signal longIssuer <== IsEqual()([claims.lengths[${ISS}], ${canonicalIssuer.length}]);
    signal abbreviatedIssuer <== IsEqual()([claims.lengths[${ISS}], ${shortIssuer.length}]);
    longIssuer+abbreviatedIssuer === 1;
    var issuer[${canonicalIssuer.length}] = ${array(canonicalIssuer)};
    var shortIssuer[${shortIssuer.length}] = ${array(shortIssuer)};
    for (var i = 0; i < ${canonicalIssuer.length}; i++) {
        if (i < ${shortIssuer.length}) claims.values[${ISS}][i] === longIssuer*issuer[i]+abbreviatedIssuer*shortIssuer[i];
        else claims.values[${ISS}][i] === longIssuer*issuer[i];
    }`
  : lines(
      signedIssuer.length !== canonicalIssuer.length && String.raw`    // ${provider.label} signs the issuer as ${signed(provider.issuer)}; the identity uses the
    // decoded issuer.`,
      String.raw`    claims.lengths[${ISS}] === ${signedIssuer.length};
    var signedIssuer[${signedIssuer.length}] = ${array(signedIssuer)};
    for (var i = 0; i < ${signedIssuer.length}; i++) claims.values[${ISS}][i] === signedIssuer[i];`,
    );

const name = scope?.name;
const Name = name && name[0].toUpperCase() + name.slice(1);
const claimChecks = lines(
  String.raw`    signal audNonempty <== LessEqThan(9)([1, claims.lengths[${AUD}]]);
    signal subNonempty <== LessEqThan(9)([1, claims.lengths[${SUB}]]);`,
  scope && String.raw`    signal ${name}Nonempty <== LessEqThan(9)([1, claims.lengths[${SCOPE}]]);
    signal ${name}Fits <== LessEqThan(9)([claims.lengths[${SCOPE}], ${scope.maxLength}]);`,
  String.raw`    audNonempty === 1;
    subNonempty === 1;`,
  scope && String.raw`    ${name}Nonempty === 1;
    ${name}Fits === 1;`,
  AZP !== undefined && String.raw`    claims.counts[${AZP}]*(claims.lengths[${AZP}]-claims.lengths[${AUD}]) === 0;`,
  String.raw`    signal audActive[255];
    signal subActive[255];
    signal audVisible[255];
    signal subVisible[255];
    for (var i = 0; i < 255; i++) {`,
  AZP !== undefined && String.raw`        claims.counts[${AZP}]*(claims.values[${AZP}][i]-claims.values[${AUD}][i]) === 0;`,
  String.raw`        audActive[i] <== LessThan(9)([i, claims.lengths[${AUD}]]);
        subActive[i] <== LessThan(9)([i, claims.lengths[${SUB}]]);
        audVisible[i] <== LessEqThan(8)([33, claims.values[${AUD}][i]]);
        subVisible[i] <== LessEqThan(8)([33, claims.values[${SUB}][i]]);
        audActive[i]*(1-audVisible[i]) === 0;
        subActive[i]*(1-subVisible[i]) === 0;
    }`,
  // The identity subject is "scope/sub": scope IDs are visible ASCII without "/".
  scope && String.raw`    // ${Name} IDs are visible ASCII without "/", so "${name}/sub" splits uniquely.
    signal ${name}Active[${scope.maxLength}];
    signal ${name}Visible[${scope.maxLength}];
    signal ${name}Slash[${scope.maxLength}];
    for (var i = 0; i < ${scope.maxLength}; i++) {
        ${name}Active[i] <== LessThan(9)([i, claims.lengths[${SCOPE}]]);
        ${name}Visible[i] <== LessEqThan(8)([33, claims.values[${SCOPE}][i]]);
        ${name}Slash[i] <== IsEqual()([claims.values[${SCOPE}][i], 47]);
        ${name}Active[i]*(1-${name}Visible[i]) === 0;
        ${name}Slash[i] === 0;
    }
    // A preimage byte holds the subject length, which bounds it to 255.
    signal subjectLength <== claims.lengths[${SCOPE}]+1+claims.lengths[${SUB}];`,
);

const within = provider.sessionWithinTokenExpiry;
const timeChecks = lines(
  within
    ? String.raw`    // Signed time policy plus a public execution-time lower bound.`
    : String.raw`    // Signed time policy plus a public execution-time lower bound. The token
    // may expire before the session; the session is bounded by iat + 600 and
    // may outlive the token's exp.`,
  String.raw`    _ <== Num2Bits(32)(sessionExpiresAt);
    signal expiryAfterIat <== LessThan(33)([claims.numbers[${IAT}], sessionExpiresAt]);
    signal sessionDuration <== LessEqThan(33)([sessionExpiresAt, claims.numbers[${IAT}]+600]);`,
  within && String.raw`    signal expiryInToken <== LessEqThan(32)([sessionExpiresAt, claims.numbers[${EXP}]]);`,
  String.raw`    signal tokenOrder <== LessThan(32)([claims.numbers[${IAT}], claims.numbers[${EXP}]]);
    signal tokenDuration <== LessEqThan(33)([claims.numbers[${EXP}]-claims.numbers[${IAT}], 7200]);
    signal iatSupportsSkew <== LessEqThan(32)([60, claims.numbers[${IAT}]]);`,
  NBF !== undefined && String.raw`    signal nbfBeforeExpiry <== LessThan(32)([claims.numbers[${NBF}], sessionExpiresAt]);`,
  String.raw`    expiryAfterIat === 1;
    sessionDuration === 1;`,
  within && String.raw`    expiryInToken === 1;`,
  String.raw`    tokenOrder === 1;
    tokenDuration === 1;
    iatSupportsSkew === 1;`,
  NBF !== undefined
    ? String.raw`    nbfBeforeExpiry === 1;
    signal nbfLater <== LessThan(32)([claims.numbers[${IAT}]-60, claims.numbers[${NBF}]]);
    notBefore === claims.numbers[${IAT}]-60+nbfLater*(claims.numbers[${NBF}]-claims.numbers[${IAT}]+60);`
    : String.raw`    notBefore === claims.numbers[${IAT}]-60;`,
);

const subjectLength = scope ? "subjectLength" : `claims.lengths[${SUB}]`;
const identityIssuer = lines(
  String.raw`    identityPreimage[${identityDomain.length + 1}] === ${canonicalIssuer.length};`,
  !shortIssuer && String.raw`    var issuer[${canonicalIssuer.length}] = ${array(canonicalIssuer)};`,
  String.raw`    for (var i = 0; i < ${canonicalIssuer.length}; i++) identityPreimage[${identityDomain.length + 2}+i] === issuer[i];`,
);
const subjectSection = scope
  ? String.raw`    // Subject section: length, ${name}, "/", sub.
    signal subSection[257] <== VarShiftLeft(${maxIdentity}, 257)(identityPreimage, ${audienceOffset}+claims.lengths[${AUD}]);
    subSection[0] === 0;
    subSection[1] === subjectLength;
    for (var i = 0; i < ${scope.maxLength}; i++) ${name}Active[i]*(subSection[i+2]-claims.values[${SCOPE}][i]) === 0;
    signal separator <== ItemAtIndex(257)(subSection, 2+claims.lengths[${SCOPE}]);
    separator === 47;
    signal userSection[255] <== VarShiftLeft(257, 255)(subSection, 3+claims.lengths[${SCOPE}]);
    for (var i = 0; i < 255; i++) subActive[i]*(userSection[i]-claims.values[${SUB}][i]) === 0;`
  : String.raw`    signal subSection[257] <== VarShiftLeft(${maxIdentity}, 257)(identityPreimage, ${audienceOffset}+claims.lengths[${AUD}]);
    subSection[0] === 0;
    subSection[1] === claims.lengths[${SUB}];
    for (var i = 0; i < 255; i++) subActive[i]*(subSection[i+2]-claims.values[${SUB}][i]) === 0;`;

// No secrets or client identifiers are embedded in this generated source.
const source = String.raw`pragma circom 2.2.3;
// Generated by scripts/build/write-jwt-circuit.mjs. Development POC, unaudited.
// All 12 public signals must be checked by the authorization application.
include "./strict_jwt_primitives.circom";
include "@zk-email/circuits/lib/rsa.circom";

template ${template}() {
    signal input identity[2];
    signal input keyHash[2];
    signal input audienceHash[2];
    signal input sessionKey[2];
    signal input genesisHash[2];
    signal input sessionExpiresAt;
    signal input notBefore;
    signal input message[1024];
    signal input messageLength;
    signal input headerLength;
    signal input modulus[17];
    signal input signature[17];
    signal input headerFieldCount;
    signal input headerKeyLengths[3];
    signal input headerValueLengths[3];
    signal input payloadFieldCount;
    signal input payloadKeyLengths[${fields}];
    signal input payloadValueLengths[${fields}];
    signal input salt[32];
    signal input randomness[32];
    signal input identityPreimage[${maxIdentity}];
    _ <== Num2Bits(11)(messageLength);
    _ <== Num2Bits(8)(headerLength);
    signal period <== ItemAtIndex(1024)(message, headerLength);
    period === 46;
    signal payloadLength <== messageLength-headerLength-1;
    _ <== Num2Bits(10)(payloadLength);
    signal headerEncoded[128] <== SelectSubArray(1024, 128)(message, 0, headerLength);
    signal payloadEncoded[896] <== SelectSubArray(1024, 896)(message, headerLength+1, payloadLength);
    component headerDecode = StrictBase64Url(128);
    headerDecode.in <== headerEncoded;
    headerDecode.length <== headerLength;
    component payloadDecode = StrictBase64Url(896);
    payloadDecode.in <== payloadEncoded;
    payloadDecode.length <== payloadLength;
    var headerWords[3] = ${array(HEADER_KEYS.map(packedKey))};
    var headerLens[3] = ${array(HEADER_KEYS.map((k) => k.length))};
    var headerKinds[3] = [0,0,0];
    component header = StrictFlatJson(96, 3, 3, 96, headerWords, headerLens, headerKinds);
    header.in <== headerDecode.out;
    header.length <== headerDecode.decodedLength;
    header.fieldCount <== headerFieldCount;
    header.keyLengths <== headerKeyLengths;
    header.valueLengths <== headerValueLengths;
${headerChecks}
    var rs256[5] = ${array(bytes("RS256"))};
    var jwt[3] = ${array(bytes("JWT"))};
    for (var i = 0; i < 5; i++) header.values[0][i] === rs256[i];
${typCheck}
    signal kidNonempty <== LessEqThan(7)([1, header.lengths[1]]);
    signal kidFits <== LessEqThan(7)([header.lengths[1], 64]);
    kidNonempty === 1;
    kidFits === 1;
    var payloadWords[${fields}] = ${array(profile.payloadKeys.map((k) => packedKey(signed(k))))};
    var payloadLens[${fields}] = ${array(profile.payloadKeys.map((k) => signed(k).length))};
    var payloadKinds[${fields}] = ${array(profile.payloadKinds)};
    component claims = StrictFlatJson(672, ${fields}, ${fields}, 255, payloadWords, payloadLens, payloadKinds);
    claims.in <== payloadDecode.out;
    claims.length <== payloadDecode.decodedLength;
    claims.fieldCount <== payloadFieldCount;
    claims.keyLengths <== payloadKeyLengths;
    claims.valueLengths <== payloadValueLengths;
    var required[${required.length}] = ${array(required)};
    for (var k = 0; k < ${required.length}; k++) claims.counts[required[k]] === 1;
${issuerCheck}
${claimChecks}
${timeChecks}
    // Each RSA value is a canonical 2048-bit integer in 121-bit limbs.
    signal modulusBits[2057];
    signal signatureBits[2057];
    component modLimbs[17];
    component sigLimbs[17];
    for (var k = 0; k < 17; k++) {
        modLimbs[k] = Num2Bits(121);
        sigLimbs[k] = Num2Bits(121);
        modLimbs[k].in <== modulus[k];
        sigLimbs[k].in <== signature[k];
        for (var b = 0; b < 121; b++) {
            modulusBits[k*121+b] <== modLimbs[k].out[b];
            signatureBits[k*121+b] <== sigLimbs[k].out[b];
        }
    }
    modulusBits[2047] === 1;
    modulusBits[0] === 1;
    for (var i = 2048; i < 2057; i++) {
        modulusBits[i] === 0;
        signatureBits[i] === 0;
    }
    signal messageDigest[256] <== StrictSha256(1024, 1024)(message, messageLength);
    signal rsaMessage[17];
    for (var k = 0; k < 17; k++) {
        var value = 0;
        for (var b = 0; b < 121; b++) {
            if (k*121+b < 256) value += messageDigest[255-k*121-b]*(2 ** b);
        }
        rsaMessage[k] <== value;
    }
    component rsa = RSAVerifier65537(121, 17);
    rsa.message <== rsaMessage;
    rsa.modulus <== modulus;
    rsa.signature <== signature;
    signal modulusBytes[256];
    for (var i = 0; i < 256; i++) {
        var value = 0;
        for (var b = 0; b < 8; b++) value += modulusBits[(255-i)*8+b]*(1 << b);
        modulusBytes[i] <== value;
    }
    signal keyDigest[256] <== StrictSha256(256, 320)(modulusBytes, 256);
    signal audDigest[256] <== StrictSha256(255, 320)(claims.values[${AUD}], claims.lengths[${AUD}]);
    // The full identity preimage is private but every byte is constrained.
    var identityDomain[${identityDomain.length}] = ${array(identityDomain)};
    for (var i = 0; i < ${identityDomain.length}; i++) identityPreimage[i] === identityDomain[i];
    identityPreimage[${identityDomain.length}] === 0;
${identityIssuer}
    identityPreimage[${audienceOffset - 2}] === 0;
    identityPreimage[${audienceOffset - 1}] === claims.lengths[${AUD}];
    for (var i = 0; i < 255; i++) audActive[i]*(identityPreimage[${audienceOffset}+i]-claims.values[${AUD}][i]) === 0;
${subjectSection}
    signal saltSection[32] <== VarShiftLeft(${maxIdentity}, 32)(identityPreimage, ${audienceOffset}+claims.lengths[${AUD}]+2+${subjectLength});
    for (var i = 0; i < 32; i++) saltSection[i] === salt[i];
    signal identityLength <== ${audienceOffset}+claims.lengths[${AUD}]+2+${subjectLength}+32;
    signal identityDigest[256] <== StrictSha256(${maxIdentity}, ${identityPadded})(identityPreimage, identityLength);
    signal keyBits[2][128];
    signal networkBits[2][128];
    for (var k = 0; k < 2; k++) {
        keyBits[k] <== Num2Bits(128)(sessionKey[k]);
        networkBits[k] <== Num2Bits(128)(genesisHash[k]);
    }
    signal expiryBits[64] <== Num2Bits(64)(sessionExpiresAt);
    var nonceDomain[${nonceDomain.length}] = ${array(nonceDomain)};
    signal noncePreimage[${nonceLength}];
    for (var i = 0; i < ${nonceDomain.length}; i++) noncePreimage[i] <== nonceDomain[i];
    for (var i = 0; i < 32; i++) {
        var pubByte = 0;
        var networkByte = 0;
        for (var b = 0; b < 8; b++) {
            pubByte += keyBits[i \ 16][(15-i%16)*8+b]*(1 << b);
            networkByte += networkBits[i \ 16][(15-i%16)*8+b]*(1 << b);
        }
        noncePreimage[${nonceDomain.length}+i] <== networkByte;
        noncePreimage[${nonceDomain.length + 32}+i] <== pubByte;
        _ <== Num2Bits(8)(randomness[i]);
        noncePreimage[${nonceDomain.length + 72}+i] <== randomness[i];
    }
    for (var i = 0; i < 8; i++) {
        var value = 0;
        for (var b = 0; b < 8; b++) value += expiryBits[(7-i)*8+b]*(1 << b);
        noncePreimage[${nonceDomain.length + 64}+i] <== value;
    }
    signal nonceDigest[256] <== StrictSha256(${nonceLength}, 192)(noncePreimage, ${nonceLength});
    claims.lengths[${NONCE}] === 43;
    signal nonceEncoded[44];
    for (var i = 0; i < 43; i++) nonceEncoded[i] <== claims.values[${NONCE}][i];
    nonceEncoded[43] <== 0;
    component nonceDecode = StrictBase64Url(44);
    nonceDecode.in <== nonceEncoded;
    nonceDecode.length <== 43;
    nonceDecode.decodedLength === 32;
    for (var i = 0; i < 32; i++) {
        var value = 0;
        for (var b = 0; b < 8; b++) value += nonceDigest[i*8+b]*(1 << (7-b));
        nonceDecode.out[i] === value;
    }
    for (var k = 0; k < 2; k++) {
        var owner = 0;
        var fingerprint = 0;
        var aud = 0;
        for (var b = 0; b < 128; b++) {
            owner += identityDigest[k*128+b]*(2 ** (127-b));
            fingerprint += keyDigest[k*128+b]*(2 ** (127-b));
            aud += audDigest[k*128+b]*(2 ** (127-b));
        }
        identity[k] === owner;
        keyHash[k] === fingerprint;
        audienceHash[k] === aud;
    }
}
component main { public [identity, keyHash, audienceHash, sessionKey, genesisHash, sessionExpiresAt, notBefore] } = ${template}();
`;
writeFileSync(new URL(`../../circuits/${circuit.name}.circom`, import.meta.url), source);
console.log(`Wrote the 12-signal ${provider.label} JWT development circuit`);
