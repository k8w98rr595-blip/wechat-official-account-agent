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

function interview(payload) {
  const sequence = [...QUESTIONS.shared, ...(payload.campaignType === "event" ? QUESTIONS.event : QUESTIONS.product), QUESTIONS.final];
  const question = sequence[payload.answers.length];
  return question ? { status: "question", question } : { status: "brief", brief: buildBrief(payload) };
}

function directions(brief) {
  const rawSubject = String(brief.subject || "本次宣传");
  const extracted = rawSubject.match(/(?:举办|发布|推出|宣传|开展)([^，。；]{2,18})/)?.[1];
  const subject = (extracted || rawSubject.split(/[，。；]/)[0] || "本次宣传").replace(/^一[场款次]/, "").slice(0, 20);
  return { directions: [
    { id: "value-first", title: `${subject}：先讲清楚为什么值得关注`, angle: "价值先行", outline: ["从目标读者的真实需求切入", "展开核心卖点与事实依据", "用清晰行动指令收束"] },
    { id: "scene-first", title: `${subject}：把读者带进真实场景`, angle: "场景体验", outline: ["用一个具体使用或参与场景开篇", "按体验顺序介绍亮点", "给出参与方式与注意事项"] },
    { id: "news-first", title: `${subject}：一篇清楚直接的正式发布`, angle: "信息发布", outline: ["开门见山公布核心信息", "分点说明内容与依据", "集中列出时间、方式与行动指令"] },
  ] };
}

function draft({ brief, direction, brand }) {
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

function rewrite({ text, instruction }) {
  const source = String(text || "").trim();
  if (/缩短|精简/.test(instruction)) return { replacement: source.length > 52 ? `${source.slice(0, 50).replace(/[，,。.]$/, "")}。` : source };
  if (/扩写/.test(instruction)) return { replacement: `${source} 这不仅是一条信息，更是一次让目标读者了解价值、建立信任并采取行动的机会。` };
  if (/号召|感染/.test(instruction)) return { replacement: `${source.replace(/[。！!]$/, "")}——现在就行动，亲自感受这份改变。` };
  return { replacement: `${source.replace(/[。！!]$/, "")}，用更清晰、更自然的方式抵达真正关心它的人。` };
}

function audit({ articleText, brief }) {
  const issues = [];
  if (/【待补充[:：]|待定/.test(articleText) || brief.missingFacts?.length) {
    issues.push({ id: "missing-facts", severity: "blocking", message: "文章仍含未确认事实，请补齐后再复制发布。", excerpt: brief.missingFacts?.join("、") || "待补充占位符" });
  }
  if (/百分百|绝对|第一|最[好佳强]/.test(articleText)) {
    issues.push({ id: "absolute-claim", severity: "warning", message: "检测到绝对化表达，请确认是否具备公开依据。" });
  }
  return { issues };
}

export function runStaticAgentOperation(operation, payload) {
  if (operation === "interview") return interview(payload);
  if (operation === "directions") return directions(payload.brief);
  if (operation === "draft") return draft(payload);
  if (operation === "rewrite") return rewrite(payload);
  if (operation === "audit") return audit(payload);
  throw new Error("未知 Agent 操作");
}
