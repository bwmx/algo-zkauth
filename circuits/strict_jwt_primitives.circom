pragma circom 2.2.3;
include "@zk-email/circuits/lib/sha.circom";
include "@zk-email/circuits/utils/array.circom";

// SHA-256 input is unpadded bytes. Both the marker and 64-bit length trailer
// are derived in constraints, never accepted as unchecked witness padding.
template StrictSha256(maxInput, maxPadded) {
    assert(maxPadded % 64 == 0);
    signal input in[maxInput];
    signal input length;
    signal output bits[256];
    var width = log2Ceil(maxPadded) + 1;
    _ <== Num2Bits(width)(length);
    signal fits <== LessEqThan(width)([length, maxInput]);
    fits === 1;
    signal blocks;
    signal remainder;
    blocks <-- (length+72) \ 64;
    remainder <-- (length+72) % 64;
    _ <== Num2Bits(6)(remainder);
    _ <== Num2Bits(width)(blocks);
    length+72 === blocks*64+remainder;
    signal nonempty <== LessEqThan(width)([1, blocks]);
    signal capacity <== LessEqThan(width)([blocks, maxPadded \ 64]);
    nonempty === 1;
    capacity === 1;
    signal paddedLength <== blocks*64;
    signal lengthBits[64] <== Num2Bits(64)(length*8);
    signal lengthBytes[8];
    for (var j = 0; j < 8; j++) {
        var value = 0;
        for (var b = 0; b < 8; b++) value += lengthBits[(7-j)*8+b]*(1 << b);
        lengthBytes[j] <== value;
    }
    signal data[maxPadded];
    signal inside[maxInput];
    signal marker[maxPadded];
    signal atTail[maxPadded][8];
    signal tail[maxPadded][8];
    signal padded[maxPadded];
    for (var i = 0; i < maxPadded; i++) {
        if (i < maxInput) {
            _ <== Num2Bits(8)(in[i]);
            inside[i] <== LessThan(width)([i, length]);
            (1-inside[i])*in[i] === 0;
            data[i] <== inside[i]*in[i];
        } else data[i] <== 0;
        marker[i] <== IsEqual()([i, length]);
        var ending = 0;
        for (var j = 0; j < 8; j++) {
            atTail[i][j] <== IsEqual()([i, paddedLength-8+j]);
            tail[i][j] <== atTail[i][j]*lengthBytes[j];
            ending += tail[i][j];
        }
        padded[i] <== data[i]+marker[i]*128+ending;
    }
    bits <== Sha256Bytes(maxPadded)(padded, paddedLength);
}

template Base64Sextet() {
    signal input byte;
    signal input active;
    signal output bits[6];
    _ <== Num2Bits(8)(byte);
    (1-active)*byte === 0;
    signal geA <== LessEqThan(8)([65, byte]);
    signal leZ <== LessEqThan(8)([byte, 90]);
    signal gea <== LessEqThan(8)([97, byte]);
    signal lez <== LessEqThan(8)([byte, 122]);
    signal geZero <== LessEqThan(8)([48, byte]);
    signal leNine <== LessEqThan(8)([byte, 57]);
    signal upper <== geA*leZ;
    signal lower <== gea*lez;
    signal digit <== geZero*leNine;
    signal dash <== IsEqual()([byte, 45]);
    signal underscore <== IsEqual()([byte, 95]);
    upper+lower+digit+dash+underscore === active;
    signal upperValue <== upper*(byte-65);
    signal lowerValue <== lower*(byte-71);
    signal digitValue <== digit*(byte+4);
    bits <== Num2Bits(6)(upperValue+lowerValue+digitValue+dash*62+underscore*63);
}

// Canonical unpadded Base64url. Zero decoded tail bytes also constrain the
// ambiguous unused bits in the last sextet (e.g. rejecting Zh for Zg).
template StrictBase64Url(maxEncoded) {
    assert(maxEncoded % 4 == 0);
    var maxDecoded = maxEncoded*3 \ 4;
    var width = log2Ceil(maxEncoded)+1;
    signal input in[maxEncoded];
    signal input length;
    signal output out[maxDecoded];
    signal output decodedLength;
    _ <== Num2Bits(width)(length);
    signal nonempty <== LessEqThan(width)([1, length]);
    signal fits <== LessEqThan(width)([length, maxEncoded]);
    nonempty === 1;
    fits === 1;
    signal quarters;
    signal remainder;
    quarters <-- length \ 4;
    remainder <-- length % 4;
    _ <== Num2Bits(width)(quarters);
    _ <== Num2Bits(2)(remainder);
    length === quarters*4+remainder;
    signal invalidRemainder <== IsEqual()([remainder, 1]);
    invalidRemainder === 0;
    signal remTwo <== IsEqual()([remainder, 2]);
    signal remThree <== IsEqual()([remainder, 3]);
    decodedLength <== quarters*3+remTwo+2*remThree;
    component sextets[maxEncoded];
    signal active[maxEncoded];
    for (var i = 0; i < maxEncoded; i++) {
        active[i] <== LessThan(width)([i, length]);
        sextets[i] = Base64Sextet();
        sextets[i].byte <== in[i];
        sextets[i].active <== active[i];
    }
    signal decodedActive[maxDecoded];
    for (var i = 0; i < maxDecoded; i++) {
        var value = 0;
        for (var b = 0; b < 8; b++) {
            var bitIndex = i*8+b;
            value += sextets[bitIndex \ 6].bits[5-bitIndex%6]*(1 << (7-b));
        }
        out[i] <== value;
        decodedActive[i] <== LessThan(width)([i, decodedLength]);
        (1-decodedActive[i])*out[i] === 0;
    }
}

template UInt32Decimal() {
    signal input in[10];
    signal input length;
    signal output out;
    _ <== Num2Bits(4)(length);
    signal nonempty <== LessEqThan(4)([1, length]);
    signal fits <== LessEqThan(4)([length, 10]);
    nonempty === 1;
    fits === 1;
    signal present[10];
    signal geZero[10];
    signal leNine[10];
    signal accumulator[11];
    accumulator[0] <== 0;
    for (var b = 0; b < 10; b++) {
        present[b] <== LessThan(4)([b, length]);
        geZero[b] <== LessEqThan(8)([48, in[b]]);
        leNine[b] <== LessEqThan(8)([in[b], 57]);
        present[b]*(1-geZero[b]) === 0;
        present[b]*(1-leNine[b]) === 0;
        (1-present[b])*in[b] === 0;
        accumulator[b+1] <== present[b]*(accumulator[b]*9+in[b]-48)+accumulator[b];
    }
    signal multipleDigits <== LessThan(4)([1, length]);
    signal leadingZero <== IsEqual()([in[0], 48]);
    multipleDigits*leadingZero === 0;
    _ <== Num2Bits(32)(accumulator[10]);
    out <== accumulator[10];
}

// A field's positions/lengths are witness hints. Constraints cover every key,
// separator, value and delimiter, then pass the exact next position onward.
template StrictJsonField(N, K, V, words, wordLengths, kinds) {
    var width = log2Ceil(N)+1;
    signal input in[N];
    signal input totalLength;
    signal input start;
    signal input active;
    signal input last;
    signal input keyLength;
    signal input valueLength;
    signal output nextStart;
    signal output matches[K];
    signal output values[V];
    signal output number;
    _ <== Num2Bits(5)(keyLength);
    _ <== Num2Bits(8)(valueLength);
    (1-active)*keyLength === 0;
    (1-active)*valueLength === 0;
    signal fits <== LessEqThan(9)([valueLength, V]);
    fits === 1;
    signal prefix[18] <== VarShiftLeft(N, 18)(in, start);
    active*(prefix[0]-34) === 0;
    signal keyByteActive[16];
    signal packedBytes[16];
    var packedKey = 0;
    for (var b = 0; b < 16; b++) {
        keyByteActive[b] <== LessThan(5)([b, keyLength]);
        packedBytes[b] <== keyByteActive[b]*prefix[b+1];
        packedKey += packedBytes[b]*(256 ** b);
    }
    var matchSum = 0;
    var expectedLength = 0;
    var numKind = 0;
    var boolKind = 0;
    for (var k = 0; k < K; k++) {
        matches[k] <== IsEqual()([packedKey, words[k]]);
        matchSum += matches[k];
        expectedLength += matches[k]*wordLengths[k];
        if (kinds[k] == 1) numKind += matches[k];
        if (kinds[k] == 2) boolKind += matches[k];
    }
    matchSum === active;
    keyLength === expectedLength;
    signal numericKind <== numKind;
    signal booleanKind <== boolKind;
    signal stringKind <== active-numKind-boolKind;
    signal keyQuote <== ItemAtIndex(18)(prefix, keyLength+1);
    signal keyColon <== ItemAtIndex(18)(prefix, keyLength+2);
    active*(keyQuote-34) === 0;
    active*(keyColon-58) === 0;
    signal openingIndex <== active*(start+keyLength+3);
    signal opening <== ItemAtIndex(N)(in, openingIndex);
    stringKind*(opening-34) === 0;
    signal valueStart <== start+keyLength+3+stringKind;
    signal end <== valueStart+valueLength+stringKind;
    signal safeEnd <== active*end;
    signal endInBounds <== LessThan(width)([end, totalLength]);
    active*(1-endInBounds) === 0;
    signal delimiter <== ItemAtIndex(N)(in, safeEnd);
    active*(delimiter-44-81*last) === 0;
    signal closingIndex <== stringKind*(valueStart+valueLength);
    signal closing <== ItemAtIndex(N)(in, closingIndex);
    stringKind*(closing-34) === 0;
    nextStart <== active*(end+1-start)+start;
    signal safeValueStart <== active*valueStart;
    signal rawValues[V] <== VarShiftLeft(N, V)(in, safeValueStart);
    signal present[V];
    signal stringByte[V];
    signal atLeastSpace[V];
    signal atMostTilde[V];
    signal isQuote[V];
    signal isBackslash[V];
    for (var b = 0; b < V; b++) {
        present[b] <== LessThan(9)([b, valueLength]);
        values[b] <== present[b]*rawValues[b];
        stringByte[b] <== stringKind*present[b];
        atLeastSpace[b] <== LessEqThan(8)([32, rawValues[b]]);
        atMostTilde[b] <== LessEqThan(8)([rawValues[b], 126]);
        isQuote[b] <== IsEqual()([rawValues[b], 34]);
        isBackslash[b] <== IsEqual()([rawValues[b], 92]);
        stringByte[b]*(1-atLeastSpace[b]) === 0;
        stringByte[b]*(1-atMostTilde[b]) === 0;
        stringByte[b]*isQuote[b] === 0;
        stringByte[b]*isBackslash[b] === 0;
    }
    signal decimalLength <== numericKind*(valueLength-1)+1;
    signal decimalBytes[10];
    for (var b = 0; b < 10; b++) {
        decimalBytes[b] <== numericKind*values[b]+(1-numericKind)*(b == 0 ? 48 : 0);
    }
    number <== UInt32Decimal()(decimalBytes, decimalLength);
    signal isTrue <== IsEqual()([values[0], 116]);
    signal isFalse <== IsEqual()([values[0], 102]);
    booleanKind*(isTrue+isFalse-1) === 0;
    booleanKind*(valueLength-4*isTrue-5*isFalse) === 0;
    var trueBytes[5] = [116,114,117,101,0];
    var falseBytes[5] = [102,97,108,115,101];
    for (var b = 0; b < 5; b++) {
        booleanKind*(values[b]-trueBytes[b]*isTrue-falseBytes[b]*isFalse) === 0;
    }
}

// Narrow profile: compact flat objects with allowlisted, unique, unescaped
// keys; unescaped printable ASCII strings; uint32 decimal times; booleans.
// Unsupported valid JSON is rejected. Kind 0=string, 1=uint32, 2=boolean.
template StrictFlatJson(N, F, K, V, words, wordLengths, kinds) {
    var width = log2Ceil(N)+1;
    signal input in[N];
    signal input length;
    signal input fieldCount;
    signal input keyLengths[F];
    signal input valueLengths[F];
    signal output counts[K];
    signal output lengths[K];
    signal output values[K][V];
    signal output numbers[K];
    _ <== Num2Bits(width)(length);
    signal nonempty <== LessEqThan(width)([2, length]);
    signal fits <== LessEqThan(width)([length, N]);
    nonempty === 1;
    fits === 1;
    _ <== Num2Bits(log2Ceil(F)+1)(fieldCount);
    signal hasField <== LessEqThan(log2Ceil(F)+1)([1, fieldCount]);
    signal fieldsFit <== LessEqThan(log2Ceil(F)+1)([fieldCount, F]);
    hasField === 1;
    fieldsFit === 1;
    in[0] === 123;
    signal byteActive[N];
    for (var i = 0; i < N; i++) {
        _ <== Num2Bits(8)(in[i]);
        byteActive[i] <== LessThan(width)([i, length]);
        (1-byteActive[i])*in[i] === 0;
    }
    component fields[F];
    signal starts[F+1];
    signal active[F];
    signal last[F];
    signal lengthTerms[F][K];
    signal numberTerms[F][K];
    signal valueTerms[F][K][V];
    starts[0] <== 1;
    for (var f = 0; f < F; f++) {
        active[f] <== LessThan(log2Ceil(F)+1)([f, fieldCount]);
        last[f] <== IsEqual()([f, fieldCount-1]);
        fields[f] = StrictJsonField(N, K, V, words, wordLengths, kinds);
        fields[f].in <== in;
        fields[f].totalLength <== length;
        fields[f].start <== starts[f];
        fields[f].active <== active[f];
        fields[f].last <== last[f];
        fields[f].keyLength <== keyLengths[f];
        fields[f].valueLength <== valueLengths[f];
        starts[f+1] <== fields[f].nextStart;
        for (var k = 0; k < K; k++) {
            lengthTerms[f][k] <== fields[f].matches[k]*valueLengths[f];
            numberTerms[f][k] <== fields[f].matches[k]*fields[f].number;
            for (var b = 0; b < V; b++) valueTerms[f][k][b] <== fields[f].matches[k]*fields[f].values[b];
        }
    }
    starts[F] === length;
    for (var k = 0; k < K; k++) {
        var count = 0;
        var valueLength = 0;
        var numberValue = 0;
        for (var f = 0; f < F; f++) {
            count += fields[f].matches[k];
            valueLength += lengthTerms[f][k];
            numberValue += numberTerms[f][k];
        }
        counts[k] <== count;
        counts[k]*(counts[k]-1) === 0;
        lengths[k] <== valueLength;
        numbers[k] <== numberValue;
        for (var b = 0; b < V; b++) {
            var value = 0;
            for (var f = 0; f < F; f++) value += valueTerms[f][k][b];
            values[k][b] <== value;
        }
    }
}
