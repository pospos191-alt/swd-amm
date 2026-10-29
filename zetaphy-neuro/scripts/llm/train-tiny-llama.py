#!/usr/bin/env python3
"""Trains the tiny Llama-architecture language model that the in-browser
pipeline (zetaphy-neuro/ai/browser/llama.js) splits across browsers.

Only numpy (no torch, no download): the corpus is this repository's own English
documentation (the *.md files, prose paragraphs only), so the model and its
training data stay inside the repo. The architecture is exactly Karpathy's
llama2.c "Llama 2" (RMSNorm, rotary position embedding, grouped-query attention,
SwiGLU feed-forward, classifier tied to the token embedding), and the output is
written in llama2.c's own files:
  model.bin      legacy llama2.c checkpoint (7 int32 header + float32 weights)
  tokenizer.bin  llama2.c tokenizer (max_token_length, then score/len/bytes per token)
(the layout run.c reads; run.c itself was not run here: the check is the independent float64
`--reference` forward below against ai/browser/llama.js, test/llm.test.js), and any
llama2.c checkpoint (e.g. Karpathy's MIT-licensed stories260K / stories15M) runs
in the browser with the same code (scripts/build-llm-pack.js converts it).

What it is, honestly: 338,240 parameters trained for ~1 hour (one CPU core) on ~0.5 MB of
text. It writes English that looks like these docs, not true or useful answers.

  MALLOC_MMAP_THRESHOLD_=33554432 MALLOC_TRIM_THRESHOLD_=4000000000 \
    python3 scripts/llm/train-tiny-llama.py --out /tmp/tiny-llm [--steps 3000] [--seed 1]
  (the malloc settings only make it faster: glibc otherwise maps and unmaps the
  big attention arrays on every step; ~1 s per step of 8 x 256 tokens on one core)
  python3 scripts/llm/train-tiny-llama.py --gradcheck      # checks the hand-written backward pass

Deterministic for a given seed, corpus and numpy/BLAS build (BLAS threading can
change the last bits of float sums between machines; the published weights are
the ones hashed in the manifest, not a promise that a re-run is bit-identical).
"""
import argparse, json, math, os, re, struct, subprocess, sys, time
os.environ.setdefault('OPENBLAS_NUM_THREADS', '1')  # tiny matrices: threads only add overhead (and nondeterminism)
import numpy as np

BOS, EOS = 1, 2
N_SPECIAL = 3 + 256  # <unk>, <s>, </s>, then the 256 byte-fallback tokens <0x00>..<0xFF>


# ----------------------------------------------------------------------------- corpus
def corpus_paragraphs(root):
    files = subprocess.run(['git', 'ls-files', '*.md'], cwd=root, capture_output=True, text=True, check=True).stdout.split()
    files = sorted(f for f in files if not f.endswith('.th.md') and 'node_modules' not in f)
    out = []
    for f in files:
        text = open(os.path.join(root, f), encoding='utf-8').read()
        text = re.sub(r'```.*?```', '\n\n', text, flags=re.S)  # drop code blocks
        for p in re.split(r'\n\s*\n', text):
            p = p.strip()
            if not p or p.startswith(('|', '<', '![', '---', '    ')):
                continue
            p = re.sub(r'`([^`]*)`', r'\1', p)            # inline code -> plain
            p = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', p)  # links -> their text
            p = re.sub(r'[*_]{1,2}([^*_]+)[*_]{1,2}', r'\1', p)
            p = re.sub(r'[ \t]+', ' ', p)
            p = '\n'.join(l.strip() for l in p.split('\n'))
            letters = sum(c.isalpha() for c in p)
            if len(p) < 40 or letters < 0.6 * len(p) or any(ord(c) > 0x2FFF for c in p):
                continue
            out.append(p)
    return files, out


# ----------------------------------------------------------------------------- tokenizer
SEG = re.compile(r'\n| ?[^ \n]+| ')


def segments(text):
    # llama2.c's encoder prepends a dummy " " (sentencepiece add_dummy_prefix)
    return SEG.findall(' ' + text)


def train_bpe(paragraphs, vocab_size):
    from collections import Counter
    freq = Counter()
    chars = Counter()
    for p in paragraphs:
        for s in segments(p):
            freq[s] += 1
            chars.update(s)
    base = sorted(c for c, n in chars.items() if n >= 2)
    pieces = list(base)
    have = set(pieces)
    from collections import defaultdict
    words = {s: [c if c in have else None for c in s] for s in freq}
    words = {s: w for s, w in words.items() if None not in w}
    pairs = Counter()
    where = defaultdict(set)  # pair -> words containing it
    for s, w in words.items():
        for a, b in zip(w, w[1:]):
            pairs[(a, b)] += freq[s]
            where[(a, b)].add(s)
    merges = []
    while N_SPECIAL + len(pieces) < vocab_size and pairs:
        best = max(pairs.items(), key=lambda kv: (kv[1], kv[0]))[0]
        if pairs[best] < 2:
            break
        new = best[0] + best[1]
        merges.append(new)
        if new not in have:
            pieces.append(new)
            have.add(new)
        for s in list(where.pop(best, ())):
            w, n = words[s], freq[s]
            for a, b in zip(w, w[1:]):
                pairs[(a, b)] -= n
                if pairs[(a, b)] <= 0:
                    del pairs[(a, b)]
            i, out = 0, []
            while i < len(w):
                if i + 1 < len(w) and w[i] == best[0] and w[i + 1] == best[1]:
                    out.append(new); i += 2
                else:
                    out.append(w[i]); i += 1
            words[s] = out
            for a, b in zip(out, out[1:]):
                pairs[(a, b)] += n
                where[(a, b)].add(s)
    vocab = ['<unk>', '\n<s>\n', '\n</s>\n'] + ['<0x%02X>' % b for b in range(256)] + pieces
    rank = {m: i for i, m in enumerate(merges)}
    scores = [0.0] * N_SPECIAL + [(-float(rank[p]) if p in rank else -1e6) for p in pieces]
    return vocab, scores


class Tokenizer:
    """llama2.c's encode() (run.c), in Python, used to tokenize the training text."""

    def __init__(self, vocab, scores):
        self.vocab, self.scores = vocab, scores
        self.index = {}
        for i, p in enumerate(vocab):  # every piece, first id wins (as llama2.c's lookup over the whole vocab)
            self.index.setdefault(p, i)
        self.cache = {}

    def encode_segment(self, s):
        if s in self.cache:
            return self.cache[s]
        toks = []
        for c in s:
            if c in self.index:
                toks.append(self.index[c])
            else:
                toks.extend(b + 3 for b in c.encode('utf-8'))
        while True:
            best, best_id, best_i = -1e10, -1, -1
            for i in range(len(toks) - 1):
                a, b = self.vocab[toks[i]], self.vocab[toks[i + 1]]
                j = self.index.get(a + b)
                if j is not None and self.scores[j] > best:
                    best, best_id, best_i = self.scores[j], j, i
            if best_i < 0:
                break
            toks[best_i:best_i + 2] = [best_id]
        self.cache[s] = toks
        return toks

    def encode(self, text):
        out = []
        for s in segments(text):
            out.extend(self.encode_segment(s))
        return out

    def decode(self, ids):
        out = b''
        prev = BOS
        for t in ids:
            p = self.vocab[t]
            if prev == BOS and p.startswith(' '):
                p = p[1:]
            m = re.fullmatch(r'<0x([0-9A-F]{2})>', p)
            out += bytes([int(m.group(1), 16)]) if m else p.encode('utf-8')
            prev = t
        return out.decode('utf-8', 'replace')


def write_tokenizer(path, vocab, scores):
    data = [p.encode('utf-8') for p in vocab]
    with open(path, 'wb') as f:
        f.write(struct.pack('<i', max(len(d) for d in data)))
        for d, s in zip(data, scores):
            f.write(struct.pack('<fi', s, len(d)))
            f.write(d)


# ----------------------------------------------------------------------------- model
def init_params(cfg, rng):
    D, F, L, V = cfg['dim'], cfg['hidden_dim'], cfg['n_layers'], cfg['vocab_size']
    hd = D // cfg['n_heads']
    KVD = cfg['n_kv_heads'] * hd
    n = lambda *s: (rng.standard_normal(s) * 0.02).astype(np.float32)
    proj = 0.02 / math.sqrt(2 * L)
    p = {'emb': n(V, D), 'norm': np.ones(D, np.float32)}
    for l in range(L):
        p[f'{l}.att_norm'] = np.ones(D, np.float32)
        p[f'{l}.wq'] = n(D, D)
        p[f'{l}.wk'] = n(KVD, D)
        p[f'{l}.wv'] = n(KVD, D)
        p[f'{l}.wo'] = (rng.standard_normal((D, D)) * proj).astype(np.float32)
        p[f'{l}.ffn_norm'] = np.ones(D, np.float32)
        p[f'{l}.w1'] = n(F, D)
        p[f'{l}.w2'] = (rng.standard_normal((D, F)) * proj).astype(np.float32)
        p[f'{l}.w3'] = n(F, D)
    return p


def rope_tables(T, hd, dtype):
    j = np.arange(0, hd, 2, dtype=np.float64)
    freq = 1.0 / (10000.0 ** (j / hd))
    ang = np.arange(T, dtype=np.float64)[:, None] * freq[None, :]
    return np.cos(ang).astype(dtype), np.sin(ang).astype(dtype)  # (T, hd/2)


def rope(x, c, s):  # x (B, T, h, hd)
    x0, x1 = x[..., 0::2], x[..., 1::2]
    c, s = c[None, :, None, :], s[None, :, None, :]
    out = np.empty_like(x)
    out[..., 0::2] = x0 * c - x1 * s
    out[..., 1::2] = x0 * s + x1 * c
    return out


def rope_back(dy, c, s):
    d0, d1 = dy[..., 0::2], dy[..., 1::2]
    c, s = c[None, :, None, :], s[None, :, None, :]
    out = np.empty_like(dy)
    out[..., 0::2] = d0 * c + d1 * s
    out[..., 1::2] = -d0 * s + d1 * c
    return out


EPS = 1e-5


def rms(x, g):
    r = 1.0 / np.sqrt((x * x).mean(-1, keepdims=True) + EPS)
    return x * r * g, r


def rms_back(dy, x, g, r):
    dg = (dy * x * r).reshape(-1, x.shape[-1]).sum(0)
    dh = dy * g
    dx = r * (dh - x * r * r * (dh * x).mean(-1, keepdims=True))
    return dx, dg


def sigmoid(a):
    return 1.0 / (1.0 + np.exp(-a))


def forward_backward(p, cfg, idx, tgt, need_grad=True):
    B, T = idx.shape
    D, L, H, KV = cfg['dim'], cfg['n_layers'], cfg['n_heads'], cfg['n_kv_heads']
    hd, rep = D // H, H // KV
    dt = p['emb'].dtype
    c, s = rope_tables(T, hd, dt)
    mask = np.triu(np.full((T, T), -np.inf, dtype=dt), 1)
    x = p['emb'][idx]
    caches = []
    for l in range(L):
        h, r1 = rms(x, p[f'{l}.att_norm'])
        q = (h @ p[f'{l}.wq'].T).reshape(B, T, H, hd)
        k = (h @ p[f'{l}.wk'].T).reshape(B, T, KV, hd)
        v = (h @ p[f'{l}.wv'].T).reshape(B, T, KV, hd)
        qr, kr = rope(q, c, s), rope(k, c, s)
        C = np.ascontiguousarray
        Q = C(qr.transpose(0, 2, 1, 3))                       # B H T hd
        K = C(np.repeat(kr.transpose(0, 2, 1, 3), rep, 1))     # B H T hd
        Vv = C(np.repeat(v.transpose(0, 2, 1, 3), rep, 1))
        S = Q @ C(K.transpose(0, 1, 3, 2)) / math.sqrt(hd) + mask
        S = S - S.max(-1, keepdims=True)
        P = np.exp(S); P /= P.sum(-1, keepdims=True)
        O = C((P @ Vv).transpose(0, 2, 1, 3)).reshape(B, T, D)
        x1 = x + O @ p[f'{l}.wo'].T
        h2, r2 = rms(x1, p[f'{l}.ffn_norm'])
        a = h2 @ p[f'{l}.w1'].T
        b = h2 @ p[f'{l}.w3'].T
        sg = sigmoid(a)
        sw = a * sg * b
        x2 = x1 + sw @ p[f'{l}.w2'].T
        caches.append((x, h, r1, Q, K, Vv, P, O, x1, h2, r2, a, b, sg, sw))
        x = x2
    xf, rf = rms(x, p['norm'])
    logits = xf @ p['emb'].T
    m = logits.max(-1, keepdims=True)
    e = np.exp(logits - m)
    z = e.sum(-1, keepdims=True)
    logp = logits - m - np.log(z)
    loss = -np.take_along_axis(logp, tgt[..., None], -1).mean()
    if not need_grad:
        return float(loss), None
    g = {k: np.zeros_like(v) for k, v in p.items()}
    dlog = e / z
    np.put_along_axis(dlog, tgt[..., None], np.take_along_axis(dlog, tgt[..., None], -1) - 1, -1)
    dlog /= B * T
    g['emb'] += dlog.reshape(-1, dlog.shape[-1]).T @ xf.reshape(-1, D)
    dxf = dlog @ p['emb']
    dx, g['norm'] = rms_back(dxf, x, p['norm'], rf)
    for l in reversed(range(L)):
        (x0, h, r1, Q, K, Vv, P, O, x1, h2, r2, a, b, sg, sw) = caches[l]
        # feed-forward
        g[f'{l}.w2'] += dx.reshape(-1, D).T @ sw.reshape(-1, sw.shape[-1])
        dsw = dx @ p[f'{l}.w2']
        silu = a * sg
        db = dsw * silu
        da = dsw * b * sg * (1 + a * (1 - sg))
        g[f'{l}.w1'] += da.reshape(-1, da.shape[-1]).T @ h2.reshape(-1, D)
        g[f'{l}.w3'] += db.reshape(-1, db.shape[-1]).T @ h2.reshape(-1, D)
        dh2 = da @ p[f'{l}.w1'] + db @ p[f'{l}.w3']
        dx1n, g[f'{l}.ffn_norm'] = rms_back(dh2, x1, p[f'{l}.ffn_norm'], r2)
        dx1 = dx + dx1n
        # attention
        g[f'{l}.wo'] += dx1.reshape(-1, D).T @ O.reshape(-1, D)
        C = np.ascontiguousarray
        dO = C((dx1 @ p[f'{l}.wo']).reshape(B, T, H, hd).transpose(0, 2, 1, 3))
        dP = dO @ C(Vv.transpose(0, 1, 3, 2))
        dV = C(P.transpose(0, 1, 3, 2)) @ dO
        dS = P * (dP - (dP * P).sum(-1, keepdims=True)) / math.sqrt(hd)
        dQ = dS @ K
        dK = C(dS.transpose(0, 1, 3, 2)) @ Q
        dK = dK.reshape(B, KV, rep, T, hd).sum(2)
        dV = dV.reshape(B, KV, rep, T, hd).sum(2)
        dq = C(rope_back(dQ.transpose(0, 2, 1, 3), c, s)).reshape(B, T, D)
        dk = C(rope_back(dK.transpose(0, 2, 1, 3), c, s)).reshape(B, T, -1)
        dv = C(dV.transpose(0, 2, 1, 3)).reshape(B, T, -1)
        hf = h.reshape(-1, D)
        g[f'{l}.wq'] += dq.reshape(-1, D).T @ hf
        g[f'{l}.wk'] += dk.reshape(-1, dk.shape[-1]).T @ hf
        g[f'{l}.wv'] += dv.reshape(-1, dv.shape[-1]).T @ hf
        dh = dq @ p[f'{l}.wq'] + dk @ p[f'{l}.wk'] + dv @ p[f'{l}.wv']
        dxn, g[f'{l}.att_norm'] = rms_back(dh, x0, p[f'{l}.att_norm'], r1)
        dx = dx1 + dxn
    np.add.at(g['emb'], idx.reshape(-1), dx.reshape(-1, D))
    return float(loss), g


def gradcheck():
    rng = np.random.default_rng(0)
    cfg = dict(dim=16, hidden_dim=24, n_layers=2, n_heads=4, n_kv_heads=2, vocab_size=40, max_seq_len=8)
    p = {k: v.astype(np.float64) * 10 for k, v in init_params(cfg, rng).items()}
    for k in p:
        if 'norm' in k:
            p[k] = 1 + rng.standard_normal(p[k].shape) * 0.3
    idx = rng.integers(0, 40, (2, 7)); tgt = rng.integers(0, 40, (2, 7))
    _, g = forward_backward(p, cfg, idx, tgt)
    worst = 0
    for k in p:
        flat = p[k].reshape(-1)
        for i in rng.choice(flat.size, min(6, flat.size), replace=False):
            old = flat[i]
            flat[i] = old + 1e-6; lp, _ = forward_backward(p, cfg, idx, tgt, False)
            flat[i] = old - 1e-6; lm, _ = forward_backward(p, cfg, idx, tgt, False)
            flat[i] = old
            num = (lp - lm) / 2e-6
            ana = g[k].reshape(-1)[i]
            err = abs(num - ana) / max(1e-8, abs(num) + abs(ana))
            worst = max(worst, err)
            if err > 1e-5:
                print(f'gradcheck FAIL {k}[{i}] numeric {num:.8g} analytic {ana:.8g}')
                sys.exit(1)
    print(f'gradcheck ok (worst relative error {worst:.2e})')


def write_llama2c(path, p, cfg):
    D, L, V, T = cfg['dim'], cfg['n_layers'], cfg['vocab_size'], cfg['max_seq_len']
    hd = D // cfg['n_heads']
    with open(path, 'wb') as f:
        f.write(struct.pack('<7i', D, cfg['hidden_dim'], L, cfg['n_heads'], cfg['n_kv_heads'], V, T))  # V > 0: shared classifier
        w = lambda a: f.write(np.ascontiguousarray(a, dtype='<f4').tobytes())
        w(p['emb'])
        for name in ['att_norm', 'wq', 'wk', 'wv', 'wo', 'ffn_norm', 'w1', 'w2', 'w3']:
            for l in range(L):
                w(p[f'{l}.{name}'])
        w(p['norm'])
        c, s = rope_tables(T, hd, np.float32)  # legacy freq_cis_real / imag (run.c skips them)
        w(c); w(s)


def generate(p, cfg, tok, prompt, n):
    ids = [BOS] + tok.encode(prompt)
    for _ in range(n):
        ctx = np.array([ids[-cfg['max_seq_len']:]])
        B, T = ctx.shape
        # cheap: full forward each step (only for the training log)
        D = cfg['dim']
        logits = None
        x = p['emb'][ctx]
        hd = D // cfg['n_heads']; rep = cfg['n_heads'] // cfg['n_kv_heads']
        c, s = rope_tables(T, hd, np.float32)
        mask = np.triu(np.full((T, T), -np.inf, dtype=np.float32), 1)
        for l in range(cfg['n_layers']):
            h, _ = rms(x, p[f'{l}.att_norm'])
            q = rope((h @ p[f'{l}.wq'].T).reshape(B, T, cfg['n_heads'], hd), c, s).transpose(0, 2, 1, 3)
            k = np.repeat(rope((h @ p[f'{l}.wk'].T).reshape(B, T, -1, hd), c, s).transpose(0, 2, 1, 3), rep, 1)
            v = np.repeat((h @ p[f'{l}.wv'].T).reshape(B, T, -1, hd).transpose(0, 2, 1, 3), rep, 1)
            S = q @ k.transpose(0, 1, 3, 2) / math.sqrt(hd) + mask
            P = np.exp(S - S.max(-1, keepdims=True)); P /= P.sum(-1, keepdims=True)
            x = x + (P @ v).transpose(0, 2, 1, 3).reshape(B, T, D) @ p[f'{l}.wo'].T
            h2, _ = rms(x, p[f'{l}.ffn_norm'])
            a = h2 @ p[f'{l}.w1'].T
            x = x + (a * sigmoid(a) * (h2 @ p[f'{l}.w3'].T)) @ p[f'{l}.w2'].T
        xf, _ = rms(x, p['norm'])
        logits = xf[0, -1] @ p['emb'].T
        ids.append(int(np.argmax(logits)))
    return tok.decode(ids[1:])


def read_llama2c(model_path, tok_path):
    """A llama2.c legacy checkpoint + tokenizer.bin -> (params in this file's layout, cfg, Tokenizer)."""
    raw = open(model_path, 'rb').read()
    D, F, L, H, KV, V, T = struct.unpack('<7i', raw[:28])
    shared = V > 0; V = abs(V)
    a = np.frombuffer(raw, dtype='<f4', offset=28).astype(np.float64)
    hd = D // H; KVD = KV * hd
    o = 0
    def take(*shape):
        nonlocal o
        n = int(np.prod(shape)); r = a[o:o + n].reshape(shape); o += n; return r
    p = {'emb': take(V, D)}
    for name, shape in [('att_norm', (D,)), ('wq', (D, D)), ('wk', (KVD, D)), ('wv', (KVD, D)), ('wo', (D, D)),
                        ('ffn_norm', (D,)), ('w1', (F, D)), ('w2', (D, F)), ('w3', (F, D))]:
        for l in range(L):
            p[f'{l}.{name}'] = take(*shape)
    p['norm'] = take(D)
    o += T * hd  # freq_cis
    p['cls'] = p['emb'] if shared else take(V, D)
    assert o == a.size, 'trailing data'
    cfg = dict(dim=D, hidden_dim=F, n_layers=L, n_heads=H, n_kv_heads=KV, vocab_size=V, max_seq_len=T)
    tb = open(tok_path, 'rb').read()
    i = 4; vocab, scores = [], []
    for _ in range(V):
        s, n = struct.unpack('<fi', tb[i:i + 8]); vocab.append(tb[i + 8:i + 8 + n]); scores.append(s); i += 8 + n
    return p, cfg, vocab, scores


def encode_llama2c(vocab, scores, text):
    """run.c encode() over the whole text (bytes pieces), BOS first."""
    index = {}
    for i, b in enumerate(vocab):
        index.setdefault(b, i)
    src = text.encode('utf-8')
    toks = [index[b' ']] if src else []
    i = 0
    while i < len(src):
        j = i + 1
        while j < len(src) and (src[j] & 0xC0) == 0x80 and j - i < 4:
            j += 1
        if src[i:j] in index:
            toks.append(index[src[i:j]])
        else:
            toks.extend(b + 3 for b in src[i:j])
        i = j
    while True:
        best, bid, bat = -1e10, -1, -1
        for k in range(len(toks) - 1):
            m = index.get(vocab[toks[k]] + vocab[toks[k + 1]])
            if m is not None and scores[m] > best:
                best, bid, bat = scores[m], m, k
        if bat < 0:
            break
        toks[bat:bat + 2] = [bid]
    return [BOS] + toks


def reference(model_path, tok_path, steps, prompts):
    """Greedy decoding with an independent float64 numpy forward (no KV cache), as JSON for test/llm.test.js."""
    p, cfg, vocab, scores = read_llama2c(model_path, tok_path)
    D, H = cfg['dim'], cfg['n_heads']
    hd, rep = D // H, H // cfg['n_kv_heads']
    def logits_of(ids):
        T = len(ids)
        x = p['emb'][np.array(ids)][None]
        c, s = rope_tables(T, hd, np.float64)
        mask = np.triu(np.full((T, T), -np.inf), 1)
        for l in range(cfg['n_layers']):
            h, _ = rms(x, p[f'{l}.att_norm'])
            q = rope((h @ p[f'{l}.wq'].T).reshape(1, T, H, hd), c, s).transpose(0, 2, 1, 3)
            k = np.repeat(rope((h @ p[f'{l}.wk'].T).reshape(1, T, -1, hd), c, s).transpose(0, 2, 1, 3), rep, 1)
            v = np.repeat((h @ p[f'{l}.wv'].T).reshape(1, T, -1, hd).transpose(0, 2, 1, 3), rep, 1)
            S = q @ k.transpose(0, 1, 3, 2) / math.sqrt(hd) + mask
            P = np.exp(S - S.max(-1, keepdims=True)); P /= P.sum(-1, keepdims=True)
            x = x + (P @ v).transpose(0, 2, 1, 3).reshape(1, T, D) @ p[f'{l}.wo'].T
            h2, _ = rms(x, p[f'{l}.ffn_norm'])
            a = h2 @ p[f'{l}.w1'].T
            x = x + (a * sigmoid(a) * (h2 @ p[f'{l}.w3'].T)) @ p[f'{l}.w2'].T
        xf, _ = rms(x, p['norm'])
        return xf[0, -1] @ p['cls'].T
    cases = []
    for prompt in prompts:
        ids = encode_llama2c(vocab, scores, prompt)
        n = len(ids)
        out = []
        while len(out) < steps and len(ids) < cfg['max_seq_len']:
            lg = logits_of(ids)
            nxt = int(np.argmax(lg))
            srt = np.sort(lg)
            out.append(dict(pos=len(ids) - 1, next=nxt, max=float(lg[nxt]), margin=float(srt[-1] - srt[-2]), head=[float(v) for v in lg[:8]]))
            ids.append(nxt)
        cases.append(dict(prompt=prompt, tokens=ids[:n], steps=out))
    print(json.dumps(dict(config=[cfg[k] for k in ['dim', 'hidden_dim', 'n_layers', 'n_heads', 'n_kv_heads', 'vocab_size', 'max_seq_len']], cases=cases)))


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--reference':
        # --reference model.bin tokenizer.bin steps prompt...
        reference(sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5:])
        return
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=None)
    ap.add_argument('--root', default=os.path.join(os.path.dirname(__file__), '..', '..', '..'))
    ap.add_argument('--steps', type=int, default=3000)
    ap.add_argument('--batch', type=int, default=8)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--lr', type=float, default=2e-3)
    ap.add_argument('--gradcheck', action='store_true')
    a = ap.parse_args()
    if a.gradcheck:
        gradcheck(); return
    if not a.out:
        ap.error('--out is required')
    os.makedirs(a.out, exist_ok=True)
    cfg = dict(dim=64, hidden_dim=172, n_layers=6, n_heads=8, n_kv_heads=4, vocab_size=1024, max_seq_len=256)
    files, paras = corpus_paragraphs(os.path.abspath(a.root))
    print(f'corpus: {len(files)} files, {len(paras)} paragraphs, {sum(map(len, paras))} chars', flush=True)
    vocab, scores = train_bpe(paras, cfg['vocab_size'])
    cfg['vocab_size'] = len(vocab)
    tok = Tokenizer(vocab, scores)
    rng = np.random.default_rng(a.seed)
    order = rng.permutation(len(paras))
    nval = max(20, len(paras) // 50)
    stream = lambda ids: np.array([t for i in ids for t in [BOS] + tok.encode(paras[i])], dtype=np.int64)
    val, train = stream(order[:nval]), stream(order[nval:])
    print(f'tokens: train {len(train)}, val {len(val)}, vocab {len(vocab)}', flush=True)
    p = init_params(cfg, rng)
    m = {k: np.zeros_like(v) for k, v in p.items()}
    vv = {k: np.zeros_like(v) for k, v in p.items()}
    T = cfg['max_seq_len']
    nparam = sum(v.size for v in p.values())
    print(f'params: {nparam}', flush=True)
    t0 = time.time()

    def batch(data, n):
        ix = rng.integers(0, len(data) - T - 1, n)
        return np.stack([data[i:i + T] for i in ix]), np.stack([data[i + 1:i + T + 1] for i in ix])

    def val_loss():
        vr = np.random.default_rng(123)
        tot = 0
        for _ in range(8):
            ix = vr.integers(0, len(val) - T - 1, 16)
            x = np.stack([val[i:i + T] for i in ix]); y = np.stack([val[i + 1:i + T + 1] for i in ix])
            tot += forward_backward(p, cfg, x, y, False)[0]
        return tot / 8

    warm = 100
    for step in range(1, a.steps + 1):
        lr = a.lr * min(1, step / warm) * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * min(1, step / a.steps))))
        x, y = batch(train, a.batch)
        loss, g = forward_backward(p, cfg, x, y)
        gn = math.sqrt(sum(float((gg * gg).sum()) for gg in g.values()))
        clip = min(1.0, 1.0 / (gn + 1e-6))
        for k in p:
            gk = g[k] * clip
            m[k] = 0.9 * m[k] + 0.1 * gk
            vv[k] = 0.95 * vv[k] + 0.05 * gk * gk
            mh = m[k] / (1 - 0.9 ** step); vh = vv[k] / (1 - 0.95 ** step)
            if p[k].ndim == 2:
                p[k] *= (1 - lr * 0.1)
            p[k] -= (lr * mh / (np.sqrt(vh) + 1e-8)).astype(np.float32)
        if step % 100 == 0 or step == 1:
            print(f'step {step} loss {loss:.4f} lr {lr:.2e} {time.time() - t0:.0f}s', flush=True)
        if step % 500 == 0 or step == a.steps:
            print(f'  val loss {val_loss():.4f} | {generate(p, cfg, tok, "The browser", 30)!r}', flush=True)
    write_llama2c(os.path.join(a.out, 'model.bin'), p, cfg)
    write_tokenizer(os.path.join(a.out, 'tokenizer.bin'), vocab, scores)
    info = dict(config=cfg, params=nparam, steps=a.steps, batch=a.batch, seed=a.seed, lr=a.lr, val_loss=val_loss(),
                train_tokens=int(len(train)), corpus_files=len(files), corpus_paragraphs=len(paras), numpy=np.__version__,
                seconds=round(time.time() - t0))
    json.dump(info, open(os.path.join(a.out, 'train.json'), 'w'), indent=1)
    print(json.dumps(info), flush=True)


if __name__ == '__main__':
    main()
