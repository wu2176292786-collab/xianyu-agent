import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LISTING_POLISH_TIMEOUT_MS,
  REPLY_POLISH_TIMEOUT_MS,
  acceptPolished,
  analyzeCompetition,
  draftTaskRules,
  judgeTaskRuleDraft,
  polishListingCopy,
  polishReply,
  SCREEN_VISION_BATCH,
  screenRivalCandidates,
} from "@/lib/agent/llm";

// `llmStatus()` 会读取本机配置；测试必须把它隔离，不能依赖开发机的密钥或模型选择。
const EMPTY_LLM_CONFIG_FILE = path.join(
  os.tmpdir(),
  `xianyu-agent-vitest-no-llm-config-${process.pid}.json`,
);

beforeEach(() => {
  vi.stubEnv("XIANYU_LLM_CONFIG_FILE", EMPTY_LLM_CONFIG_FILE);
});

/** 一条典型的议价草稿：买家出价 ¥3,000.00，按底价算出的还价是 ¥3,850.00。 */
const DRAFT =
  "会走路的鱼你好，¥3,000.00 确实做不了。\n" +
  "「iPhone 14 Pro」最低 ¥3,850.00，诚心要的话我改价给你，24 小时内发出。\n—— 老陈";

const KEEP = { mustKeep: [3850] };

describe("acceptPolished", () => {
  it("剥掉推理模型的思考块", () => {
    const raw = "<think>用户想让我改写得口语一点</think>\n\n你好，最低 ¥3,850.00，要的话我改价。";
    expect(acceptPolished(DRAFT, raw, KEEP)).toBe("你好，最低 ¥3,850.00，要的话我改价。");
  });

  it("也认 <thinking> 这种写法", () => {
    const raw = "<thinking>思考中</thinking>最低 ¥3,850.00 哦，¥3,000.00 真做不了。";
    expect(acceptPolished(DRAFT, raw, KEEP)).toBe("最低 ¥3,850.00 哦，¥3,000.00 真做不了。");
  });

  it("思考块没闭合且前面没有正文，直接弃用", () => {
    expect(acceptPolished(DRAFT, "<think>我先想想这个价格能不能再压一点", KEEP)).toBeNull();
  });

  it("思考块没闭合但前面已有正文，采用正文", () => {
    const raw = "最低 ¥3,850.00，要的话我改价。<think>后面被截断了";
    expect(acceptPolished(DRAFT, raw, KEEP)).toBe("最低 ¥3,850.00，要的话我改价。");
  });

  it("只看数值，换个写法也认", () => {
    const raw = "鱼总你好，3000 真到不了，最低 3850，诚心要我马上改价。";
    expect(acceptPolished(DRAFT, raw, KEEP)).toBe(raw);
    expect(acceptPolished(DRAFT, "最低 3,850 元，24 小时内发出。", KEEP)).not.toBeNull();
  });

  it("编一个草稿里没有的价格就弃用，写成裸数字也拦得住", () => {
    expect(acceptPolished(DRAFT, "你好，最低 ¥3,500.00，要的话我改价。", KEEP)).toBeNull();
    expect(acceptPolished(DRAFT, "你好，最低 3500，要的话我改价。", KEEP)).toBeNull();
  });

  it("擅自改动承诺时效也拦得住", () => {
    const raw = "鱼总你好，最低 3850，48 小时内发出。";
    expect(acceptPolished(DRAFT, raw, KEEP)).toBeNull();
  });

  it("把还价说没了也弃用", () => {
    const raw = "你好，这个价格真做不了，最低就这样了，诚心要我给你改价。";
    expect(acceptPolished(DRAFT, raw, KEEP)).toBeNull();
  });

  it("只删掉买家自己报的价是允许的", () => {
    const raw = "鱼总你好，这个价到不了，最低 ¥3,850.00，诚心要我马上改价。";
    expect(acceptPolished(DRAFT, raw, KEEP)).toBe(raw);
  });

  it("空输出弃用", () => {
    expect(acceptPolished(DRAFT, "   ", KEEP)).toBeNull();
    expect(acceptPolished(DRAFT, "<think>只有思考</think>", KEEP)).toBeNull();
  });

  it("不涉及金额的回复照常放行", () => {
    const plain = "在的，这款还有 2 件现货。";
    expect(acceptPolished(plain, "<think>x</think>在的，还有两件呢。")).toBe(
      "在的，还有两件呢。",
    );
    expect(acceptPolished(plain, "在的，还有 2 台现货。")).toBe("在的，还有 2 台现货。");
  });

  it("不涉及金额的回复里也不许凭空冒出价格", () => {
    const plain = "在的，这款还有 2 件现货。";
    expect(acceptPolished(plain, "在的，还有两件，99 元包邮。")).toBeNull();
  });

  it("商品文案允许结构数字，编售价仍弃用，漏写标价可以", () => {
    const draft = "WorkBuddy智能体实战课\n价格 ¥2.90\n36节高清视频，飞书接入。";
    const ok =
      "WorkBuddy 实战课\n\n3 个模块讲完 36 节高清视频，接飞书就能用。";
    expect(acceptPolished(draft, ok, { relaxSmallInts: true })).toBe(ok);
    expect(
      acceptPolished(draft, `${ok}\n当天发出。`, { relaxSmallInts: true }),
    ).toBe(`${ok}\n当天发出。`);
    expect(
      acceptPolished(draft, "只要 1.88，36节高清视频。", { relaxSmallInts: true }),
    ).toBeNull();
    expect(
      acceptPolished(draft, "超值只要 1299，36节高清视频。", { relaxSmallInts: true }),
    ).toBeNull();
  });
});

/**
 * 回落必须说得出原因。
 *
 * 「配了 LLM 却每次都回落」和「没配 LLM」在界面上长得一样的话，
 * 你会以为模型在干活，其实每一条都是模板。
 */
describe("polishReply 的回落原因", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function configure() {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_MODEL", "test-model");
    vi.stubEnv("OPENAI_BASE_URL", "https://example.invalid/v1");
  }

  const reply = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("没配 LLM 时不算「出问题」，不给回落原因", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const result = await polishReply(DRAFT, "背景", KEEP, { fetchImpl: reply({}) });
    expect(result.text).toBeNull();
    expect(result.fallback).toBeUndefined();
  });

  it("额度用光会把接口那句人话带出来", async () => {
    configure();
    const result = await polishReply(DRAFT, "背景", KEEP, {
      fetchImpl: reply(
        { error: { type: "rate_limit_error", message: "已达到 Token Plan 用量上限" } },
        429,
      ),
    });

    expect(result.text).toBeNull();
    expect(result.fallback).toContain("429");
    expect(result.fallback).toContain("已达到 Token Plan 用量上限");
  });

  it("模型改了数字时，回落原因说的是数字", async () => {
    configure();
    const result = await polishReply(DRAFT, "背景", KEEP, {
      fetchImpl: reply({
        choices: [{ message: { content: "你好，最低 3500，要的话我改价。" } }],
      }),
    });

    expect(result.text).toBeNull();
    expect(result.fallback).toContain("数字");
  });

  it("模型只改措辞就采用，没有回落原因", async () => {
    configure();
    const polished = "鱼总你好，3000 真到不了，最低 3850，诚心要我马上改价。";
    const result = await polishReply(DRAFT, "背景", KEEP, {
      fetchImpl: reply({ choices: [{ message: { content: polished } }] }),
    });

    expect(result.text).toBe(polished);
    expect(result.fallback).toBeUndefined();
  });

  it("网络挂了也回落，并说清是网络问题", async () => {
    configure();
    const result = await polishReply(DRAFT, "背景", KEEP, {
      fetchImpl: vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof fetch,
    });

    expect(result.text).toBeNull();
    expect(result.fallback).toContain("网络错误");
  });
});

describe("polishListingCopy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("只改措辞就采用，编价格就弃用", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_MODEL", "test-model");
    vi.stubEnv("OPENAI_BASE_URL", "https://example.invalid/v1");

    const draft = "Switch OLED 白色\n价格 ¥1,699.00\n原盒全套。";
    const ok = await polishListingCopy(draft, "研究同行", { mustKeep: [1699] }, {
      fetchImpl: vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "OLED 白色主机，原盒全套，1699 包邮。" } }],
          }),
        ),
      ) as unknown as typeof fetch,
    });
    expect(ok.text).toContain("1699");

    const bad = await polishListingCopy(draft, "研究同行", { mustKeep: [1699] }, {
      fetchImpl: vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "超值只要 1299，原盒全套。" } }],
          }),
        ),
      ) as unknown as typeof fetch,
    });
    expect(bad.text).toBeNull();
    expect(bad.fallback).toContain("1299");
  });

  it("商品润色回落会说出具体是哪个数字", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_MODEL", "test-model");
    vi.stubEnv("OPENAI_BASE_URL", "https://example.invalid/v1");

    const result = await polishListingCopy(
      "标题：WorkBuddy\n价格：¥2.90\n\n原文：\n36节高清视频",
      "写成闲鱼文案",
      {},
      {
        fetchImpl: vi.fn(async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "WorkBuddy\n\n只要 1.88 带走 36 节课。" } }],
            }),
          ),
        ) as unknown as typeof fetch,
      },
    );

    expect(result.text).toBeNull();
    expect(result.fallback).toContain("1.88");
    expect(result.fallback).not.toContain("改动了草稿里的数字或输出被截断");
  });

  it("商品文案给模型更长的等待，回复仍是短超时", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_MODEL", "test-model");
    vi.stubEnv("OPENAI_BASE_URL", "https://example.invalid/v1");
    const spy = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "OLED 白色主机，原盒全套，1699。" } }],
        }),
      ),
    ) as unknown as typeof fetch;

    await polishListingCopy("Switch OLED 白色\n价格 ¥1,699.00", "研究同行", {
      mustKeep: [1699],
    }, { fetchImpl });
    expect(spy).toHaveBeenCalledWith(LISTING_POLISH_TIMEOUT_MS);

    spy.mockClear();
    await polishReply("最低 3850，24 小时内发出。", "背景", { mustKeep: [3850] }, {
      fetchImpl,
    });
    expect(spy).toHaveBeenCalledWith(REPLY_POLISH_TIMEOUT_MS);
  });

  it("商品润色关掉推理并提高温度", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_MODEL", "test-model");
    vi.stubEnv("OPENAI_BASE_URL", "https://example.invalid/v1");

    let payload: {
      temperature?: number;
      thinking?: { type?: string };
      reasoning_split?: boolean;
    } = {};
    const fetchImpl = vi.fn(async (_url, init) => {
      payload = JSON.parse(String((init as RequestInit).body));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "OLED 白色主机\n\n原盒全套，1699。",
              },
            },
          ],
        }),
      );
    }) as unknown as typeof fetch;

    const result = await polishListingCopy(
      "标题：Switch OLED 白色\n价格：¥1,699.00\n\n原文：\n原盒全套。",
      "写成闲鱼文案",
      { mustKeep: [1699] },
      { fetchImpl },
    );

    expect(result.text).toContain("1699");
    expect(payload.temperature).toBe(0.7);
    expect(payload.thinking).toEqual({ type: "disabled" });
    expect(payload.reasoning_split).toBe(true);
  });
});

describe("analyzeCompetition", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function configure() {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_MODEL", "test-model");
    vi.stubEnv("OPENAI_BASE_URL", "https://example.invalid/v1");
  }

  const brief =
    "标题：AI图片定制服务\n挂牌价：¥5.00\n可比同行中位价是 ¥8.80\n正文写了包邮。";

  it("只改措辞就采用，编一个材料里没有的价就弃用", async () => {
    configure();
    const ok = await analyzeCompetition(brief, {
      fetchImpl: vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "你挂 5 元，比中位 8.8 低。同行写了包邮，标题可以点明定制范围。",
                },
              },
            ],
          }),
        ),
      ) as unknown as typeof fetch,
    });
    expect(ok.text).toContain("包邮");

    const bad = await analyzeCompetition(brief, {
      fetchImpl: vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "建议改到 3.5 元抢量。" } }],
          }),
        ),
      ) as unknown as typeof fetch,
    });
    expect(bad.text).toBeNull();
    expect(bad.fallback).toContain("数字");
  });
});

describe("screenRivalCandidates", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("只收下候选里的 itemId，编出来的丢掉", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_MODEL", "test-model");
    vi.stubEnv("OPENAI_BASE_URL", "https://example.invalid/v1");

    const result = await screenRivalCandidates(
      { title: "ai陪跑 内容获客客服自动化" },
      [
        { itemId: "svc-1", title: "AI陪跑 客服自动化" },
        { itemId: "book-1", title: "【二手】获客9787115498427" },
      ],
      {
        fetchImpl: vi.fn(async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      '[{"itemId":"svc-1","keep":true},{"itemId":"book-1","keep":false},{"itemId":"fake","keep":true}]',
                  },
                },
              ],
            }),
          ),
        ) as unknown as typeof fetch,
      },
    );

    expect(result.parsed).toBe(true);
    expect(result.keepIds).toEqual(["svc-1"]);
  });

  it("没配密钥就不调用", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await screenRivalCandidates(
      { title: "ai陪跑" },
      [{ itemId: "1", title: "二手书" }],
      { fetchImpl },
    );
    expect(result.parsed).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("没配视觉模型时请求体仍是纯文字", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_MODEL", "test-model");
    vi.stubEnv("OPENAI_BASE_URL", "https://example.invalid/v1");
    vi.stubEnv("OPENAI_VISION_MODEL", "");

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(typeof body.messages[1].content).toBe("string");
      expect(JSON.stringify(body)).not.toContain("image_url");
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '[{"itemId":"svc-1","keep":true}]' } }],
        }),
      );
    }) as unknown as typeof fetch;

    const result = await screenRivalCandidates(
      { title: "ai陪跑" },
      [{ itemId: "svc-1", title: "AI陪跑", imageUrl: "https://img.alicdn.com/a.jpg" }],
      { fetchImpl },
    );
    expect(result.keepIds).toEqual(["svc-1"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("配了视觉模型就带封面，detail 为 low，超过 8 个切批", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_MODEL", "test-model");
    vi.stubEnv("OPENAI_VISION_MODEL", "vision-model");
    vi.stubEnv("OPENAI_BASE_URL", "https://example.invalid/v1");

    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const content = body.messages[1].content as Array<{ type: string }>;
      expect(Array.isArray(content)).toBe(true);
      expect(body.model).toBe("vision-model");
      const images = content.filter((part) => part.type === "image_url");
      expect(images.length).toBe(content.filter((part) => part.type === "text").length - 1 || images.length);
      expect(
        images.every(
          (part) =>
            (part as unknown as { image_url: { detail: string } }).image_url.detail ===
            "low",
        ),
      ).toBe(true);
      const batchIds = String(
        (body.messages[1].content as Array<{ text?: string }>)[0]?.text ?? "",
      )
        .match(/itemId=([^\s]+)/g)
        ?.map((hit) => hit.slice("itemId=".length)) ?? [];
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  batchIds.map((itemId) => ({
                    itemId,
                    keep: Number(itemId.slice(3)) % 2 === 0,
                  })),
                ),
              },
            },
          ],
        }),
      );
    }) as unknown as typeof fetch;

    const candidates = Array.from({ length: SCREEN_VISION_BATCH + 1 }, (_, index) => ({
      itemId: `id-${index}`,
      title: `候选 ${index}`,
      imageUrl: `https://img.alicdn.com/${index}.jpg`,
    }));
    const result = await screenRivalCandidates(
      { title: "ai陪跑" },
      candidates,
      { fetchImpl },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodies).toHaveLength(2);
    expect(result.parsed).toBe(true);
    expect(new Set(result.keepIds).size).toBe(result.keepIds.length);
    expect(result.keepIds).toContain("id-0");
    expect(result.keepIds).toContain("id-8");
    expect(result.keepIds).not.toContain("id-1");
  });

  it("带图失败会记日志并回落到纯文字", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_MODEL", "text-model");
    vi.stubEnv("OPENAI_VISION_MODEL", "vision-model");
    vi.stubEnv("OPENAI_BASE_URL", "https://example.invalid/v1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    let calls = 0;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      if (calls === 1) {
        expect(body.model).toBe("vision-model");
        return new Response("image fetch denied", { status: 400 });
      }
      expect(body.model).toBe("text-model");
      expect(typeof body.messages[1].content).toBe("string");
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '[{"itemId":"svc-1","keep":true}]' } }],
        }),
      );
    }) as unknown as typeof fetch;

    const result = await screenRivalCandidates(
      { title: "ai陪跑" },
      [{ itemId: "svc-1", title: "AI陪跑", imageUrl: "https://img.alicdn.com/a.jpg" }],
      { fetchImpl },
    );
    expect(result.keepIds).toEqual(["svc-1"]);
    expect(warn.mock.calls.some((args) => String(args[0]).includes("带图筛选失败"))).toBe(
      true,
    );
  });
});

const OK_RULES = {
  name: "AI智能体课",
  keyword: "AI智能体 课程",
  mustInclude: ["智能体", "课程"],
  mustExclude: ["教材", "二手书"],
};

describe("judgeTaskRuleDraft", () => {
  it("四个字段齐全就放行", () => {
    expect(judgeTaskRuleDraft(OK_RULES)).toEqual(OK_RULES);
  });

  it("缺字段或不是字符串 / 数组就整份弃用", () => {
    expect(judgeTaskRuleDraft(null)).toBeNull();
    expect(judgeTaskRuleDraft({ ...OK_RULES, name: 1 })).toBeNull();
    expect(judgeTaskRuleDraft({ ...OK_RULES, keyword: "" })).toBeNull();
    expect(judgeTaskRuleDraft({ ...OK_RULES, keyword: "   " })).toBeNull();
    expect(judgeTaskRuleDraft({ ...OK_RULES, name: "" })).toBeNull();
    expect(judgeTaskRuleDraft({ ...OK_RULES, mustInclude: "智能体" })).toBeNull();
    expect(judgeTaskRuleDraft({ ...OK_RULES, mustExclude: ["教材", 2] })).toBeNull();
    const omitted = { ...OK_RULES };
    delete (omitted as { mustExclude?: string[] }).mustExclude;
    expect(judgeTaskRuleDraft(omitted)).toBeNull();
  });

  it("keyword 超过 30 字或 name 超过 40 字弃用", () => {
    expect(
      judgeTaskRuleDraft({ ...OK_RULES, keyword: "啊".repeat(31) }),
    ).toBeNull();
    expect(
      judgeTaskRuleDraft({ ...OK_RULES, name: "名".repeat(41) }),
    ).toBeNull();
  });

  it("空数组、超过 6 个词、单词超过 12 字都弃用", () => {
    expect(judgeTaskRuleDraft({ ...OK_RULES, mustInclude: [] })).toBeNull();
    expect(judgeTaskRuleDraft({ ...OK_RULES, mustExclude: ["", "  "] })).toBeNull();
    expect(
      judgeTaskRuleDraft({
        ...OK_RULES,
        mustInclude: ["一", "二", "三", "四", "五", "六", "七"],
      }),
    ).toBeNull();
    expect(
      judgeTaskRuleDraft({
        ...OK_RULES,
        mustExclude: ["这是一个超过十二个字的排除词"],
      }),
    ).toBeNull();
  });

  it("必须含和必须不含有交集就弃用", () => {
    expect(
      judgeTaskRuleDraft({
        ...OK_RULES,
        mustInclude: ["课程", "教材"],
        mustExclude: ["教材", "二手书"],
      }),
    ).toBeNull();
    expect(
      judgeTaskRuleDraft({
        ...OK_RULES,
        mustInclude: ["AI"],
        mustExclude: ["ai"],
      }),
    ).toBeNull();
  });

  it("去重、去空，大小写重复算同一个词", () => {
    expect(
      judgeTaskRuleDraft({
        ...OK_RULES,
        mustInclude: [" AI ", "AI", "课程"],
      }),
    ).toEqual({
      ...OK_RULES,
      mustInclude: ["AI", "课程"],
    });
  });
});

describe("draftTaskRules", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function configure() {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_MODEL", "test-model");
    vi.stubEnv("OPENAI_BASE_URL", "https://example.invalid/v1");
  }

  const reply = (content: string, status = 200) =>
    vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status,
        }),
    ) as unknown as typeof fetch;

  it("没配模型就不调用", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await draftTaskRules("找课", undefined, { fetchImpl });
    expect(result.draft).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("合法 JSON 写进草稿", async () => {
    configure();
    const result = await draftTaskRules(
      "我想找卖 AI 智能体课程的，不要卖教材和书的",
      undefined,
      { fetchImpl: reply(JSON.stringify(OK_RULES)) },
    );
    expect(result.draft).toEqual(OK_RULES);
  });

  it("残缺 JSON 不写草稿", async () => {
    configure();
    const result = await draftTaskRules("找课", undefined, {
      fetchImpl: reply('{"name":"课"}'),
    });
    expect(result.draft).toBeNull();
    expect(result.fallback).toContain("手填");
  });
});
