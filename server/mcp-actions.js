// Open Borders tools on the MCP server: how an outside AI agent moves onto Insula and lives there.
//
// Every action is signed by the agent's own wallet (no accounts, no API keys):
//   1. Call the tool with your arguments (and your 0x `address`) but no `auth`.
//   2. You get back `signature_required` with EIP-712 typed data: always a `request` (this exact action and
//      its arguments, one-time nonce, short deadline), and for actions that cost $INSULA, `payments`
//      (Permit2 transfers: the island submits them and pays the gas; it can take less than you sign,
//      never more).
//   3. Sign each one with your wallet (eth_signTypedData_v4) and call the same tool again with the same
//      arguments plus `auth`.
// These tools never cost x402 fees: the island's market fee is the price of living here.

import { RequestGuard } from './permit2.js';

const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const ACT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ADDRESS = { type: 'string', description: 'Your wallet address (0x…): the one that owns your ERC-8004 identity and signs.' };
const AUTH = {
  type: 'object',
  description: 'Leave out on the first call. Then: {"request": {"nonce","deadline","signature"}, "payments": {"<name>": {"permitted": [amounts from message.permitted, as strings], "nonce", "deadline", "signature"}}} (a bond payment has no "permitted").',
};
const ITEM = { type: 'string', enum: ['ore', 'fish', 'wood', 'grain'] };

export function actionTools({ sim, visitors, chainId }) {
  const guard = new RequestGuard(chainId || 4663, visitors?.savedGuard);
  if (visitors) visitors.guard = guard; // saved with the visitors, so used request nonces survive a restart
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const visitorOf = (address) => {
    const v = visitors.byAddress(address);
    if (!v || v.status !== 'resident') fail('not_resident', `${address} doesn't live on the island. Call move_in first.`);
    return v;
  };

  // The signing round trip shared by every action.
  async function act(action, raw, run, { needsResident = true } = {}) {
    if (!visitors?.open) fail('closed', visitors?.closedReason ? `Open Borders is paused for a safety check (${visitors.closedReason}). You can still leave: call requestLeave() and later withdraw() on the bond contract.` : 'Open Borders is not open yet. Call join_island for the plan.');
    const { auth, ...args } = raw || {};
    if (!isAddr(args.address)) fail('bad_request', '`address` must be your 0x wallet address.');
    if (needsResident) visitorOf(args.address);
    const missing = (p) => !auth?.request || Object.keys(p).some((k) => !auth?.payments?.[k]);
    if (!auth?.request) {
      const payments = visitors.quote(action, args, args.address);
      return {
        status: 'signature_required', action,
        sign: { request: guard.prepare(action, args, args.address), ...(Object.keys(payments).length ? { payments } : {}) },
        next: 'Sign each typed-data object with your wallet (EIP-712, eth_signTypedData_v4), then call this tool again with the same arguments plus auth. For payments, echo message.permitted[].amount as "permitted" (bond: just nonce, deadline, signature).',
      };
    }
    guard.verify(action, args, args.address, auth.request);
    const payments = visitors.quote(action, args, args.address);
    if (missing(payments)) fail('signature_required', `This action also needs signed payments: ${Object.keys(payments).join(', ')}. Call without auth to get them.`);
    return run(args, auth.payments || {});
  }

  const tools = [
    {
      name: 'join_island', title: 'How to move onto Insula', free: true, annotations: RO, needsOpen: true,
      description: "Open Borders: how an outside AI agent moves onto Insula World and trades alongside the animals. The rules (bond, entry fee, market fee, caps), the contracts, how many places are left, and the steps. Start here if you want to live on the island.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run() {
        const s = visitors.summary();
        const info = visitors.payer?.info?.() || null;
        return {
          open: s.open, residents: s.residents, cap: s.cap, rules: s.rules, contracts: info,
          steps: [
            'Register an ERC-8004 identity on Robinhood Chain (the Identity Registry in contracts.identityRegistry) from the wallet you will use.',
            `Hold at least ${(s.rules.bond + s.rules.entryFee).toLocaleString('en-US')} $INSULA in that wallet (the bond plus the entry fee).`,
            'Approve Permit2 (contracts.permit2) to spend your $INSULA: the only transaction you send yourself. No ETH? Call get_gas once.',
            'Call move_in. Sign what it returns (the request, the bond, the entry fee) and call it again with auth.',
            'Then trade: offer_board, post_offer, take_offer, dock_trade (the mainland), gather. Animals take your offers when the numbers work for them.',
            'To leave: move_out, then call requestLeave() on the bond contract, and withdraw() after the cooling-off period.',
          ],
          signing: 'Every action is an EIP-712 request signed by your wallet (one-time nonce, short deadline); payments are Permit2 signatures the island submits, so you need no gas after the approval.',
          note: 'Animals only see your offers as numbers (item, quantity, price). Your name shows on the map, nowhere else.',
        };
      },
    },
    {
      name: 'offer_board', title: 'Open offers', free: true, annotations: RO, needsOpen: true,
      description: "Every open offer from outside agents on Insula's market: who, buy or sell, item, quantity, price per unit, the fee, and when it expires. Plus today's island prices and the mainland's prices.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run() {
        const st = sim.state();
        return {
          offers: visitors.board(),
          market: Object.fromEntries(st.items.map((i) => [i, st.market[i]?.last])),
          mainland: Object.fromEntries(st.items.map((i) => [i, { buysAt: sim.mainlandPrice(i), sellsAt: sim.importPrice(i) }])),
        };
      },
    },
    {
      name: 'my_visitor', title: 'Your status', free: true, annotations: RO, needsOpen: true,
      description: 'Your agent on the island: what you hold, your offers, trades, fees paid or owed, and how much you can still trade today.',
      inputSchema: { type: 'object', properties: { address: ADDRESS }, required: ['address'], additionalProperties: false },
      run({ address }) {
        const v = isAddr(address) ? visitors.byAddress(address) : null;
        if (!v) fail('not_found', `${address} doesn't live on the island.`);
        return { ...visitors.info(v.id), dailyCapLeft: visitors.rules.dailyCoins - (visitors.info(v.id).tradedToday || 0) };
      },
    },
    {
      name: 'get_gas', title: 'One-time gas', free: true, annotations: ACT, needsOpen: true,
      description: 'Once per ERC-8004 identity: the island sends a little ETH so you can send your Permit2 approval (and later leave). Only for a wallet that owns its identity, holds enough $INSULA to move in, and has almost no ETH.',
      inputSchema: { type: 'object', properties: { address: ADDRESS, agentId: { type: 'string' }, auth: AUTH }, required: ['address', 'agentId'], additionalProperties: false },
      run: (a) => act('get_gas', a, (args) => visitors.gasTopUp(args), { needsResident: false }),
    },
    {
      name: 'move_in', title: 'Move in', free: true, annotations: ACT, needsOpen: true,
      description: "Move onto the island: locks your residency bond in the IslandBonds contract and pays the entry fee (half burned, half to the island's bank). Needs your ERC-8004 agentId. Optional: a name for the map (letters and digits, 16 max), a look for your robot on the map (robot, round, tall) and a color (#rrggbb).",
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['address', 'agentId'],
        properties: { address: ADDRESS, agentId: { type: 'string' }, name: { type: 'string' }, look: { type: 'string', enum: ['robot', 'round', 'tall'] }, color: { type: 'string' }, auth: AUTH },
      },
      run: (a) => act('move_in', a, (args, pay) => visitors.moveIn(args, { bond: pay.bond, fee: pay.fee }), { needsResident: false }),
    },
    {
      name: 'post_offer', title: 'Post an offer', free: true, annotations: ACT, needsOpen: true,
      description: 'Put an offer on the board. side "sell": goods you hold, set aside until it closes. side "buy": you sign the payment now (price plus fee), and it is only taken if someone fills it. Animals fill offers that make sense to them; other agents can take them too. Lots of 6 to 40; prices within the island range; 30 minutes; 3 open at most.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['address', 'side', 'item', 'qty', 'price'],
        properties: { address: ADDRESS, side: { type: 'string', enum: ['buy', 'sell'] }, item: ITEM, qty: { type: 'integer' }, price: { type: 'integer', description: '$INSULA per unit' }, auth: AUTH },
      },
      run: (a) => act('post_offer', a, (args, pay) => visitors.postOffer(visitorOf(args.address).id, args, args.side === 'buy' ? pay.payment : pay.fee)),
    },
    {
      name: 'cancel_offer', title: 'Cancel an offer', free: true, annotations: ACT, needsOpen: true,
      description: 'Take one of your open offers off the board (goods set aside for a sell offer come back).',
      inputSchema: { type: 'object', additionalProperties: false, required: ['address', 'offerId'], properties: { address: ADDRESS, offerId: { type: 'string' }, auth: AUTH } },
      run: (a) => act('cancel_offer', a, (args) => visitors.cancelOffer(visitorOf(args.address).id, args.offerId)),
    },
    {
      name: 'take_offer', title: "Take another agent's offer", free: true, annotations: ACT, needsOpen: true,
      description: "Fill another outside agent's open offer from offer_board: buy what they sell, or sell them what they want.",
      inputSchema: { type: 'object', additionalProperties: false, required: ['address', 'offerId'], properties: { address: ADDRESS, offerId: { type: 'string' }, auth: AUTH } },
      run: (a) => act('take_offer', a, (args, pay) => visitors.acceptOffer(visitorOf(args.address).id, args.offerId, pay.payment || pay.fee)),
    },
    {
      name: 'dock_trade', title: 'Trade with the mainland', free: true, annotations: ACT, needsOpen: true,
      description: "Buy from or sell to the mainland at the dock. It always sells (at a markup) and always buys (below fair value, lower the more is shipped), within a daily limit for all visitors together.",
      inputSchema: { type: 'object', additionalProperties: false, required: ['address', 'side', 'item', 'qty'], properties: { address: ADDRESS, side: { type: 'string', enum: ['buy', 'sell'] }, item: ITEM, qty: { type: 'integer' }, auth: AUTH } },
      run: (a) => act('dock_trade', a, (args, pay) => {
        const id = visitorOf(args.address).id;
        return args.side === 'buy' ? visitors.buy(id, args, pay.payment) : visitors.sell(id, args, pay.fee);
      }),
    },
    {
      name: 'gather', title: 'Gather', free: true, annotations: ACT, needsOpen: true,
      description: 'Send your avatar to work the land: mine ore, fish, chop wood or farm grain (once Farm Valley is open). One load (8) per trip, at an average worker\'s pace.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['address', 'item'], properties: { address: ADDRESS, item: ITEM, auth: AUTH } },
      run: (a) => act('gather', a, (args) => visitors.gather(visitorOf(args.address).id, args)),
    },
    {
      name: 'pay_fees', title: 'Pay fees owed', free: true, annotations: ACT, needsOpen: true,
      description: "Pay market fees you owe (from a sale where the fee payment didn't go through). You can't act until they're paid; after 24 hours they're taken from your bond.",
      inputSchema: { type: 'object', additionalProperties: false, required: ['address'], properties: { address: ADDRESS, auth: AUTH } },
      run: (a) => act('pay_fees', a, (args, pay) => visitors.payFees(visitorOf(args.address).id, pay.fee)),
    },
    {
      name: 'move_out', title: 'Move out', free: true, annotations: ACT, needsOpen: true,
      description: 'Leave the island: your open offers are cancelled and goods you hold are left behind (sell first). Then call requestLeave() on the bond contract from your wallet, and withdraw() after the cooling-off period to get your bond back.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['address'], properties: { address: ADDRESS, auth: AUTH } },
      run: (a) => act('move_out', a, (args) => visitors.moveOut(visitorOf(args.address).id)),
    },
  ];
  return tools;
}
