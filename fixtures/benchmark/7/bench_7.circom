pragma circom 2.2.3;

// Toy circuit for verifier cost scaling. Not a cryptographic hash.
template Benchmark() {
    signal input secret;
    signal input context[6];
    signal output digest;
    signal state[33];
    state[0] <== secret + context[0];
    for (var i = 0; i < 32; i++) {
        state[i + 1] <== state[i] * state[i] + context[i % 6] + i;
    }
    digest <== state[32];
}

component main {public [context]} = Benchmark();
