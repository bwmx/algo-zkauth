pragma circom 2.2.3;

// Sizing experiment only. This verifies RS256 but does not constrain Google
// claims or session authorization, and must never be used as a wallet verifier.
include "../upstream/zk-jwt/packages/circuits/jwt-verifier.circom";

template JwtCoreSizing() {
    signal input message[1024];
    signal input messageLength;
    signal input pubkey[17];
    signal input signature[17];
    signal input periodIndex;
    signal output publicKeyHash;

    component jwt = JWTVerifier(121, 17, 1024, 128, 896);
    jwt.message <== message;
    jwt.messageLength <== messageLength;
    jwt.pubkey <== pubkey;
    jwt.signature <== signature;
    jwt.periodIndex <== periodIndex;
    publicKeyHash <== jwt.publicKeyHash;
}

component main = JwtCoreSizing();
