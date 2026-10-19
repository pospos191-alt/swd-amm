// The runner's own key, made on its machine and never sent anywhere.
// Testnet only: stored as a 0600 file under ~/.zetaphy/. Never put a key
// that holds real funds here.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { Wallet } from 'ethers';

export const HOME = process.env.ZETAPHY_HOME ?? join(os.homedir(), '.zetaphy');

export function loadOrCreateKey(file = join(HOME, 'worker.key')) {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const w = Wallet.createRandom();
    writeFileSync(file, w.privateKey + '\n', { mode: 0o600 });
    return { wallet: new Wallet(w.privateKey), created: true, file };
  }
  if (process.platform !== 'win32' && (statSync(file).mode & 0o077)) chmodSync(file, 0o600);
  const hex = readFileSync(file, 'utf8').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${file} is not a key file`);
  return { wallet: new Wallet(hex), created: false, file };
}
