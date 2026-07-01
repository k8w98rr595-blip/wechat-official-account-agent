const QUESTIONS = {
  shared: [
    { id: "audience", text: "这次宣传主要面向哪类读者？", hint: "例如：老客户、潜在企业客户、附近居民。" },
    { id: "objective", text: "这次宣传最希望读者采取什么行动？", hint: "例如：预约体验、报名活动、咨询销售。" },
  ],
  product: [
    { id: "selling-points", text: "最想突出的三个产品卖点是什么？", hint: "只写已确认、可以公开的事实。" },
    { id: "proof", text: "有哪些可验证的参数、案例或素材可以支撑这些卖点？", hint: "没有也可以回答“暂无”。" },
  ],
  event: [
    { id: "event-details", text: "活动时间、地点和参与方式分别是什么？", hint: "未确定的信息请直接写“待定”。" },
    { id: "experience", text: "参与者到现场能获得哪些具体体验或收获？", hint: "尽量列出可验证的环节。" },
  ],
  final: { id: "constraints", text: "有哪些必须保留的信息，或绝对不能出现的表达？", hint: "例如：禁用词、法律限制、品牌语气。" },
};

const SYSTEM_PROMPTS = {
  interview: "你是企业公众号营销策划 Agent。每次只追问一个最重要的问题，最多五轮；不得自行编造价格、日期、参数、案例或承诺。信息足够时返回 question 或 brief。",
  directions: "你是企业公众号内容策划。根据已确认营销简报给出恰好三组差异明确的标题与叙事提纲，不补充未经确认的事实。",
  draft: "你是企业公众号编辑。根据品牌档案、营销简报和选定方向写一篇中文公众号宣传文章。只使用已确认事实，缺失信息写成【待补充：具体项目】。正文只用 h1、h2、p、strong、em、blockquote、ul、ol、li、a、br、hr 标签。",
  rewrite: "你是谨慎的中文编辑。只改写用户选择的文本，严格保留事实、数字、专有名词和承诺边界。",
  audit: "你是营销事实审校员。对照营销简报检查未确认事实、绝对化表述、日期价格参数和行动信息，输出阻断项与警告。",
};

function answerOf(answers, id, fallback) {
  return answers.find((answer) => answer.questionId === id)?.answer?.trim() || fallback;
}

function cleanList(value) {
  return String(value || "").split(/[，,；;\n]/).map((item) => item.trim()).filter(Boolean);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function buildBrief(payload) {
  const isEvent = payload.campaignType === "event";
  const details = answerOf(payload.answers, isEvent ? "event-details" : "proof", "待补充");
  const message = answerOf(payload.answers, isEvent ? "experience" : "selling-points", "待补充");
  const restrictions = answerOf(payload.answers, "constraints", payload.brand?.forbiddenTerms || "无");
  const missingFacts = [];
  if (/待定|待补充|暂无/.test(details)) missingFacts.push(isEvent ? "活动时间、地点或参与方式" : "产品事实依据");
  if (/待补充/.test(message)) missingFacts.push(isEvent ? "现场体验内容" : "产品核心卖点");
  return {
    campaignType: payload.campaignType,
    subject: payload.idea,
    audience: answerOf(payload.answers, "audience", payload.brand?.targetAudience || "待补充"),
    objective: answerOf(payload.answers, "objective", payload.brand?.defaultCta || "待补充"),
    keyMessage: message,
    proofPoints: cleanList(details),
    cta: answerOf(payload.answers, "objective", payload.brand?.defaultCta || "待补充"),
    eventDetails: isEvent ? details : "不适用",
    restrictions: cleanList(restrictions),
    missingFacts,
  };
}

function mockInterview(payload) {
  const sequence = [...QUESTIONS.shared, ...(payload.campaignType === "event" ? QUESTIONS.event : QUESTIONS.product), QUESTIONS.final];
  const question = sequence[payload.answers.length];
  return question ? { status: "question", question } : { status: "brief", brief: buildBrief(payload) };
}

function mockDirections(brief) {
  const rawSubject = String(brief.subject || "本次宣传");
  const extracted = rawSubject.match(/(?:举办|发布|推出|宣传|开展)([^，。；]{2,18})/)?.[1];
  const subject = (extracted || rawSubject.split(/[，。；]/)[0] || "本次宣传").replace(/^一[场款次]/, "").slice(0, 20);
  return { directions: [
    { id: "value-first", title: `${subject}：先讲清楚为什么值得关注`, angle: "价值先行", outline: ["从目标读者的真实需求切入", "展开核心卖点与事实依据", "用清晰行动指令收束"] },
    { id: "scene-first", title: `${subject}：把读者带进真实场景`, angle: "场景体验", outline: ["用一个具体使用或参与场景开篇", "按体验顺序介绍亮点", "给出参与方式与注意事项"] },
    { id: "news-first", title: `${subject}：一篇清楚直接的正式发布`, angle: "信息发布", outline: ["开门见山公布核心信息", "分点说明内容与依据", "集中列出时间、方式与行动指令"] },
  ] };
}

function mockDraft({ brief, direction, brand }) {
  const proof = brief.proofPoints?.length ? brief.proofPoints : ["【待补充：可信依据】"];
  const company = brand?.companyName || "我们";
  return { articleHtml: [
    `<h1>${escapeHtml(direction.title)}</h1>`,
    `<p>${escapeHtml(brief.audience)}，这一次，${escapeHtml(company)}想把一件重要的事讲清楚：${escapeHtml(brief.keyMessage)}</p>`,
    "<blockquote>本文仅使用营销简报中已确认的信息；未确认内容会保留“待补充”标记。</blockquote>",
    `<h2>为什么值得关注</h2><p>${escapeHtml(brief.subject)}</p>`,
    `<h2>你将获得什么</h2><ul>${proof.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`,
    "<blockquote>【配图建议】在这里插入一张能够直接证明核心卖点的产品或活动现场图。</blockquote>",
    brief.campaignType === "event" ? `<h2>活动信息</h2><p>${escapeHtml(brief.eventDetails || "【待补充：活动时间、地点和参与方式】")}</p>` : "",
    `<h2>现在行动</h2><p><strong>${escapeHtml(brief.cta)}</strong></p>`,
  ].join("") };
}

function mockRewrite({ text, instruction }) {
  const source = String(text || "").trim();
  if (/缩短|精简/.test(instruction)) return { replacement: source.length > 52 ? `${source.slice(0, 50).replace(/[，,。.]$/, "")}。` : source };
  if (/扩写/.test(instruction)) return { replacement: `${source} 这不仅是一条信息，更是一次让目标读者了解价值、建立信任并采取行动的机会。` };
  if (/号召|感染/.test(instruction)) return { replacement: `${source.replace(/[。！!]$/, "")}——现在就行动，亲自感受这份改变。` };
  return { replacement: `${source.replace(/[。！!]$/, "")}，用更清晰、更自然的方式抵达真正关心它的人。` };
}

function mockAudit({ articleText, brief }) {
  const issues = [];
  if (/【待补充[:：]|待定/.test(articleText) || brief.missingFacts?.length) issues.push({ id: "missing-facts", severity: "blocking", message: "文章仍含未确认事实，请补齐后再复制发布。", excerpt: brief.missingFacts?.join("、") || "待补充占位符" });
  if (/百分百|绝对|第一|最[好佳强]/.test(articleText)) issues.push({ id: "absolute-claim", severity: "warning", message: "检测到绝对化表达，请确认是否具备公开依据。" });
  return { issues };
}

export function runMockOperation(operation, payload) {
  if (operation === "interview") return mockInterview(payload);
  if (operation === "directions") return mockDirections(payload.brief);
  if (operation === "draft") return mockDraft(payload);
  if (operation === "rewrite") return mockRewrite(payload);
  if (operation === "audit") return mockAudit(payload);
  throw new Error("未知 Agent 操作");
}

export function sanitizeArticleHtml(value) {
  const allowed = new Set(["h1", "h2", "p", "strong", "em", "blockquote", "ul", "ol", "li", "a", "br", "hr"]);
  return String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[^]*?-->/g, "")
    .replace(/<\/?([a-z0-9-]+)([^>]*)>/gi, (whole, rawTag, attributes) => {
      const tag = rawTag.toLowerCase();
      if (!allowed.has(tag)) return "";
      if (whole.startsWith("</")) return `</${tag}>`;
      if (tag === "a") {
        const href = String(attributes).match(/href\s*=\s*["']([^"']+)["']/i)?.[1] || "";
        return /^(https?:|mailto:)/i.test(href) ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">` : "<a>";
      }
      return `<${tag}>`;
    });
}

function validateResult(operation, value) {
  if (!value || typeof value !== "object") throw new Error("模型返回结果不是对象");
  if (operation === "interview" && !["question", "brief"].includes(value.status)) throw new Error("访谈结果缺少有效状态");
  if (operation === "directions" && (!Array.isArray(value.directions) || value.directions.length !== 3)) throw new Error("必须返回三组内容方向");
  if (operation === "draft" && typeof value.articleHtml !== "string") throw new Error("正文格式无效");
  if (operation === "rewrite" && typeof value.replacement !== "string") throw new Error("改写结果无效");
  if (operation === "audit" && !Array.isArray(value.issues)) throw new Error("审校结果无效");
  return value;
}

function parseJson(content) {
  return JSON.parse(String(content).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
}

async function providerCall(messages, env) {
  const base = String(env.AGENT_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  if (!env.AGENT_API_KEY || !env.AGENT_MODEL) throw new Error("模型服务尚未配置 AGENT_API_KEY 和 AGENT_MODEL");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(Number(env.AGENT_TIMEOUT_MS || 45000), 90000));
  try {
    const response = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.AGENT_API_KEY}` }, body: JSON.stringify({ model: env.AGENT_MODEL, temperature: 0.45, messages }), signal: controller.signal });
    const body = await response.text();
    if (!response.ok) throw new Error(`模型服务返回 ${response.status}: ${body.slice(0, 180)}`);
    const parsed = JSON.parse(body);
    const content = parsed.choices?.[0]?.message?.content;
    if (!content) throw new Error("模型服务未返回正文");
    return content;
  } finally { clearTimeout(timeout); }
}

export async function runAgentOperation(operation, payload, env = process.env) {
  if (!Object.hasOwn(SYSTEM_PROMPTS, operation)) throw new Error("未知 Agent 操作");
  if ((env.AGENT_PROVIDER_MODE || "mock") === "mock") return runMockOperation(operation, payload);
  const messages = [
    { role: "system", content: `${SYSTEM_PROMPTS[operation]}\n必须只返回有效 JSON，不要使用 Markdown 代码块。` },
    { role: "user", content: JSON.stringify(payload) },
  ];
  let content = await providerCall(messages, env);
  let result;
  try { result = validateResult(operation, parseJson(content)); }
  catch {
    content = await providerCall([...messages, { role: "assistant", content }, { role: "user", content: "上一个结果无法通过结构校验。请修复为有效 JSON，只返回 JSON。" }], env);
    result = validateResult(operation, parseJson(content));
  }
  if (operation === "draft") result.articleHtml = sanitizeArticleHtml(result.articleHtml);
  return result;
}
