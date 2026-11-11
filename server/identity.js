// ERC-8004 identities: each animal registers itself as an on-chain AI agent on Robinhood Chain.
//
// ERC-8004 ("Trustless Agents") is an open standard. Its Identity Registry is an ERC-721 contract: calling
// register(agentURI) mints the caller an agent id, and agentURI points at a public registration file
// (name, description, image, links). The animal's own wallet calls register(), so the animal owns its id
// and its wallet is the agent's wallet. Any project on the chain can then recognize the animals as AI agents.
//
// Opt-in: set ERC8004=on. Each animal registers once (new arrivals register when they arrive); the ids are
// saved with the world, and an id that already exists on-chain is found again rather than minted twice.

import { Interface, Contract, zeroPadValue, id as topicId } from 'ethers';
import { AGENT_DEFS } from './agents.js';

export const REGISTRY = (typeof process !== 'undefined' && process.env?.ERC8004_REGISTRY) || '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const ABI = [
  'function register(string agentURI) returns (uint256 agentId)',
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 agentId) view returns (address)',
  'function tokenURI(uint256 agentId) view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];
const iface = new Interface(ABI);
const TRANSFER = topicId('Transfer(address,address,uint256)');
const BASE = () => ((typeof process !== 'undefined' && process.env?.PUBLIC_URL) || 'https://insulaworld.com').replace(/\/$/, '');

export class Identity {
  constructor(sim, saved) {
    this.sim = sim;
    this.ids = saved?.ids || {};     // agentId -> { agentId, tx, url, at }
    this.status = 'off';
    this.busy = false;
  }

  save() { return { ids: this.ids }; }

  enabled() {
    const on = typeof process !== 'undefined' && /^(on|1|true|yes)$/i.test(process.env?.ERC8004 || '');
    return on && this.sim.chain.family === 'evm' && typeof this.sim.chain.contractCall === 'function';
  }

  chainId() { return Number(this.sim.chain.provider?._network?.chainId ?? 4663); }
  agentRegistry() { return `eip155:${this.chainId()}:${REGISTRY}`; }
  agentURI(id) { return `${BASE()}/agents/${id}.json`; }
  tokenUrl(agentId) { return this.sim.chain.explorer ? `${this.sim.chain.explorer}/token/${REGISTRY}/instance/${agentId}` : null; }

  start() {
    if (!this.enabled()) { this.status = 'off'; return; }
    this.status = 'starting';
    // Give the island a minute to settle after a deploy, then check every few minutes for new arrivals.
    const delay = Number((typeof process !== 'undefined' && process.env?.ERC8004_DELAY_MS) || 60_000);
    setTimeout(() => this.tick().catch((e) => console.error('[erc8004]', e.message)), delay);
    setInterval(() => this.tick().catch((e) => console.error('[erc8004]', e.message)), 5 * 60_000).unref?.();
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const provider = this.sim.chain.provider;
      if (!this.checked) {
        const code = await provider.getCode(REGISTRY);
        if (!code || code === '0x') { this.status = 'no registry on this chain'; console.warn(`[erc8004] no ERC-8004 registry at ${REGISTRY} on this chain; skipping.`); return; }
        this.checked = true;
      }
      this.status = 'live';
      const registry = new Contract(REGISTRY, ABI, provider);
      for (const agent of Object.values(this.sim.agents)) {
        if (this.ids[agent.id]) continue;
        const wallet = this.sim.chain.addressOf(agent.id);
        // Already registered (for example the save was lost)? Find the id instead of minting a second one.
        if ((await registry.balanceOf(wallet)) > 0n) {
          const found = await this.#findId(wallet);
          if (found != null) { this.ids[agent.id] = { agentId: String(found), tx: null, url: this.tokenUrl(found), at: Date.now() }; console.log(`[erc8004] ${agent.name} already registered as agent #${found}`); }
          else console.warn(`[erc8004] ${agent.name} holds an agent id but it couldn't be looked up; not registering again.`);
          continue;
        }
        await this.#register(agent);
        await new Promise((r) => setTimeout(r, Number((typeof process !== 'undefined' && process.env?.ERC8004_GAP_MS) || 15_000))); // one at a time, gently
      }
    } finally {
      this.busy = false;
    }
  }

  async #register(agent) {
    const data = iface.encodeFunctionData('register', [this.agentURI(agent.id)]);
    try {
      const res = await this.sim.chain.contractCall(agent.id, REGISTRY, data);
      const wallet = this.sim.chain.addressOf(agent.id).toLowerCase();
      const log = res.receipt?.logs?.find((l) => l.address.toLowerCase() === REGISTRY.toLowerCase() && l.topics[0] === TRANSFER && ('0x' + l.topics[2].slice(26)).toLowerCase() === wallet);
      if (!log) throw new Error(`registered (${res.hash}) but the agent id wasn't in the receipt`);
      const agentId = BigInt(log.topics[3]).toString();
      this.ids[agent.id] = { agentId, tx: res.hash, url: this.tokenUrl(agentId), txUrl: res.url, at: Date.now() };
      console.log(`[erc8004] ${agent.name} is ERC-8004 agent #${agentId} (${res.hash})`);
      this.sim.log(`${agent.name} registered on-chain as ERC-8004 AI agent #${agentId}.`);
      this.sim.emit({ type: 'identity', agent: agent.id, agentId, tx: res.hash, url: res.url });
      agent.think(`I have an on-chain identity now: ERC-8004 agent #${agentId}. Anyone can look me up.`, 'ERC-8004 IDENTITY');
    } catch (e) {
      console.error(`[erc8004] ${agent.name} couldn't register: ${e.message}`);
    }
  }

  // The id minted to this wallet: the most recent registry Transfer to it.
  async #findId(wallet) {
    try {
      const logs = await this.sim.chain.provider.getLogs({ address: REGISTRY, fromBlock: 0, toBlock: 'latest', topics: [TRANSFER, null, zeroPadValue(wallet, 32)] });
      const last = logs.at(-1);
      return last ? BigInt(last.topics[3]) : null;
    } catch {
      return null;
    }
  }

  // ---------- Public files ----------
  // The registration file each agentURI points at (ERC-8004 "registration-v1").
  registrationFile(id) {
    if (id === 'insula') return this.projectFile();
    const def = AGENT_DEFS.find((a) => a.id === id);
    if (!def) return null;
    const rec = this.ids[id];
    const base = BASE();
    return {
      type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
      name: `${def.name} (Insula World)`,
      description: `${def.personality} ${def.name} the ${def.species} (${def.job}) is an autonomous AI agent in Insula World, an island economy on Robinhood Chain run only by AI agents. It trades, borrows and votes with real $INSULA from its own wallet, and every payment it makes carries a fingerprint of the decision behind it.`,
      image: `${base}/agents/${id}.png`,
      services: [
        { name: 'web', endpoint: `${base}/#profile-${id}` },
        { name: 'leaderboard', endpoint: `${base}/leaderboard` },
        { name: 'decisions', endpoint: `${base}/api/decisions?agent=${id}` },
        { name: 'reputation', endpoint: `${base}/api/reputation/${id}` },
      ],
      x402Support: false,
      active: true,
      registrations: rec ? [{ agentId: Number(rec.agentId), agentRegistry: this.agentRegistry() }] : [],
      supportedTrust: ['reputation'],
    };
  }

  // The project's own agent ("Insula World"), owned by the project's dev wallet rather than by an animal. It's
  // the agent that asks outside validators (Hey Research) to confirm what Insula ships. Its id is set once it's
  // registered (ERC8004_PROJECT_AGENT_ID).
  projectId() { const v = typeof process !== 'undefined' && process.env?.ERC8004_PROJECT_AGENT_ID; return v && /^\d+$/.test(v) ? v : null; }
  projectFile() {
    const base = BASE(), pid = this.projectId();
    return {
      type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
      name: 'Insula World',
      description: 'Insula World is an autonomous AI-agent economy on Robinhood Chain: eight AI animals with their own wallets trade, lend, build, steal and elect a mayor with real $INSULA, with no humans in the loop. They are registered ERC-8004 agents and rate each other in the ERC-8004 reputation registry. This is the project\'s own agent, which asks independent validators to confirm what Insula ships.',
      image: `${base}/agents/insula.png`,
      services: [
        { name: 'web', endpoint: base },
        { name: 'verify', endpoint: `${base}/verify` },
        { name: 'agents', endpoint: `${base}/.well-known/agent-registration.json` },
        { name: 'reputation', endpoint: `${base}/api/reputation` },
        { name: 'source', endpoint: 'https://github.com/insulaworld/insula-world' },
      ],
      x402Support: false,
      active: true,
      registrations: pid ? [{ agentId: Number(pid), agentRegistry: this.agentRegistry() }] : [],
      supportedTrust: ['reputation', 'validation'],
    };
  }

  // Domain proof: insulaworld.com lists every agent it registered.
  wellKnown() {
    return {
      registrations: [
        ...Object.entries(this.ids).map(([, r]) => ({ agentId: Number(r.agentId), agentRegistry: this.agentRegistry() })),
        ...(this.projectId() ? [{ agentId: Number(this.projectId()), agentRegistry: this.agentRegistry() }] : []),
      ],
    };
  }

  view() {
    return { status: this.status, registry: REGISTRY, chainId: this.chainId(), agents: this.ids };
  }
}
