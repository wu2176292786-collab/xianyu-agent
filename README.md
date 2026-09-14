# 闲鱼运营 Agent v1 · Xianyu Ops Agent

给闲鱼卖家用的运营助手。它盯着你的商品、买家消息和订单，按你设定的规则把该做的事
整理成**带理由、可审批**的建议：擦亮什么、降价多少、怎么回复买家、哪笔订单该发货了。

高风险的动作永远不会自动执行 —— Agent 负责起草，你负责点头。

![总览](docs/screenshots/dashboard.png)

## 这是什么

- **总览**：曝光 / 成交额 / 待回复 / 待发货，14 天流量趋势，操作时间线
- **行动队列**：Agent 的每条建议都带着「为什么」，可以直接通过、改完再通过，或者忽略
- **消息**：识别买家意图（议价 / 咨询细节 / 催发货 / 问库存 / 售后），一键起草回复
- **商品**：擦亮、改价、下架；每个商品有**底价**，这是 Agent 的红线
- **订单**：发货时效倒计时，超时订单会被主动备单
- **自动化**：5 条规则的开关与参数，每条都能单独决定是否需要人工审批

每条建议都写清楚了「为什么」—— 上架多少天、浏览多少次、买家出价多少、超时几小时：

![行动队列](docs/screenshots/queue.png)

## 快速开始

```bash
npm install
npm run dev
```

打开 http://localhost:43117 。首次运行会自动生成一份示例店铺数据
（11 件商品、7 个会话、6 笔订单、14 天流量），存在 `.data/state.json`。

**不需要任何密钥或外部服务。** 点右上角「运行 Agent」就能看到它巡检一遍店铺。

在「自动化 → 店铺设置」里可以随时「重置示例数据」。

## 可选：接入 LLM

不配也能用 —— 回复由内置模板生成。配置之后，Agent 会在模板基础上做一次口语化润色，
调用失败会静默回落到模板：

```bash
# .env.local
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini          # 可选
OPENAI_BASE_URL=https://api.openai.com/v1   # 可选，兼容 OpenAI 协议的网关都行
```

## 关于真实账号

**v1 不会碰你的真实闲鱼账号。** 所有写操作都走 `MockXianyuAdapter`，只改本地状态，
同时模拟平台的副作用（擦亮带来曝光回升、发货扣库存并在归零时标记售罄）。

接入真实通道时，实现 `src/lib/adapters/types.ts` 里的 `XianyuAdapter` 接口即可，
规则引擎和界面不需要改动。

## 开发

```bash
npm run dev         # 开发服务器（端口 43117）
npm run test        # vitest：规则引擎 + 回复起草，44 个用例
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm run check       # 上面三件一起跑
npm run build       # 生产构建
npm run test:e2e    # 浏览器冒烟测试（需要先起服务，见下）
```

`npm run test:e2e` 用 `playwright-core` 驱动本机已装的 Chrome，把审批、回复、擦亮、
发货、规则开关和移动端布局跑一遍。它会先点一次「重置示例数据」，所以可以重复运行：

```bash
npm run build && npm run start &   # 或者 npm run dev
npm run test:e2e
CHROME_PATH=/path/to/chrome npm run test:e2e   # Chrome 不在默认位置时
```

`node scripts/screenshots.mjs` 会重新生成 README 里的截图。

### 目录结构

```
src/
├── app/                    页面（Server Components）与 Server Actions
│   ├── actions.ts          所有写操作的入口
│   ├── page.tsx            总览
│   ├── queue/              行动队列
│   ├── inbox/              消息
│   ├── listings/           商品
│   ├── orders/             订单
│   └── automations/        自动化规则与店铺设置
├── components/             UI 组件（shadcn/ui + 业务组件）
└── lib/
    ├── domain/             领域模型与示例数据
    ├── adapters/           平台适配层（v1 只有模拟通道）
    ├── agent/
    │   ├── engine.ts       规则引擎：状态 + 时间 → 建议
    │   ├── reply.ts        意图识别与回复起草
    │   └── llm.ts          可选的 LLM 润色
    └── store.ts            JSON 文件存储
tests/                      vitest 单元测试 + e2e.mjs 浏览器冒烟测试
scripts/screenshots.mjs     重新生成 README 截图
docs/plans/                 执行计划
```

### 两条写死的安全约束

1. 自动降价**永远不会低于商品底价**，适配层会二次拦截手动改价；
2. 售后、需要人工核实的细节咨询、低置信度的草稿**强制进审批队列**，
   哪怕对应规则被设成了自动执行。

## 技术栈

Next.js 16（App Router）· React 19 · TypeScript · Tailwind CSS v4 · shadcn/ui · Vitest

数据存在本地 JSON 文件里，换成真正的数据库只需要替换 `src/lib/store.ts`。
