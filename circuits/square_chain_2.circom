pragma circom 2.2.3;

// Toy circuit for measuring Groth16 verification. This is not a secure hash.
template SquareChain() {
    signal input secret;
    signal input domain;
    signal output digest;

    signal state[33];
    state[0] <== secret + domain;
    for (var i = 0; i < 32; i++) {
        state[i + 1] <== state[i] * state[i] + domain + i;
    }
    digest <== state[32];
}

component main {public [domain]} = SquareChain();
