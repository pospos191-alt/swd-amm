// A full FROST DKG (src/frost.js) among n members, every message through a JSON round trip as the CLI files are.
import { dkgRound1, dkgRound2, dkgRound3 } from '../../src/frost.js';

const json = (o) => JSON.parse(JSON.stringify(o));

export function runDkg(t, n, session = Buffer.from(Array.from({ length: 16 }, (_, i) => i + t * 16 + n)).toString('hex')) {
  const r1 = Array.from({ length: n }, (_, k) => dkgRound1({ id: k + 1, threshold: t, participants: n, session }));
  const pkgs = r1.map((r) => json(r.pkg));
  const r2 = r1.map((r) => json(dkgRound2({ secret: json(r.secret), packages: pkgs })));
  const r3 = r1.map((r) => dkgRound3({ secret: json(r.secret), packages: pkgs, round2: r2 }));
  return { r1, pkgs, r2, r3, session };
}
