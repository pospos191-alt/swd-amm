// llama2.c's tokenizer (tokenizer.bin) in plain JavaScript: the same encode()
// and decode() as Karpathy's run.c, so token ids match the C reference and
// scripts/llm/train-tiny-llama.py (which tokenized the training text with it).
//
// File: i32 max_token_length, then per token: f32 score, i32 length, bytes.
// Ids 3..258 are the byte-fallback tokens <0x00>..<0xFF>; 1 = BOS, 2 = EOS.
// encode: a dummy " " first (sentencepiece's add_dummy_prefix), one token per
// UTF-8 character (or its bytes when the character is not in the vocabulary),
// then repeatedly merge the adjacent pair whose concatenation is a token with
// the highest score (the first such pair on ties).

export function loadTokenizer(bytes, vocabSize) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const maxLen = v.getInt32(0, true);
  if (!(maxLen > 0 && maxLen < 1024)) throw new Error('not a llama2.c tokenizer');
  const dec = new TextDecoder();
  const vocab = [], raw = [], scores = new Float32Array(vocabSize);
  let o = 4;
  for (let i = 0; i < vocabSize; i++) {
    if (o + 8 > bytes.length) throw new Error('tokenizer is truncated');
    scores[i] = v.getFloat32(o, true);
    const len = v.getInt32(o + 4, true);
    if (len < 0 || len > maxLen || o + 8 + len > bytes.length) throw new Error('tokenizer: bad token');
    const b = bytes.slice(o + 8, o + 8 + len);
    raw.push(b);
    vocab.push(dec.decode(b));
    o += 8 + len;
  }
  // lookup by exact bytes (as run.c's strcmp); the first id wins on duplicates
  const key = (b) => Array.from(b, (x) => String.fromCharCode(x)).join('');
  const index = new Map();
  raw.forEach((b, i) => { const k = key(b); if (!index.has(k)) index.set(k, i); });
  const byteOf = raw.map((b) => {
    const m = /^<0x([0-9A-Fa-f]{2})>$/.exec(key(b));
    return m ? parseInt(m[1], 16) : -1;
  });

  function encode(text, { bos = true, eos = false } = {}) {
    const out = bos ? [1] : [];
    const src = new TextEncoder().encode(String(text));
    if (src.length > 1 << 16) throw new Error('text too long to tokenize');
    const tokens = [];
    if (src.length) {
      const sp = index.get(' ');
      if (sp === undefined) throw new Error('tokenizer has no " " piece');
      tokens.push(sp);
    }
    for (let i = 0; i < src.length;) {
      let j = i + 1;
      while (j < src.length && (src[j] & 0xc0) === 0x80 && j - i < 4) j++;
      const id = index.get(key(src.subarray(i, j)));
      if (id !== undefined) tokens.push(id);
      else for (let k = i; k < j; k++) tokens.push(src[k] + 3);
      i = j;
    }
    for (;;) {
      let best = -1e10, bestId = -1, bestAt = -1;
      for (let i = 0; i < tokens.length - 1; i++) {
        const id = index.get(key(raw[tokens[i]]) + key(raw[tokens[i + 1]]));
        if (id !== undefined && scores[id] > best) { best = scores[id]; bestId = id; bestAt = i; }
      }
      if (bestAt < 0) break;
      tokens.splice(bestAt, 2, bestId);
    }
    out.push(...tokens);
    if (eos) out.push(2);
    return out;
  }

  /** Bytes of one token as run.c's decode() prints them (prev: the token before it). */
  function pieceBytes(prev, token) {
    if (!(token >= 0 && token < vocabSize)) throw new Error('token out of range');
    if (byteOf[token] >= 0) return Uint8Array.of(byteOf[token]);
    const b = raw[token];
    return prev === 1 && b[0] === 0x20 ? b.subarray(1) : b; // after BOS, a leading space is dropped
  }

  /** Text of a token sequence (UTF-8 split across byte tokens is joined first). prev: the token before the first. */
  function decode(tokens, prev = 1) {
    const parts = [];
    let n = 0;
    for (const t of tokens) { const b = pieceBytes(prev, t); parts.push(b); n += b.length; prev = t; }
    const all = new Uint8Array(n);
    let o = 0;
    for (const b of parts) { all.set(b, o); o += b.length; }
    return dec.decode(all);
  }

  return { vocab, scores, vocabSize, encode, decode, pieceBytes, piece: (prev, t) => dec.decode(pieceBytes(prev, t)) };
}
