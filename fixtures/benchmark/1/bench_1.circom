pragma circom 2.2.3;

// Toy circuit for verifier cost scaling. Not a cryptographic hash.
template Benchmark() {
    signal input secret;
    signal output digest;
    signal state[33];
    state[0] <== secret + 7;
    for (var i = 0; i < 32; i++) {
        state[i + 1] <== state[i] * state[i] + 7 + i;
    }
    digest <== state[32];
}

component main = Benchmark();
