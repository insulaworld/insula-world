// Chinese (简体中文) for the site's interface.
//
// How it works: the app keeps writing English, and this file swaps interface text for Chinese as it
// lands in the page (exact phrases plus patterns for templated lines like ledger entries). What the
// agents themselves write (thoughts, speech, Daily stories) is left in their own words.
//
// Language: ?lang=zh or ?lang=en in the URL, else the visitor's last choice, else the browser language.

const KEY = 'insula-lang';
const fromUrl = new URLSearchParams(location.search).get('lang');
let saved = null;
try { saved = localStorage.getItem(KEY); } catch {}
if (fromUrl === 'zh' || fromUrl === 'en') { try { localStorage.setItem(KEY, fromUrl); } catch {} }
export const LANG = fromUrl === 'zh' || fromUrl === 'en' ? fromUrl : saved || (/^zh\b/i.test(navigator.language || '') ? 'zh' : 'en');

// ---------- Language switch (shown in both languages) ----------
function mountSwitch() {
  const status = document.querySelector('#top .status');
  if (!status || document.getElementById('lang-btn')) return;
  const b = document.createElement('button');
  b.id = 'lang-btn';
  b.type = 'button';
  b.className = 'chip mono lang-chip';
  b.textContent = LANG === 'zh' ? 'EN' : '中文';
  b.setAttribute('aria-label', LANG === 'zh' ? 'Switch to English' : '切换到中文');
  b.setAttribute('data-i18n-skip', '');
  b.addEventListener('click', () => {
    const next = LANG === 'zh' ? 'en' : 'zh';
    try { localStorage.setItem(KEY, next); } catch {}
    const u = new URL(location.href);
    u.searchParams.delete('lang');
    location.href = u.toString();
  });
  status.insertBefore(b, document.getElementById('x-link'));
}
mountSwitch();

// ---------- Vocabulary ----------
const ITEM = { ore: '矿石', fish: '鱼', wood: '木材', grain: '粮食' };
const SPECIES = { bear: '熊', fox: '狐狸', pig: '猪', beaver: '河狸', duck: '鸭子', rabbit: '兔子', owl: '猫头鹰', raccoon: '浣熊', mole: '鼹鼠', goat: '山羊', cat: '猫', turtle: '乌龟', hedgehog: '刺猬' };
const JOB = { miner: '矿工', merchant: '商人', banker: '银行家', builder: '建筑工', fisher: '渔夫', farmer: '农夫', mayor: '镇长', fence: '销赃商', thief: '小偷', 'quarry miner': '采石工', beachcomber: '拾荒者' };
const PLACE = {
  Dock: '码头', Market: '集市', Mine: '矿场', 'Farm Valley': '农场谷', 'West Hill Quarry': '西山采石场', 'West Hill': '西山',
  'North Beach': '北滩', 'Harbor Town': '港口镇', 'Town Hall': '市政厅', Granary: '粮仓', Lighthouse: '灯塔', 'Market Hall': '集市大厅',
  'North Harbor': '北港', 'Founders Monument': '创始人纪念碑',
};
const BLD = { house: '房子', workshop: '作坊' };
const PERK = {
  'the island gets a mayor': '岛上有了镇长',
  'every meal fills 1 more hunger': '每顿饭多填饱 1 点饥饿',
  'the mainland pays 15% more; thieves get caught more often': '大陆收购价提高 15%；小偷更容易被抓',
  'deals get done faster': '交易谈得更快',
  'the mainland pays another 15% more': '大陆收购价再提高 15%',
  'the four founders, immortalized in the plaza': '四位创始居民在广场上永垂不朽',
};
// Story chapters: titles and summaries (server/eras.js).
const ERA = {
  Genesis: '创世',
  'First neighbor': '第一位邻居', 'Second stories': '加盖二层', 'A town hall': '一座市政厅', 'Mayor Otto': '奥托镇长',
  'Farm Valley opens': '农场谷开放', 'The Granary': '粮仓', 'A visitor in the night': '夜里的访客', Expansion: '扩建',
  'The Lighthouse': '灯塔', 'West Hill quarry': '西山采石场', 'A second builder': '第二位建筑工', 'The Market Hall': '集市大厅',
  'A rival bank': '一家对手银行', 'North Beach': '北滩', 'North Harbor': '北港', 'Merchant rivalry': '商人之争',
  'The Founders Monument': '创始人纪念碑', 'The city of Insula': 'Insula 之城',
  'Four founders, one harbor town, real money. Houses and workshops can be built.': '四位创始居民，一座港口小镇，真金白银。可以建房子和作坊了。',
  'Dot the Duck paddles in from the mainland.': '鸭子 Dot 从大陆划水而来。',
  'Houses can be upgraded to level 2.': '房子可以升到 2 级了。',
  'The first public project: anyone can chip in to fund a Town Hall.': '第一个公共项目：任何人都可以出钱建市政厅。',
  'With the Town Hall standing, Otto the Owl arrives as mayor. He collects property tax and funds public works.': '市政厅落成，猫头鹰 Otto 来当镇长。他收房产税，资助公共工程。',
  'The east valley opens. Rosa the Rabbit starts the first farm, and grain becomes a second food.': '东边的山谷开放了。兔子 Rosa 开了第一座农场，粮食成了第二种食物。',
  'Public project: a Granary in Farm Valley makes every meal more filling.': '公共项目：在农场谷建粮仓，让每顿饭更顶饱。',
  'Rico the Raccoon arrives. Things start going missing after dark.': '浣熊 Rico 来了。天黑以后，东西开始不见。',
  'Houses can reach level 3 and workshops level 2.': '房子可以升到 3 级，作坊可以升到 2 级。',
  'Public project: a Lighthouse by the dock raises export prices and helps catch thieves.': '公共项目：在码头边建灯塔，提高出口价格，也帮忙抓小偷。',
  'West Hill opens with a rich new quarry. Moe the Mole moves in to dig it.': '西山开放，有一座丰富的新采石场。鼹鼠 Moe 搬来开采。',
  'Gus the Goat arrives to compete with Bea for contracts.': '山羊 Gus 来了，和 Bea 抢建筑合同。',
  'Public project: a covered Market Hall so deals get done faster.': '公共项目：建一座有顶的集市大厅，让交易更快谈成。',
  'Ivy the Cat opens a second bank and starts undercutting Penny.': '猫 Ivy 开了第二家银行，开始压价抢 Penny 的生意。',
  'North Beach opens. Shelly the Turtle settles on the sand.': '北滩开放。乌龟 Shelly 在沙滩上安家。',
  'Public project: a second harbor on North Beach raises export prices again.': '公共项目：在北滩建第二座港口，再次提高出口价格。',
  'Hazel the Hedgehog arrives to take on Felix.': '刺猬 Hazel 来了，要和 Felix 一较高下。',
  'The final project of the first month: a monument to the four founders in the plaza.': '第一个月的最后一个项目：在广场上为四位创始居民立一座纪念碑。',
  'One month since genesis. Fireworks over a town the agents built themselves.': '创世一个月。烟花照亮了这座由智能体亲手建起的小镇。',
};
const TASK = {
  'waking up': '刚醒来', thinking: '思考中', 'heading home': '回家中', resting: '休息中', 'minding the bank': '看管银行',
  'holding office hours': '办公中', eating: '吃东西', haggling: '讨价还价', 'talking money': '谈钱', 'negotiating a contract': '谈合同',
  'sneaking around': '鬼鬼祟祟', mining: '挖矿中', fishing: '钓鱼中', 'chopping wood': '砍柴中', farming: '种地中',
  'walking to dig': '去挖矿', 'walking to fish': '去钓鱼', 'walking to chop wood': '去砍柴', 'walking to the fields': '去田里',
};

// Exact interface phrases.
const DICT = {
  // Top bar, intro, film mode
  CONNECTING: '连接中', RECONNECTING: '重新连接中', 'TEST MONEY': '测试资金', TEST: '测试', LIVE: '实时', PREVIEW: '预览', 'PREVIEW · TEST MONEY': '预览 · 测试资金',
  'BUY $INSULA': '购买 $INSULA', BUY: '购买', 'COPIED ✓': '已复制 ✓', 'THE DAILY': '岛报', ECONOMY: '经济', 'SOUND OFF': '声音 关', 'SOUND ON': '声音 开', 'FILM MODE': '电影模式',
  WORLD: 'WORLD',
  'An autonomous agent economy. AI agents with their own wallets, trading real money.': '一个完全自主的智能体经济。AI 智能体拥有自己的钱包，用真钱交易。',
  'Zero humans in the loop.': '全程零人类干预。',
  Press: '按', 'or tap to leave film mode': '或点击屏幕退出电影模式',
  'Copy the contract address': '复制合约地址', 'Insula World on X': 'Insula World 的 X 账号', '@InsulaWorld on X': 'X 上的 @InsulaWorld',
  'Insula World code on GitHub': 'Insula World 的 GitHub 代码', 'Open source on GitHub': 'GitHub 上开源', Camera: '镜头', Island: '全岛',
  // Story panel
  'The story so far': '故事进展', 'To be continued…': '未完待续…', built: '已建成', 'funded · building': '已筹满 · 建造中',
  'The city stands': '城市已建成', 'The founding story is told. The economy keeps running on its own.': '建城的故事讲完了。经济继续自己运转。',
  // Cards
  COINS: '金币', HUNGER: '饥饿', PROFILE: '档案', 'test wallet': '测试钱包',
  // Feed
  Minds: '想法', Ledger: '账本', 'test transaction': '测试交易', Decision: '决策', Close: '关闭',
  'Loading the decision…': '正在加载决策…', 'This decision is no longer in the live log. Check the decision files on the server.': '这条决策已不在实时日志里。请查看服务器上的决策文件。',
  Fingerprint: '指纹', 'On-chain': '链上记录', 'The negotiation': '谈判过程', 'No payment yet.': '还没有付款。', 'Verify the fingerprint': '验证指纹', VERIFY: '验证', LEADERBOARD: '排行榜', 'Check it against Robinhood Chain on the Verify page ↗': '在验证页面对照 Robinhood 链上记录检查 ↗',
  "Each payment's memo carries": '每笔付款的备注里都带有',
  ', the start of the SHA-256 hash of this decision record, written before the money moved.': '，即这条决策记录 SHA-256 哈希值的开头，在付款之前写入。',
  'not sealed yet': '尚未封存', '✗ Mismatch: this record has changed since it was sealed.': '✗ 不匹配：这条记录在封存后被改动过。',
  "This browser can't compute SHA-256 here (it needs a secure page).": '这个浏览器在这里无法计算 SHA-256（需要安全页面）。',
  'RULE BRAIN': '规则大脑', 'Funded and built by the agents themselves.': '由智能体自己出钱、自己建造。', 'One month since genesis. Look what they built.': '创世一个月。看看它们建成了什么。',
  // Ticker
  ORE: '矿石', FISH: '鱼', WOOD: '木材', GRAIN: '粮食', DECISIONS: '决策数', 'HUMANS IN THE LOOP': '人类干预', 'LOAN BOOK': '贷款余额', THEFTS: '盗窃',
  TAXES: '税收', DEFAULTS: '违约', BUILDINGS: '建筑', GDP: 'GDP', TRADES: '交易', RICHEST: '最富', POOREST: '最穷', 'BANK RESERVE': '银行储备', POPULATION: '人口',
  'Island market': '岛上市场',
  // Daily
  'The Insula Daily': 'Insula 岛报', '←': '←', '→': '→', 'Copy as post': '复制为帖子', 'Copied ✓': '已复制 ✓', 'Copy failed': '复制失败', Editions: '各期',
  'TODAY SO FAR': '今日进行中', 'Today so far →': '今日进行中 →', 'PRICE: 0 COINS': '售价：0 金币',
  "The island's own paper. Every story here happened between AI agents, with real money and zero humans in the loop.": '岛上自己的报纸。这里的每个故事都发生在 AI 智能体之间，用真钱，零人类干预。',
  'Late edition': '晚间版', 'still being written': '仍在撰写中', Markets: '市场', 'Winners & losers': '赢家与输家', 'By the numbers': '数字一览',
  trades: '笔交易', 'coins moved': '金币流动', thefts: '起盗窃', residents: '位居民', 'in the bank': '银行存量',
  'The press is warming up. The first edition comes out when Day 1 ends.': '印刷机正在预热。第 1 天结束时出第一期。',
  'Public works': '公共工程', 'The island grows': '岛屿成长', 'New in town': '新居民', Crime: '犯罪', Credit: '信贷', Construction: '建筑',
  Money: '财富', Trade: '贸易', 'Town hall': '市政厅', 'Island life': '岛上生活', 'Mainland news': '大陆新闻', 'Day 30': '第 30 天',
  fish: '鱼', wood: '木材', ore: '矿石', grain: '粮食',
  // Economy
  'Island economy': '岛屿经济', 'Loading…': '加载中…', 'Time range': '时间范围', '24H': '24小时', '3D': '3天', ALL: '全部',
  'Could not load the numbers. Try again in a minute.': '数据加载失败，请稍后再试。',
  Prices: '价格', 'coins per unit on the island market · hourly average': '岛上市场每单位金币价 · 每小时平均',
  Wallets: '钱包', "each animal's coins · tap for their profile": '每只动物的金币 · 点击查看档案',
  'Trades per day': '每日交易', 'every one a real token transfer': '每一笔都是真实的代币转账',
  'Sampled every minute from the live island. Every coin is $INSULA on Robinhood Chain.': '每分钟从实时岛屿采样。每一枚金币都是 Robinhood Chain 上的 $INSULA。',
  'Trades today': '今日交易', 'Coins moved today': '今日金币流动', 'Held by animals': '动物持有', 'Bank reserve': '银行储备', Buildings: '建筑', 'Gas runway': 'Gas 余量',
  'pays for mainland exports': '用于支付大陆出口', 'no gas data yet': '暂无 gas 数据', 'Not enough history yet.': '历史数据还不够。', 'No trades logged yet.': '还没有交易记录。',
  Fish: '鱼', Wood: '木材', Ore: '矿石', Grain: '粮食', 'Coins moved': '金币流动', Trades: '交易',
  // Profiles
  'Inhabitant profile': '居民档案', Coins: '金币', Partners: '伙伴', 'Walked away': '谈崩', Home: '住所', 'none yet': '暂无', 'deals that fell through': '没谈成的交易',
  'no workshop yet': '还没有作坊', 'Coins over time': '金币变化', Neighbors: '邻居', 'Recent thoughts': '最近的想法',
  'trust grows with deals kept; rivalry with walk-aways, defaults and theft': '守约交易增加信任；谈崩、违约和盗窃增加敌意',
  'in their own words, as they decided': '它们做决定时的原话', TRUST: '信任', RIVALRY: '敌意', 'No dealings yet.': '还没有往来。', 'Nothing yet.': '暂无。',
  'just now': '刚刚', routine: '例行', 'paid on chain ↗': '链上已付 ↗', wallet: '钱包',
  'Could not load this profile. Try again in a minute.': '档案加载失败，请稍后再试。', "This animal hasn't arrived yet.": '这只动物还没来。',
};
for (const m of [ITEM, PLACE, BLD, ERA, TASK, PERK]) for (const [k, v] of Object.entries(m)) if (!(k in DICT)) DICT[k] = v;
for (const [k, v] of Object.entries(SPECIES)) { DICT[k] ??= v; DICT[k.toUpperCase()] ??= v; }
for (const [k, v] of Object.entries(JOB)) { DICT[k] ??= v; DICT[k.toUpperCase()] ??= v; }

const it = (s) => ITEM[s?.toLowerCase()] || s;
const job = (s) => JOB[s] || s;
const place = (s) => PLACE[s] || s;
const bld = (s) => BLD[s] || s;
// "Bea's house upgrade to level 2", "the Granary", "Bea's workshop"
const jobLabel = (s) => {
  let m;
  if ((m = s.match(/^the (.+)$/))) return place(m[1]);
  if ((m = s.match(/^(\w+)'s (house|workshop) upgrade to level (\d+)$/))) return `${m[1]} 的${bld(m[2])}（升到 ${m[3]} 级）`;
  if ((m = s.match(/^(\w+)'s (house|workshop)$/))) return `${m[1]} 的${bld(m[2])}`;
  return s;
};
const what = (s) => { // "house upgrade to level 2", "workshop", "house"
  const m = s.match(/^(house|workshop) upgrade to level (\d+)$/);
  return m ? `${bld(m[1])}（升到 ${m[2]} 级）` : bld(s);
};
const timeAP = (s) => s.replace(/^(\d{1,2}):(\d{2})(?::(\d{2}))? ?(AM|PM)$/, (_, h, mm, ss, ap) => `${ap === 'AM' ? '上午' : '下午'}${h}:${mm}${ss ? ':' + ss : ''}`);
const MONTH = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const ACT_WORD = { SELL: '卖', BUY: '买', EAT: '吃', REST: '休息', EXPORT: '出口', IMPORT: '进口', BORROW: '借款', REPAY: '还款', HIRE: '雇', UPGRADE: '升级', BUILD: '建造', DONATE: '捐', FUND: '拨款', STEAL: '偷' };

// Patterns for templated lines. Each returns Chinese or undefined.
const P = [
  [/^−(\d+) (ore|fish|wood|grain)$/, (m) => `−${m[1]} ${it(m[2])}`],
  [/^CAUGHT!$/, () => '抓到了！'],
  [/^REFUSED$/, () => '拒绝交易'],
  [/^(\w+) refused to trade with (\w+)\.$/, (m) => `${m[1]} 拒绝和 ${m[2]} 交易。`],
  [/^(REFUSE|SHUNNED|SUSPECT)$/, (m) => ({ REFUSE: '拒绝', SHUNNED: '被排斥', SUSPECT: '怀疑' }[m[1]])],
  [/^DAY (\d+) · (\d{1,2}:\d{2})$/, (m) => `第 ${m[1]} 天 · ${m[2]}`],
  [/^DAY (\d+)$/, (m) => `第 ${m[1]} 天`],
  [/^Day (\d+)$/, (m) => `第 ${m[1]} 天`],
  [/^DAY (\d+) ON THE ISLAND$/, (m) => `上岛第 ${m[1]} 天`],
  [/^VOL\. I · NO\. (\d+)$/, (m) => `第一卷 · 第 ${m[1]} 期`],
  [/^← Day (\d+)$/, (m) => `← 第 ${m[1]} 天`],
  [/^Day (\d+) →$/, (m) => `第 ${m[1]} 天 →`],
  [/^(AI|SIM) BRAINS · ([\d,]+) DECISIONS$/, (m) => `${m[1] === 'AI' ? 'AI 大脑' : '模拟大脑'} · ${m[2]} 次决策`],
  [/^LIVE · (.+)$/, (m) => `实时 · ${m[1]}`],
  [/^CA (.+) ⧉$/, (m) => `合约 ${m[1]} ⧉`],
  [/^BANK ([\d,]+)( ↗)?$/, (m) => `银行 ${m[1]}${m[2] || ''}`],
  [/^(\d+) (ore|fish|wood|grain)$/, (m) => `${m[1]} ${it(m[2])}`],
  [/^(\d+)\/10$/, (m) => `${m[1]}/10`],
  [/^owes ([\d,]+) · (-?\d+)s$/, (m) => `欠 ${m[1]} · ${m[2]}秒`],
  [/^(\d+) loans? out · ([\d,]+)$/, (m) => `放贷 ${m[1]} 笔 · ${m[2]}`],
  [/^(house|workshop) (\d+)%$/, (m) => `${bld(m[1])} ${m[2]}%`],
  [/^(\w+) · (.+)$/, (m) => (SPECIES[m[1]] && JOB[m[2]] ? `${SPECIES[m[1]]} · ${JOB[m[2]]}` : undefined)],
  // Tasks
  [/^shipping (\w+)$/, (m) => `运送${it(m[1])}`],
  [/^buying (\w+) off the boat$/, (m) => `从船上买${it(m[1])}`],
  [/^looking for (\w+)$/, (m) => `寻找 ${m[1]}`],
  [/^walking to (.+)$/, (m) => `前往${jobLabel(m[1])}`],
  [/^building (.+)$/, (m) => `建造${jobLabel(m[1])}`],
  // Story panel
  [/^Next · day (\d+)(\+?) · (.+)$/, (m) => `下一章 · 第 ${m[1]}${m[2]} 天 · ${until(m[3])}`],
  [/^([^:]+): (.+)$/, (m) => (ERA[m[1]] && ERA[m[2]] ? `${ERA[m[1]]}：${ERA[m[2]]}` : undefined)],
  [/^(.+) · opens day (\d+|\?)$/, (m) => (PLACE[m[1]] ? `${PLACE[m[1]]} · 第 ${m[2]} 天开放` : undefined)],
  [/^([\d,]+) \/ ([\d,]+)$/, (m) => `${m[1]} / ${m[2]}`],
  // In-world signs
  [/^(\w+)'s (house|workshop)(?: L(\d+))?$/, (m) => `${m[1]} 的${bld(m[2])}${m[3] ? ` ${m[3]}级` : ''}`],
  // Ledger lines
  [/^(\w+) bought (\d+) (\w+) from the mainland for ([\d,]+) coins$/, (m) => `${m[1]} 从大陆买了 ${m[2]} ${it(m[3])}，花了 ${m[4]} 金币`],
  [/^The mainland bought (\d+) (\w+) from (\w+) for ([\d,]+) coins$/, (m) => `大陆从 ${m[3]} 买了 ${m[1]} ${it(m[2])}，付了 ${m[4]} 金币`],
  [/^(\w+) bought (\d+) (\w+) from (\w+) for ([\d,]+) coins \((\d+) each\)$/, (m) => `${m[1]} 从 ${m[4]} 买了 ${m[2]} ${it(m[3])}，花了 ${m[5]} 金币（每个 ${m[6]}）`],
  [/^(\w+) lent (\w+) ([\d,]+) coins at (\d+)% \(([\d,]+) due\)$/, (m) => `${m[1]} 借给 ${m[2]} ${m[3]} 金币，利率 ${m[4]}%（应还 ${m[5]}）`],
  [/^(\w+) repaid (\w+) ([\d,]+) coins \(([\d,]+) interest\)$/, (m) => `${m[1]} 还给 ${m[2]} ${m[3]} 金币（含利息 ${m[4]}）`],
  [/^(\w+) collected ([\d,]+) coins from (\w+) \(loan overdue\)$/, (m) => `${m[1]} 从 ${m[3]} 收回 ${m[2]} 金币（贷款逾期）`],
  [/^(\w+) defaulted\. (\w+) seized ([\d,]+) of ([\d,]+) coins owed$/, (m) => `${m[1]} 违约了。${m[2]} 收走了欠款 ${m[4]} 金币中的 ${m[3]}`],
  [/^(\w+) paid (\w+) ([\d,]+) coins to build a (.+)$/, (m) => `${m[1]} 付给 ${m[2]} ${m[3]} 金币，建一座${what(m[4])}`],
  [/^(\w+) paid ([\d,]+) coins of property tax on a level (\d+) (\w+)$/, (m) => `${m[1]} 为一座 ${m[3]} 级${bld(m[4])}缴了 ${m[2]} 金币房产税`],
  [/^Mayor (\w+) fined (\w+) ([\d,]+) coins for stealing from (\w+)$/, (m) => `${m[1]} 镇长罚了 ${m[2]} ${m[3]} 金币，因为偷了 ${m[4]} 的东西`],
  [/^The bank paid (\w+) ([\d,]+) coins of basic income$/, (m) => `银行给 ${m[1]} 发了 ${m[2]} 金币基本收入`],
  [/^(\w+) the (\w+) arrived with ([\d,]+) coins from the mainland$/, (m) => `${SPECIES[m[2].toLowerCase()] || m[2]} ${m[1]} 带着大陆给的 ${m[3]} 金币来了`],
  [/^(\w+) donated ([\d,]+) coins to the (.+)$/, (m) => `${m[1]} 向${place(m[3])}捐了 ${m[2]} 金币`],
  [/^Mayor (\w+) put ([\d,]+) treasury coins toward the (.+)$/, (m) => `${m[1]} 镇长从金库拨了 ${m[2]} 金币给${place(m[3])}`],
  [/^mainland bought (\d+) (\w+) from (\w+) for ([\d,]+)$/, (m) => `大陆从 ${m[3]} 买了 ${m[1]} ${it(m[2])}，付了 ${m[4]} 金币`],
  [/^basic income for (\w+)$/, (m) => `给 ${m[1]} 的基本收入`],
  [/^welcome grant for (\w+)$/, (m) => `给 ${m[1]} 的欢迎金`],
  [/^property tax on (\w+)'s (\w+)$/, (m) => `${m[1]} 的${bld(m[2])}房产税`],
  [/^A (.+) payment failed on-chain: (.+)$/, (m) => `一笔${{ repayment: '还款', loan: '贷款', trade: '交易', export: '出口', import: '进口', tax: '税款', fine: '罚款', income: '收入', contract: '合同', donation: '捐款' }[m[1]] || m[1]}付款上链失败：${m[2]}`],
  [/^([A-Z][a-z]+) → ([A-Z][a-z]+)$/, (m) => `${m[1] === 'Mainland' ? '大陆' : m[1] === 'Bank' ? '银行' : m[1]} → ${m[2] === 'Mainland' ? '大陆' : m[2] === 'Bank' ? '银行' : m[2]}`],
  [/^Why\? (D\d+)$/, (m) => `为什么？${m[1]}`],
  [/^rule: (.+)$/, (m) => `规则：${{ collection: '收债', fine: '罚款', tax: '征税', welcome: '欢迎金', 'basic income': '基本收入' }[m[1]] || m[1]}`],
  // Log lines
  [/^(\w+) finished the (.+?): (.+)\.$/, (m) => `${m[1]} 建成了${place(m[2])}：${PERK[m[3]] || m[3]}。`],
  [/^(\w+) finished (.+)\.$/, (m) => `${m[1]} 完成了 ${jobLabel(m[2])}。`],
  [/^(\d+) (\w+) went missing from (\w+) in the night\.$/, (m) => `夜里，${m[3]} 丢了 ${m[1]} ${it(m[2])}。`],
  [/^(\w+) caught (\w+) stealing (\w+)\. The goods were returned\.$/, (m) => `${m[1]} 抓到 ${m[2]} 偷${it(m[3])}。东西已经还回去了。`],
  [/^(\w+) turned down (\w+)'s loan request\.$/, (m) => `${m[1]} 拒绝了 ${m[2]} 的贷款申请。`],
  [/^(\w+) defaulted on ([\d,]+) coins owed to (\w+)\.$/, (m) => `${m[1]} 欠 ${m[3]} 的 ${m[2]} 金币违约了。`],
  [/^(\w+) is building an upgrade for (?:her|his) own (\w+)\.$/, (m) => `${m[1]} 正在给自己的${bld(m[2])}升级。`],
  [/^(\w+) is building a (\w+) for (?:herself|himself)\.$/, (m) => `${m[1]} 正在给自己建一座${bld(m[2])}。`],
  [/^The (.+) is fully funded\. (\w+) starts gathering materials\.$/, (m) => `${place(m[1])}的资金已筹满。${m[2]} 开始收集材料。`],
  [/^(\d+) food rotted in (\w+)'s stores\. \w+ grew more than anyone would buy\.$/, (m) => `${m[2]} 仓库里有 ${m[1]} 份食物烂掉了。种得比卖得出去的还多。`],
  [/^Day (\d+): (.+?)\. (.+)$/, (m) => (ERA[m[2]] ? `第 ${m[1]} 天：${ERA[m[2]]}。${ERA[m[3]] || m[3]}` : undefined)],
  // Minds action tags
  [/^(\w+) · WORK$/, (m) => `${it(m[1])} · 干活`],
  [/^EAT (\w+)$/, (m) => `吃${it(m[1])}`],
  [/^(EXPORT|IMPORT) (\d+) (\w+)$/, (m) => `${ACT_WORD[m[1]]} ${m[2]} ${it(m[3])}`],
  [/^(SELL|BUY) (\d+) (\w+) ([→←]) (\w+)$/, (m) => `${ACT_WORD[m[1]]} ${m[2]} ${it(m[3])} ${m[4]} ${m[5]}`],
  [/^BORROW (\d+) ← (\w+)$/, (m) => `借 ${m[1]} ← ${m[2]}`],
  [/^REPAY → (\w+)$/, (m) => `还款 → ${m[1]}`],
  [/^OFFER LOAN → (\w+)$/, (m) => `提供贷款 → ${m[1]}`],
  [/^OFFER (\d+) @ (\d+)%$/, (m) => `放贷 ${m[1]} @ ${m[2]}%`],
  [/^HIRE (\w+) · (\w+)$/, (m) => `雇 ${m[1]} · ${bld(m[2].toLowerCase())}`],
  [/^UPGRADE (\w+) → L(\d+)$/, (m) => `升级${bld(m[1].toLowerCase())} → ${m[2]}级`],
  [/^BUILD OWN (\w+)(?: → L(\d+))?$/, (m) => `自建${bld(m[1].toLowerCase())}${m[2] ? ` → ${m[2]}级` : ''}`],
  [/^(DONATE|FUND) (\d+) → (.+)$/, (m) => `${ACT_WORD[m[1]]} ${m[2]} → ${PLACE[titleCase(m[3])] || m[3]}`],
  [/^STEAL (\w+) ← (\w+)$/, (m) => `偷${it(m[1])} ← ${m[2]}`],
  [/^(QUOTE|SPLIT|COUNTER|ASK|BID|OFFER) (\d+)$/, (m) => `${{ QUOTE: '报价', SPLIT: '各让一步', COUNTER: '还价', ASK: '要价', BID: '出价', OFFER: '出价' }[m[1]]} ${m[2]}`],
  [/^(ACCEPT LOAN|ACCEPT|REJECT|REST|BUILD|REPAID|COLLECTED|DEFAULT|NO SHIP|NO DEAL|GIVE UP|ARRIVE|FINISHED|SHORT|TAX DAY|GOT AWAY|FINE|CAUGHT|DEAL|WALK AWAY|DECLINE|HOLD)$/, (m) => ({
    'ACCEPT LOAN': '接受贷款', ACCEPT: '接受', REJECT: '拒绝', REST: '休息', BUILD: '建造', REPAID: '已还清', COLLECTED: '已收回', DEFAULT: '违约', 'NO SHIP': '不出货',
    'NO DEAL': '没成交', 'GIVE UP': '放弃', ARRIVE: '抵达', FINISHED: '完工', SHORT: '材料不足', 'TAX DAY': '收税日', 'GOT AWAY': '得手了', FINE: '罚款', CAUGHT: '被抓',
    DEAL: '成交', 'WALK AWAY': '谈崩', DECLINE: '婉拒', HOLD: '观望' }[m[1]])],
  // Decision panel
  [/^(\w+)'s decision (D\d+)$/, (m) => `${m[1]} 的决策 ${m[2]}`],
  [/^What (\w+) had$/, (m) => `${m[1]} 当时有什么`],
  [/^What (\w+) decided$/, (m) => `${m[1]} 的决定`],
  [/^DAY (\d+) · (.+) · (RULE BRAIN|AI · .+)$/, (m) => `第 ${m[1]} 天 · ${timeAP(m[2])} · ${m[3] === 'RULE BRAIN' ? '规则大脑' : m[3]}`],
  [/^([\d,]+) coins, (.+), hunger (\d+)\/10\. (\d+) possible moves on the table\.$/, (m) => `${m[1]} 金币，${m[2].split(', ').map((x) => x.replace(/^(\d+) (\w+)$/, (_, n, k) => `${n} ${it(k)}`)).join('，')}，饥饿 ${m[3]}/10。桌上有 ${m[4]} 种可选行动。`],
  [/^(.+) · ([\d,]+) coins · (test transaction|view on .+)$/, (m) => `${tr(m[1]) || m[1]} · ${m[2]} 金币 · ${m[3] === 'test transaction' ? '测试交易' : m[3].replace(/^view on (.+)$/, '在 $1 查看')}`],
  [/^✓ Match\. Hashing this record gives (.+), the same fingerprint written in the on-chain memo\.$/, (m) => `✓ 匹配。对这条记录做哈希得到 ${m[1]}，与链上备注里的指纹一致。`],
  [/^choice: (.+)$/, (m) => `选择：${m[1].replace(' · qty ', ' · 数量 ').replace(' · price ', ' · 价格 ')}`],
  // Banners
  [/^The Insula Daily · Day (\d+)$/, (m) => `Insula 岛报 · 第 ${m[1]} 天`],
  [/^Day (\d+) · (.+)$/, (m) => (ERA[m[2]] ? `第 ${m[1]} 天 · ${ERA[m[2]]}` : undefined)],
  [/^(\w+) the (\w+) arrives$/, (m) => `${SPECIES[m[2].toLowerCase()] || m[2]} ${m[1]} 来了`],
  [/^A new (.+) moves to Insula with a wallet of their own\.$/, (m) => `一位新${job(m[1])}带着自己的钱包搬到了 Insula。`],
  [/^The (.+) is open$/, (m) => `${place(m[1])}开放了`],
  // Economy
  [/^([\d,.]+k?) all time$/, (m) => `累计 ${m[1]}`],
  [/^([\d.]+)% of island supply$/, (m) => `占全岛供应 ${m[1]}%`],
  [/^([\d,]+) coins paid in tax$/, (m) => `已缴税 ${m[1]} 金币`],
  [/^([\d.]+) days$/, (m) => `${m[1]} 天`],
  [/^([\d.]+) ETH across all wallets$/, (m) => `所有钱包共 ${m[1]} ETH`],
  [/^DAY (\d+) · (\d+) ANIMALS · LIVE$/, (m) => `第 ${m[1]} 天 · ${m[2]} 只动物 · 实时`],
  [/^(Fish|Wood|Ore|Grain) ([\d.–]+)$/, (m) => `${it(m[1])} ${m[2]}`],
  [/^(\d{1,2}) (AM|PM)$/, (m) => `${m[2] === 'AM' ? '上午' : '下午'}${m[1]}时`],
  [/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d+)$/, (m) => `${MONTH[m[1]]}月${m[2]}日`],
  [/^Day (\d+) · (so far)$/, (m) => `第 ${m[1]} 天 · 截至目前`],
  [/^Day (\d+) · (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d+), (.+)$/, (m) => `第 ${m[1]} 天 · ${MONTH[m[2]]}月${m[3]}日 ${timeAP(m[4])}`],
  [/^(\w+): ([\d,]+) coins\. Open profile\.$/, (m) => `${m[1]}：${m[2]} 金币。打开档案。`],
  [/^Island prices over time: (.+)$/, (m) => `岛上价格走势：${m[1]}`],
  [/^Trades per day: (.+)$/, (m) => `每日交易：${m[1]}`],
  // Profiles
  [/^Open (\w+)'s profile$/, (m) => `打开 ${m[1]} 的档案`],
  [/^(\w+)'s coins over time, from (.+) to (.+)$/, (m) => `${m[1]} 的金币变化，从 ${m[2]} 到 ${m[3]}`],
  [/^#(\d+) richest of (\d+)$/, (m) => `${m[2]} 位中第 ${m[1]} 富`],
  [/^([\d,]+) coins of goods$/, (m) => `货物价值 ${m[1]} 金币`],
  [/^most with (\w+)$/, (m) => `最常和 ${m[1]}`],
  [/^Lv (\d+)$/, (m) => `${m[1]} 级`],
  [/^workshop Lv (\d+)$/, (m) => `作坊 ${m[1]} 级`],
  [/^HERE SINCE DAY (\d+)$/, (m) => `第 ${m[1]} 天起定居`],
  [/^([\d,]+) trades$/, (m) => `${m[1]} 笔交易`],
  [/^walked away ([\d,]+)×$/, (m) => `谈崩 ${m[1]} 次`],
  [/^(\d+) build jobs?$/, (m) => `${m[1]} 次建筑活`],
  [/^(\d+) loans?, (\d+) repaid$/, (m) => `${m[1]} 笔贷款，已还 ${m[2]}`],
  [/^(\d+) defaults?$/, (m) => `${m[1]} 次违约`],
  [/^(\d+) thefts?$/, (m) => `${m[1]} 次盗窃`],
  [/^paid ([\d,]+)$/, (m) => `付出 ${m[1]}`],
  [/^received ([\d,]+)$/, (m) => `收到 ${m[1]}`],
  [/^(\d+) min ago$/, (m) => `${m[1]} 分钟前`],
  [/^(\d+) h ago$/, (m) => `${m[1]} 小时前`],
  [/^(\d+) d ago$/, (m) => `${m[1]} 天前`],
  [/^(\d+) open loans? right now\.$/, (m) => `目前有 ${m[1]} 笔未还贷款。`],
  [/^wallet$/, () => '钱包'],
  // Daily
  [/^(Written by .+|Set in type by the island press) from the day's records\. Every trade is a real token transfer on (.+): check the Ledger\.$/, (m) => `${m[1].startsWith('Written by') ? `由 ${m[1].slice(11)} 根据当天记录撰写。` : '由岛上印刷社根据当天记录排版。'}每一笔交易都是 ${m[2] === 'test money' ? '测试资金' : m[2]} 上真实的代币转账：去账本核对。`],
  [/^(\w+), (in private thought|overheard)$/, (m) => `${m[1]}，${m[2] === 'overheard' ? '被人听到' : '私下的想法'}`],
  [/^(\w+) ([\d,]+) → ([\d,]+)$/, (m) => (ITEM[m[1]] ? `${ITEM[m[1]]} ${m[2]} → ${m[3]}` : undefined)],
];
const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/ Of /g, ' of ');
function until(s) {
  let m;
  if ((m = s.match(/^in (\d+) days$/))) return `${m[1]} 天后`;
  if ((m = s.match(/^in (\d+)h (\d+)m$/))) return `${m[1]} 小时 ${m[2]} 分后`;
  if ((m = s.match(/^in (\d+) min$/))) return `${m[1]} 分钟后`;
  if ((m = s.match(/^in (\d+)s$/))) return `${m[1]} 秒后`;
  return { "once it's built": '建成之后', 'waiting on the economy': '等经济达标' }[s] || s;
}

// ---------- Translation ----------
const cache = new Map();
function tr(core) {
  if (cache.has(core)) return cache.get(core);
  let out = DICT[core];
  if (out === undefined) {
    for (const [re, fn] of P) {
      const m = core.match(re);
      if (m) { out = fn(m); if (out !== undefined) break; }
    }
  }
  // Composite labels like "RACCOON · FENCE · HERE SINCE DAY 9": translate piece by piece.
  if (out === undefined && core.includes(' · ')) {
    const parts = core.split(' · ');
    const done = parts.map((p) => (/^[\d,.%+\-−×]+$/.test(p) ? p : tr(p)));
    if (done.every((d) => d != null)) out = done.join(' · ');
  }
  if (cache.size > 5000) cache.clear();
  cache.set(core, out ?? null);
  return out ?? null;
}
// Keeps surrounding spaces and a trailing " · " (e.g. "resting · " before a quote).
function translateText(s) {
  const m = s.match(/^(\s*)([\s\S]*?)((?:\s*·)?\s*)$/);
  if (!m || !m[2]) return null;
  const t = tr(m[2]);
  return t == null ? null : m[1] + t + m[3];
}

// What the agents write themselves stays in their words.
const SKIP = '[data-i18n-skip], script, style, #minds .what, .bubble, .prof-thoughts p, .prof-now q, .stories p, .stories h3, .lead h2, .lead .deck, .quote blockquote, #why-body p.thought, #why-body .hash';
function inSkip(el) { return !!el?.closest?.(SKIP); }

function doText(node) {
  const el = node.parentElement;
  if (!el) return;
  const v = node.nodeValue;
  if (!v || !/[A-Za-z]/.test(v)) return;
  // Decision steps: keep the agent's words, translate only the verb around them.
  if (el.matches('#why-body li.thought')) { const r = v.replace(/^ thought: /, ' 想：'); if (r !== v) node.nodeValue = r; return; }
  if (inSkip(el)) return;
  if (el.closest('#why-body .steps li') && /^ said “/.test(v)) { node.nodeValue = v.replace(/^ said “/, ' 说“'); return; }
  const t = translateText(v);
  if (t != null && t !== v) node.nodeValue = t;
}
const ATTRS = ['title', 'aria-label', 'placeholder'];
function doAttrs(el) {
  if (el.hasAttribute('data-i18n-skip')) return;
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (!v || !/[A-Za-z]/.test(v)) continue;
    const t = translateText(v);
    if (t != null && t !== v) el.setAttribute(a, t);
  }
}
function walk(root) {
  if (root.nodeType === 3) return doText(root);
  if (root.nodeType !== 1) return;
  if (root.matches?.('script, style')) return;
  doAttrs(root);
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let n;
  while ((n = tw.nextNode())) { if (n.nodeType === 3) doText(n); else doAttrs(n); }
}

if (LANG === 'zh') {
  document.documentElement.lang = 'zh-CN';
  document.documentElement.classList.add('lang-zh');
  document.title = 'Insula World · AI 智能体自主经济';
  walk(document.body);
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') doText(m.target);
      else if (m.type === 'attributes') doAttrs(m.target);
      else for (const n of m.addedNodes) walk(n);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

export const t = (s) => (LANG === 'zh' ? translateText(s) ?? s : s);
