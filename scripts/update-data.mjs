#!/usr/bin/env node
/* 每日数据管道：LMArena 官方数据集 + OpenRouter + models.dev → 合并 → data.json
 * ⚠️ 归一化/厂商映射/变体规则需与 index.html 内联脚本保持同步（改这里必须同步改页面）。
 * 任一数据源拉取失败即非零退出，保留上一天的 data.json（workflow 只在脚本成功后提交）。 */
import fs from 'node:fs';

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

async function fetchArena(){
  const out = {};
  for (let off = 0; off < 700; off += 100){
    const url = 'https://datasets-server.huggingface.co/rows?dataset=lmarena-ai%2Fleaderboard-dataset'
      + `&config=text&split=latest&offset=${off}&length=100`;
    const d = await j(url);
    if (d.error) throw new Error('arena: ' + d.error);
    for (const r of (d.rows || [])){
      const row = r.row;
      if (row.category !== 'overall' && row.category !== 'chinese') continue;
      const a = out[row.model_name] || (out[row.model_name] = {
        org: row.organization, votes: row.vote_count, pub: row.leaderboard_publish_date, cats: {}
      });
      a.cats[row.category] = {rank: row.rank, rating: row.rating,
        lo: row.rating_lower, hi: row.rating_upper};
    }
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
    const ov = a.cats.overall || {}, zh = a.cats.chinese || {};
    let row;
    if (e){
      used.add(e);
      row = {name: e.name, vendor: e.vendor === 'other' ? org : e.vendor,
        arenaName: name, elo: ov.rating ?? null, eloLo: ov.lo ?? null, eloHi: ov.hi ?? null,
        rankO: ov.rank ?? null, eloZ: zh.rating ?? null, rankZ: zh.rank ?? null,
        votes: a.votes ?? null, effort: EFF.test(name),
        pin: e.pin, pout: e.pout, ctx: e.ctx, mout: e.mout,
        vision: e.vision, audio: e.audio, reason: e.reason, tools: e.tools,
        ow: e.ow, free: e.free, created: e.created, rel: e.rel};
    } else {
      const disp = name.replace(/\s*\([^)]*\)/g, '').replace(/[-_]/g, ' ')
        .split(/\s+/).filter(Boolean)
        .map(w => /^[a-z]\d[\d.]*$/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)).join(' ');
      row = {name: disp, vendor: org, arenaName: name,
        elo: ov.rating ?? null, eloLo: ov.lo ?? null, eloHi: ov.hi ?? null,
        rankO: ov.rank ?? null, eloZ: zh.rating ?? null, rankZ: zh.rank ?? null,
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
      votes: null, effort: false, pin: e.pin, pout: e.pout, ctx: e.ctx, mout: e.mout,
      vision: e.vision, audio: e.audio, reason: e.reason, tools: e.tools,
      ow: e.ow, free: e.free, created: e.created, rel: e.rel});
  }
  let pub = null;
  for (const a of Object.values(arena)) if (a.pub && (!pub || a.pub > pub)) pub = a.pub;
  return {rows, pub};
}

(async () => {
  console.log('fetching arena...');
  const arena = await fetchArena();
  console.log('arena models:', Object.keys(arena).length);
  const [orList, mdApi] = await Promise.all([
    j('https://openrouter.ai/api/v1/models'),
    j('https://models.dev/api.json'),
  ]);
  console.log('openrouter models:', (orList.data || []).length);
  const {rows, pub} = buildRows(arena, orList.data, mdApi);
  const KEYS = ['name','vendor','arenaName','elo','eloLo','eloHi','rankO','eloZ','rankZ',
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
