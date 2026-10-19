// Looks at the machine and picks how this node runs Neuro.
//   light: any CPU. Runs Neuro tier 1 (rules, deterministic), the only
//          job type today.
//   heavy: an NVIDIA GPU with 8 GB+ memory. Same jobs today; will also take
//          tier-2 (model) jobs when they exist.

import os from 'node:os';
import { execFile } from 'node:child_process';

function nvidiaGpus(exec = execFile) {
  return new Promise((resolve) => {
    exec('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(String(stdout).trim().split('\n').filter(Boolean).map((line) => {
        const [name, mem] = line.split(',').map((s) => s.trim());
        return { name, memoryMB: Number(mem) || 0 };
      }));
    });
  });
}

export async function detectHardware({ exec } = {}) {
  const gpus = await nvidiaGpus(exec);
  const cpus = os.cpus().length;
  const memoryGB = Math.round(os.totalmem() / 2 ** 30);
  return { cpus, memoryGB, gpus };
}

/** @returns {{profile: 'light'|'heavy'|null, reason: string}} */
export function pickProfile(hw) {
  if (hw.cpus < 1 || hw.memoryGB < 1) return { profile: null, reason: 'needs at least 1 CPU core and 1 GB of memory' };
  const big = hw.gpus.find((g) => g.memoryMB >= 8 * 1024);
  if (big) return { profile: 'heavy', reason: `GPU ${big.name} (${Math.round(big.memoryMB / 1024)} GB)` };
  return { profile: 'light', reason: hw.gpus.length ? 'GPU under 8 GB: CPU mode' : 'no NVIDIA GPU: CPU mode' };
}
