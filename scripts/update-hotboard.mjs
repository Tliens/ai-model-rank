#!/usr/bin/env node
// AI Hot Board 数据管道（GitHub Actions 每 5 分钟运行：node scripts/update-data.mjs）
// 拉取 RSS / News 源 → 解析归一 → 按 AI 关键词过滤 + 分类 → 写 hotboard.json（AI Rank 页面热榜区块读取；脚本从原 ai-hot-board 仓库并入）
// 注意：分类关键词规则需与 index.html 内联脚本保持同步（页面端也有一份用于在线 API 条目分类）。

import { readFileSync, writeFileSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const MAX_AGE_H = 48;          // 只保留 48h 内条目
const MAX_ITEMS = 240;         // hotboard.json 上限，控制体积

// ---------- 分类关键词（与 index.html 保持同步） ----------
const AI_RE = /\bai\b|a\.i\.|artificial intelligence|openai|gpt|chatgpt|claude|anthropic|gemini|copilot|llm|large language model|machine learning|deep learning|mistral|llama|qwen|deepseek|kimi|grok|midjourney|sora|人工智能|大模型|机器学习|深度学习|智能体|生成式|文生|开源模型/i;
const MONEY_KW = [
  /\bfund(ed|ing|rais\w*)?\b/i, /\braise[ds]?\b/i, /\bseries [abc]\b/i, /\bseed (round|funding)\b/i,
  /\bvalued at\b/i, /\bvaluation\b/i, /\bacqui(f|s)\w*/i, /\bmerger\b/i, /\bipo\b/i, /\brevenue\b/i,
  /\barr\b/i, /\bmonet\w+/i, /\bprofitab\w+/i, /\bbillion\b/i, /\bventure\b/i, /\bstartup\b/i,
  /\by combinator\b/i, /\bvc funding\b/i,
  /融资/, /创投/, /创业/, /估值/, /收购/, /并购/, /上市/, /变现/, /搞钱/, /副业/, /月入/, /营收/, /商业化/, /赚钱/,
];
const DEALS_KW = [
  /\bfree (credits?|tier|trial|plan|access)\b/i, /\bcoupon\b/i, /\bpromo( code)?\b/i, /\bdiscount\b/i,
  /(\d+)%\s*off/i, /\bgiveaway\b/i, /\bblack friday\b/i, /\bdeal(s)?\b/i,
  /优惠/, /折扣/, /免费/, /白嫖/, /福利/, /额度/, /代金券/, /特价/, /立减/, /半价/,
];
const MODELS_KW = [
  /\b(gpt-?\w+|chatgpt|claude|gemini|llama|qwen|deepseek|mistral|kimi|glm|grok|copilot|sora|midjourney)\b/i,
  /\bllms?\b/i, /\blarge language model/i, /open[- ]?(source|weights)/i, /\bbenchmark\b/i,
  /\bcontext window\b/i, /\bfine-?tun/i, /多模态/, /开源/, /模型/, /推理能力/, /文生图/, /文生视频/, /智能体/,
];

function classify(text, fallback) {
  let money = 0, deals = 0, models = 0;
  for (const re of MONEY_KW) if (re.test(text)) money++;
  for (const re of DEALS_KW) if (re.test(text)) deals++;
  for (const re of MODELS_KW) if (re.test(text)) models++;
  deals *= 1.5; // 优惠词更特异，加权
  const best = Math.max(money, deals, models);
  if (best === 0) return fallback;
  if (best === deals) return 'deals';
  if (best === money) return 'money';
  return 'models';
}

// ---------- 轻量 XML 解析（RSS 2.0 + Atom） ----------
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'); // 必须最后
}
const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeEntities(m[1]).trim() : '';
};
const attrLink = (block) => {
  const m = block.match(/<link[^>]*href="([^"]+)"/i);
  return m ? decodeEntities(m[1]) : '';
};

function parseFeed(xml) {
  const items = [];
  const isAtom = /<feed[\s>]/i.test(xml);
  const blocks = isAtom
    ? xml.split(/<entry[\s>]/i).slice(1).map((b) => b.split(/<\/entry>/i)[0])
    : xml.split(/<item[\s>]/i).slice(1).map((b) => b.split(/<\/item>/i)[0]);
  for (const b of blocks) {
    const title = tag(b, 'title');
    const link = isAtom ? attrLink(b) : (tag(b, 'link') || attrLink(b));
    const dateStr = tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published');
    const date = dateStr ? new Date(dateStr) : new Date();
    // Google News 条目里的 <source>Name</source> 是真实出版方
    const publisher = tag(b, 'source');
    if (!title || !link) continue;
    items.push({ title, link, date: isNaN(date) ? new Date() : date, publisher });
  }
  return items;
}

// ---------- 源配置 ----------
const gnews = (cat, q, lang) => ({
  kind: 'gnews', cat, lang,
  url: `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${lang === 'z' ? 'zh-CN' : 'en-US'}&gl=${lang === 'z' ? 'CN' : 'US'}&ceid=${lang === 'z' ? 'CN:zh-Hans' : 'US:en'}`,
});
const SOURCES = [
  gnews('money', 'AI 创业 OR AI 融资 OR AI 变现', 'z'),
  gnews('money', 'AI startup funding', 'e'),
  gnews('models', '大模型 OR 开源模型', 'z'),
  gnews('models', 'GPT OR LLM AI model', 'e'),
  gnews('deals', 'AI 优惠 OR AI 免费额度 OR AI 折扣', 'z'),
  gnews('deals', 'AI free credits OR AI discount', 'e'),
  { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', source: 'TechCrunch', lang: 'e' },
  { url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', source: 'The Verge', lang: 'e' },
  { url: 'https://arstechnica.com/ai/feed/', source: 'Ars Technica', lang: 'e' },
  { url: 'https://www.ifanr.com/feed', source: '爱范儿', lang: 'z' },
  { url: 'https://sspai.com/feed', source: '少数派', lang: 'z' },
];

async function fetchText(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(t); }
}

// ---------- 归一与去重 ----------
const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); };
const normUrl = (u) => u.replace(/^https?:\/\//, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
const titleKey = (t) => t.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

async function main() {
  const results = await Promise.allSettled(SOURCES.map(async (src) => {
    const xml = await fetchText(src.url);
    return { src, items: parseFeed(xml) };
  }));
  const ok = results.filter((r) => r.status === 'fulfilled');
  console.log(`feeds ok: ${ok.length}/${SOURCES.length}`);

  const byKey = new Map();
  for (const { value } of ok) {
    const { src, items } = value;
    for (const it of items) {
      const ageH = (Date.now() - it.date.getTime()) / 36e5;
      if (ageH < -2 || ageH > MAX_AGE_H) continue;
      let title = it.title;
      if (src.kind === 'gnews') title = title.replace(/\s+-\s+[^-]{2,40}$/, '').trim() || it.title; // 去掉 “ - 出版方” 尾巴
      const text = title;
      const key = titleKey(title).slice(0, 80) || normUrl(it.link);
      if (byKey.has(key)) continue;
      // 通用媒体源：仅保留命中 AI 词的条目；Google News 类目查询天然命中
      if (src.kind !== 'gnews' && !AI_RE.test(text)) continue;
      const cat = src.kind === 'gnews' ? src.cat : classify(text, 'models');
      byKey.set(key, {
        i: hash(normUrl(it.link) + titleKey(title)),
        t: title, u: it.link,
        s: src.kind === 'gnews' ? (it.publisher || 'Google News') : src.source,
        c: cat, d: it.date.toISOString(), g: src.lang,
      });
    }
  }

  const items = [...byKey.values()]
    .sort((a, b) => b.d.localeCompare(a.d))
    .slice(0, MAX_ITEMS);
  const data = { updated: new Date().toISOString(), items };
  writeFileSync(new URL('../hotboard.json', import.meta.url), JSON.stringify(data));
  console.log(`hotboard.json: ${items.length} items`);
  const cats = items.reduce((m, x) => ((m[x.c] = (m[x.c] || 0) + 1), m), {});
  console.log('by category:', JSON.stringify(cats));
  // 抽样验证解析规则
  for (const it of items.slice(0, 3)) console.log(' sample:', it.c, '|', it.t.slice(0, 60), '|', it.u.slice(0, 60));
}

main().catch((e) => { console.error(e); process.exit(1); });
