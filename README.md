# AI Rank · AI 大模型排行榜

实时 AI 大模型对比与排行网站：LMArena 人类偏好评分 + OpenRouter/models.dev 实时价格与上下文，多维排行（智能 / 中文 / 性价比 / 低价 / 长上下文 / 最新），支持模型对比、中英双语、明暗主题。

**线上地址**: https://tliens.github.io/ai-model-rank/

## 特性
- 📊 六维排行：Arena 智能榜、中文榜、性价比、低价、长上下文、最新发布
- ⚖️ 最多 4 个模型并排对比
- 🔄 实时数据：每次打开页面从 LMArena 公开数据集 / OpenRouter / models.dev 拉取最新数据，网络失败自动降级为内置快照
- 🔒 纯前端、免费、无登录、不收集数据
- 🌍 中英双语（?lang=en）、明暗主题

## 数据来源
- 智能评分：[LMArena](https://lmarena.ai) 官方公开数据集（Elo）
- 价格/上下文：[OpenRouter](https://openrouter.ai) API、[models.dev](https://models.dev)

## 本地运行
直接双击 `index.html`，或 `python3 -m http.server 8747` 后访问 http://localhost:8747。

## 数据管道
GitHub Action（`update-data.yml`）每天 03:13 UTC 运行 `scripts/update-data.mjs`，拉取三个数据源合并为 `data.json` 并自动提交；页面打开时优先加载它（蓝色徽标），再后台拉实时接口刷新（绿色徽标）。任一数据源失败脚本即失败，保留上一天数据。

语言策略：默认英文，中国大陆 IP 自动中文；`?lang=zh` / `?lang=en` 可强制指定。支持 URL 状态分享（`?sort=&q=&v=&c=&cmp=`）。
