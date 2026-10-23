#!/usr/bin/env node
/* 每日数据管道：LMArena 官方数据集（parquet 直下）+ OpenRouter + models.dev → 合并 → data.json
 * ⚠️ 归一化/厂商映射/变体规则需与 index.html 内联脚本保持同步（改这里必须同步改页面）。
 * 任一核心数据源拉取失败即非零退出，保留上一天的 data.json（workflow 只在脚本成功后提交）。
 * 榜单来源（lmarena-ai/leaderboard-dataset 各 config 的 latest split）：
 *   text   → overall(智能) chinese(中文) coding(代码) math(数学) creative_writing(创意写作)
 *   webdev → overall(WebDev)   vision → overall(视觉)   agent → overall(智能体, score 制) */
import fs from 'node:fs';
import { parquetRead } from 'hyparquet';

const VENDOR_ALIAS = {
  openai:'openai', anthropic:'anthropic', google:'google', deepseek:'deepseek',
  zhipuai:'z-ai', 'z-ai':'z-ai', zai:'z-ai', moonshotai:'moonshot', moonshot:'moonshot',
  qwen:'qwen', alibaba:'qwen', 'qwen-team':'qwen', xai:'xai', 'x-ai':'xai',
  'meta-llama':'meta', meta:'meta', mistralai:'mistral', mistral:'mistral',
  microsoft:'microsoft', minimax:'minimax', xiaomi:'xiaomi', longcat:'longcat',
  meituan:'longcat', stepfun:'stepfun', 'stepfun-ai':'stepfun', nvidia:'nvidia',
  cohere:'cohere', perplexity:'perplexity', amazon:'amazon', 'amazon-nova':'amazon',
  baidu:'baidu', tencent:'tencent', bytedance:'bytedance', thinky:'thinky',
  inclusionai:'inclusion', liquid:'liquid', ai21:'ai21', nousresearch:'nous',
  databricks:'databricks', reka:'reka',
};
const FIRST_PARTY = ['openai','anthropic','google','xai','deepseek','zhipuai','moonshotai',
  'alibaba','minimax','mistral','meta','nvidia','xiaomi','longcat','stepfun','cohere',
  'perplexity','microsoft','baidu','tencent','bytedance','thinky'];
const BAD_ID = /image|imagine|tts|whisper|embed|video|-asr|transcribe|omni-human/i;

// 榜单 key 与 data.json 字段后缀对应：eloO=elo/rankO（沿用旧字段名），其余 eloC/rankC 等
const BOARDS = [
  { key: 'O', conf: 'text',   cat: 'overall',          sc: 'rating', must: true },
  { key: 'Z', conf: 'text',   cat: 'chinese',          sc: 'rating', must: true },
  { key: 'C', conf: 'text',   cat: 'coding',           sc: 'rating', must: true },
  { key: 'M', conf: 'text',   cat: 'math',             sc: 'rating' },
  { key: 'W', conf: 'text',   cat: 'creative_writing', sc: 'rating' },
  { key: 'D', conf: 'webdev', cat: 'overall',          sc: 'rating' },
  { key: 'V', conf: 'vision', cat: 'overall',          sc: 'rating' },
  { key: 'A', conf: 'agent',  cat: 'overall',          sc: 'score'   },
];

function norm(s){
  return String(s).toLowerCase()
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/[:_]/g, '-')
    .replace(/-?\d{8}/g, '')
    .replace(/-(20\d{2}|2\d{3})$/, '')
    .replace(/-(max|high|medium|low|minimal|thinking|chat|latest|preview|exp)$/g, '')
    .replace(/-h$/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || s;
}
const priceOk = x => x != null && x >= 0;
const num = x => typeof x === 'bigint' ? Number(x) : x;

async function j(url, ms = 25000, tries = 4){
  for (let i = 0; i < tries; i++){
    try {
      const res = await fetch(url, {signal: AbortSignal.timeout(ms)});
      if (!res.ok) throw new Error('http ' + res.status);
      return await res.json();
    } catch (e){
      if (i === tries - 1) throw e;
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

/* LMArena 官方数据集 latest 分片 parquet 直下（整榜一次拿全，替代旧行式分页接口）。
 * 主源 huggingface.co（CI 可达），备源 hf-mirror.com（中国大陆本地可达）。 */
async function fetchParquet(conf){
  const urls = [
    `https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset/resolve/main/${conf}/latest-00000-of-00001.parquet`,
    `https://hf-mirror.com/datasets/lmarena-ai/leaderboard-dataset/resolve/main/${conf}/latest-00000-of-00001.parquet`,
  ];
  let lastErr;
  for (const url of urls){
    for (let i = 0; i < 3; i++){
      try {
        const res = await fetch(url, {signal: AbortSignal.timeout(60000)});
        if (!res.ok) throw new Error('http ' + res.status);
        const buf = Buffer.from(await res.arrayBuffer());
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        let rows;
        await parquetRead({ file: ab, rowFormat: 'object', onComplete: r => { rows = r; } });
        if (!rows || !rows.length) throw new Error('empty parquet');
        return rows;
      } catch (e){
        lastErr = e;
        await new Promise(r => setTimeout(r, 2000 * (i + 1)));
      }
    }
  }
  throw lastErr;
}

async function fetchBoards(){
  const cache = {};
  const out = {};
  for (const b of BOARDS){
    const rows = cache[b.conf] || (cache[b.conf] = await fetchParquet(b.conf));
    let matched = 0;
    for (const r of rows){
      if (r.category !== b.cat) continue;
      matched++;
      const a = out[r.model_name] || (out[r.model_name] = {
        org: r.organization, votes: null, pub: r.leaderboard_publish_date, cats: {}
      });
      if (b.key === 'O') a.votes = num(r.vote_count);
      const loKey = b.sc === 'rating' ? 'rating_lower' : 'score_ci_lower';
      const hiKey = b.sc === 'rating' ? 'rating_upper' : 'score_ci_upper';
      a.cats[b.key] = { rank: num(r.rank), rating: num(r[b.sc]),
        lo: num(r[loKey]), hi: num(r[hiKey]) };
      const pub = r.leaderboard_publish_date;
      if (pub && (!a.pub || pub > a.pub)) a.pub = pub;
    }
    console.log(`board ${b.conf}/${b.cat} (${b.sc}): ${matched} models`);
    if (b.must && !matched) throw new Error(`arena: ${b.conf}/${b.cat} empty`);
  }
  if (!Object.keys(out).length) throw new Error('arena: empty');
  return out;
}

function catalogFromOR(list){
  const catalog = {};
  for (const m of (list || [])){
    const mid = m.id || '';
    const slash = mid.indexOf('/');
    const vendorRaw = slash > 0 ? mid.slice(0, slash) : 'other';
    let slug = slash > 0 ? mid.slice(slash + 1) : mid;
    let variant = null;
    const ci = slug.indexOf(':');
    if (ci >= 0){ variant = slug.slice(ci + 1); slug = slug.slice(0, ci); }
    if (variant && /^(batch|online|floor|search)$/.test(variant)) continue;
    const vendor = VENDOR_ALIAS[vendorRaw] || 'other';
    const arch = m.architecture || {};
    const outs = arch.output_modalities || ['text'];
    if (!outs.includes('text')) continue;
    if (variant !== 'free' && BAD_ID.test(slug)) continue;
    const key = vendor + '|' + norm(slug);
    const pr = m.pricing || {};
    let pin = pr.prompt != null ? parseFloat(pr.prompt) * 1e6 : null;
    let pout = pr.completion != null ? parseFloat(pr.completion) * 1e6 : null;
    if (!priceOk(pin)) pin = null;
    if (!priceOk(pout)) pout = null;
    let e = catalog[key];
    if (!e){
      let name = m.name || slug;
      const c2 = name.indexOf(': ');
      if (c2 > 0) name = name.slice(c2 + 2);
      e = catalog[key] = {name: name.trim(), vendor,
        pin: null, pout: null, ctx: m.context_length ?? null,
        mout: (m.top_provider || {}).max_completion_tokens ?? null,
        min: arch.input_modalities || [], created: m.created ?? null,
        free: false, reason: false, tools: false, ow: null, rel: null};
      e.vision = e.min.includes('image'); e.audio = e.min.includes('audio');
      const sp = m.supported_parameters || [];
      e.reason = sp.includes('reasoning') || sp.includes('include_reasoning');
      e.tools = sp.includes('tools');
    }
    if (variant === 'free'){ e.free = true; continue; }
    if (priceOk(pin) && (e.pin == null || (m.created || 0) >= (e.created || 0))){
      e.pin = pin; e.pout = pout;
    }
    if (e.pin == null && priceOk(pin)){ e.pin = pin; e.pout = pout; }
  }
  return catalog;
}

function enrichMD(catalog, mdApi){
  for (const prov of FIRST_PARTY){
    const p = mdApi && mdApi[prov];
    if (!p) continue;
    const vendor = VENDOR_ALIAS[prov] || 'other';
    for (const [mid, m] of Object.entries(p.models || {})){
      if (BAD_ID.test(mid)) continue;
      const cost = m.cost || {}, lim = m.limit || {};
      const pin = priceOk(cost.input) ? cost.input : null;
      const pout = priceOk(cost.output) ? cost.output : null;
      const key = vendor + '|' + norm(mid);
      const e = catalog[key];
      if (e){
        if (pin != null && e.pin == null) e.pin = pin;
        if (pout != null && e.pout == null) e.pout = pout;
        if (lim.context != null && e.ctx == null) e.ctx = lim.context;
        if (lim.output != null && e.mout == null) e.mout = lim.output;
        if (m.release_date && !e.rel) e.rel = m.release_date;
        if (m.open_weights != null && e.ow == null) e.ow = m.open_weights;
        if (m.reasoning && !e.reason) e.reason = true;
        if (m.tool_call && !e.tools) e.tools = true;
      } else {
        const mods = m.modalities || {};
        const ne = {name: m.name || mid, vendor,
          pin, pout, ctx: lim.context ?? null, mout: lim.output ?? null,
          min: mods.input || [], created: null, free: pin === 0 && pout === 0,
          rel: m.release_date ?? null, ow: m.open_weights ?? null,
          reason: !!m.reasoning, tools: !!m.tool_call};
        ne.vision = ne.min.includes('image'); ne.audio = ne.min.includes('audio');
        catalog[key] = ne;
      }
    }
  }
}

function buildRows(arena, orList, mdApi){
  const catalog = catalogFromOR(orList);
  enrichMD(catalog, mdApi);
  const rows = [];
  const used = new Set();
  const EFF = /-(max|high|medium|low|thinking)$/i;
  for (const [name, a] of Object.entries(arena)){
    const org = VENDOR_ALIAS[a.org] || 'arena';
    const n = norm(name);
    let e = catalog[org + '|' + n];
    if (!e){
      let best = null, bestLen = Infinity;
      const pref = org + '|';
      for (const k of Object.keys(catalog)){
        if (!k.startsWith(pref)) continue;
        const slug = k.slice(pref.length);
        if (slug.startsWith(n) || n.startsWith(slug)){
          const d = Math.abs(slug.length - n.length);
          if (d < bestLen){ best = k; bestLen = d; }
        }
      }
      if (best) e = catalog[best];
    }
    const c = k => a.cats[k] || {};
    const [ov, zh, co, mt, cw, wd, vs, ag] =
      ['O','Z','C','M','W','D','V','A'].map(c);
    let row;
    if (e){
      used.add(e);
      row = {name: e.name, vendor: e.vendor === 'other' ? org : e.vendor,
        arenaName: name, elo: ov.rating ?? null, eloLo: ov.lo ?? null, eloHi: ov.hi ?? null,
        rankO: ov.rank ?? null, eloZ: zh.rating ?? null, rankZ: zh.rank ?? null,
        eloC: co.rating ?? null, rankC: co.rank ?? null,
        eloM: mt.rating ?? null, rankM: mt.rank ?? null,
        eloW: cw.rating ?? null, rankW: cw.rank ?? null,
        eloD: wd.rating ?? null, rankD: wd.rank ?? null,
        eloV: vs.rating ?? null, rankV: vs.rank ?? null,
        eloA: ag.rating ?? null, rankA: ag.rank ?? null,
        votes: a.votes ?? null, effort: EFF.test(name),
        pin: e.pin, pout: e.pout, ctx: e.ctx, mout: e.mout,
        vision: e.vision, audio: e.audio, reason: e.reason, tools: e.tools,
        ow: e.ow, free: e.free, created: e.created, rel: e.rel};
    } else {
      const disp = name.replace(/\s*\([^)]*\)/g, '').replace(/[-_]/g, ' ')
        .split(/\s+/).filter(Boolean)
        .map(w => /^[a-z]\d[\d.]*$/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)).join(' ');
      row = {name: disp, vendor: org, arenaName: name, elo: ov.rating ?? null,
        eloLo: ov.lo ?? null, eloHi: ov.hi ?? null,
        rankO: ov.rank ?? null, eloZ: zh.rating ?? null, rankZ: zh.rank ?? null,
        eloC: co.rating ?? null, rankC: co.rank ?? null,
        eloM: mt.rating ?? null, rankM: mt.rank ?? null,
        eloW: cw.rating ?? null, rankW: cw.rank ?? null,
        eloD: wd.rating ?? null, rankD: wd.rank ?? null,
        eloV: vs.rating ?? null, rankV: vs.rank ?? null,
        eloA: ag.rating ?? null, rankA: ag.rank ?? null,
        votes: a.votes ?? null, effort: EFF.test(name),
        pin: null, pout: null, ctx: null, mout: null,
        vision: false, audio: false, reason: false, tools: false, ow: false, free: false,
        created: null, rel: null};
    }
    rows.push(row);
  }
  for (const e of Object.values(catalog)){
    if (used.has(e)) continue;
    rows.push({name: e.name, vendor: e.vendor, arenaName: null,
      elo: null, eloLo: null, eloHi: null, rankO: null, eloZ: null, rankZ: null,
      eloC: null, rankC: null, eloM: null, rankM: null, eloW: null, rankW: null,
      eloD: null, rankD: null, eloV: null, rankV: null, eloA: null, rankA: null,
      votes: null, effort: false, pin: e.pin, pout: e.pout, ctx: e.ctx, mout: e.mout,
      vision: e.vision, audio: e.audio, reason: e.reason, tools: e.tools,
      ow: e.ow, free: e.free, created: e.created, rel: e.rel});
  }
  let pub = null;
  for (const a of Object.values(arena)) if (a.pub && (!pub || a.pub > pub)) pub = a.pub;
  return {rows, pub};
}

(async () => {
  console.log('fetching arena boards (parquet)...');
  const arena = await fetchBoards();
  console.log('arena models:', Object.keys(arena).length);
  const [orList, mdApi] = await Promise.all([
    j('https://openrouter.ai/api/v1/models'),
    j('https://models.dev/api.json'),
  ]);
  console.log('openrouter models:', (orList.data || []).length);
  const {rows, pub} = buildRows(arena, orList.data, mdApi);
  const KEYS = ['name','vendor','arenaName','elo','eloLo','eloHi','rankO','eloZ','rankZ',
    'eloC','rankC','eloM','rankM','eloW','rankW','eloD','rankD','eloV','rankV','eloA','rankA',
    'votes','effort','pin','pout','ctx','mout','vision','audio','reason','tools','ow',
    'free','created','rel'];
  const slim = rows.map(r => {
    const d = {};
    for (const k of KEYS) if (r[k]) d[k] = r[k];
    return d;
  });
  const out = {gen: new Date().toISOString().slice(0, 10), arenaPub: pub, count: slim.length, rows: slim};
  fs.writeFileSync('data.json', JSON.stringify(out));
  const priced = slim.filter(r => r.pin != null).length;
  console.log(`data.json: ${slim.length} rows (${fs.statSync('data.json').size} bytes), priced ${priced}, arenaPub ${pub}`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
