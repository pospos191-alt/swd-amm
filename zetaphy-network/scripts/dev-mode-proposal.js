#!/usr/bin/env node
// Writes zetaphy-chain/proposals/testnet-dev-mode.json: one gov proposal (owner's request, testnet
// development only) whose two MsgEVMCall messages schedule through the ZetaphyTimelock:
//   1. updateDelay(0): later changes need only a gov vote, no 48 h wait
//   2. ThreatRegistry.setProtected: the bridge contracts and the Sepolia lockbox (call printed by deploy-bridge)
// Both run 48 h after the vote (the timelock's current delay), then anyone executes them.
// Before the bridge opens or any mainnet, the delay goes back to >= 24 h (the bridge gates refuse less).
import { writeFileSync, mkdirSync } from 'node:fs';
import { evmCallProposal } from '../src/timelockcli.js';
import { scheduleData, operationId, TIMELOCK } from '../src/timelock.js';

const TL = '0x731db92410B3b15Ae4b6b41E47fc3c9a66390340';
const REG = '0xaB5745b61f83975E68F6546be9F83651df12417f';
// from the bridge-testnet deploy log (run 39899940513)
const PROTECT = '0xbd54a93100000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000b3c375f1044a55533b3c49c1b69ff3da0f0673d3f64e4f1ab0672ec5e013170d35d2579b6e2584e08295e4c39c22364d176092af76fd92c763f581e3984a27fd9233810cf9fa9d9fcd1eac7cd654ca45ce2e4f41bd80d21f71f8128b3874d48e3fc39358d2671df3b09208e21d09f10bccea859f5df992e2feb1376ba1bf7b5cab573bae619bd743d9e553e1b306f1cb80396580196dd37e6ae42608e1fca7e4724904e771ceb7d67b61900b2000206c6872ca8c3f7340150381ae0deed53e6780ff99e64f78e1f03e5d4741bde93e750ebffc02461ab1828e8e9f0567757078f8d36c21669592e6f794777214865d3c196361036252be7de575dd7a6006ea7e0aef3f24714f45c6fee6f7926de4476fc974b249e25866bbe2909baafc022dc0ca7de77cf8965b4eee8dfb4c73af301c27e421504d83f437dad83837e4b0b80f4129fb6f10b90e82528ba8658b4a01e3110c96a7a4125b34a25e4249165a03f9c';
const DELAY = 172800n; // the timelock's delay today

const ops = [
  { name: 'updateDelay(0)', target: TL, data: TIMELOCK.encodeFunctionData('updateDelay', [0]) },
  { name: 'ThreatRegistry.setProtected (bridge + lockbox)', target: REG, data: PROTECT },
];
const ids = ops.map((o) => operationId({ target: o.target, data: o.data }));
const p = evmCallProposal({
  to: TL, data: '0x00',
  title: 'Testnet development: timelock delay 48 h -> 0, and protect the bridge in the ThreatRegistry',
  summary: `Schedules two calls through the ZetaphyTimelock ${TL}; they run 48 h after this vote passes and anyone may execute them. `
    + `(1) updateDelay(0): during testnet development changes need only a gov vote; it goes back to >= 24 h before the bridge opens or any mainnet. `
    + `(2) ThreatRegistry ${REG} setProtected: the bridge contracts and the Sepolia lockbox can never be frozen by a runner flag. Operations ${ids.join(', ')}.`,
});
p.messages = ops.map((o) => evmCallProposal({ to: TL, data: scheduleData({ target: o.target, data: o.data, delay: DELAY }), title: '-', summary: '-' }).messages[0]);

const out = new URL('../../zetaphy-chain/proposals/testnet-dev-mode.json', import.meta.url);
mkdirSync(new URL('.', out), { recursive: true });
writeFileSync(out, JSON.stringify(p, null, 2) + '\n');
ops.forEach((o, i) => console.log(`${o.name}\n  operation ${ids[i]}\n  execute: zetaphy timelock execute ${ids[i]} --timelock ${TL} --to ${o.target} --data ${o.data}`));
