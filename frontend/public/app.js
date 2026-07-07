import { runStaticAgentOperation } from "./mock-agent.js";
import { runAgentOperation } from "./agent-core.js";
import { DEFAULT_BRAND, createEmptyWorkspace, normalizeWorkspaceBackup } from "./workspace-schema.js";
import { decryptBackup, encryptBackup, isEncryptedBackup } from "./backup-crypto.js";

const EMPTY_WORKSPACE = createEmptyWorkspace();
const STATUS_LABELS = { idea: "想法", interview: "访谈", brief: "简报", directions: "提纲", draft: "草稿" };
const STEPS = ["想法", "营销简报", "标题与提纲", "正文"];
const DB_NAME = "wechat-content-agent";
let workspace = structuredClone(EMPTY_WORKSPACE);
let busy = false;
let selectedRange;
let selectedText = "";
let rewritePreview;
let saveTimer;
let saveChain = Promise.resolve();
let deepSeekApiKey = "";
let remoteAccessToken = "";
const configuredApiBaseUrl = String(window.AGENT_CONFIG?.apiBaseUrl || "").replace(/\/$/, "");
const saasEnabled = Boolean(window.AGENT_CONFIG?.saasEnabled);
const remoteAgentConfigured = Boolean(configuredApiBaseUrl);
const directDeepSeekMode = location.hostname.endsWith(".github.io") && !remoteAgentConfigured && !saasEnabled;
const embeddedMode = window.self !== window.top;
let staticAgentMode = location.protocol === "file:";
let saasSessionToken = sessionStorage.getItem("wechat-saas-session") || "";
let saasUser;
let saasOrganizations = [];
let activeOrganizationId = sessionStorage.getItem("wechat-saas-organization") || "";
let activeOrganizationRole = "";
let activeSubscription;
let cloudWorkspaceVersion = 0;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
const activeProject = () => workspace.projects.find((project) => project.id === workspace.activeProjectId);
const icon = (name) => `<i class="ph ph-${name}" aria-hidden="true"></i>`;

function sanitizeArticleClient(value) {
  const allowed = new Set(["H1", "H2", "P", "STRONG", "B", "EM", "I", "BLOCKQUOTE", "UL", "OL", "LI", "A", "BR", "HR", "DIV"]);
  const parsed = new DOMParser().parseFromString(String(value || ""), "text/html");
  [...parsed.body.querySelectorAll("*")].forEach((element) => {
    if (!allowed.has(element.tagName)) { element.replaceWith(...element.childNodes); return; }
    const href = element.tagName === "A" ? element.getAttribute("href") || "" : "";
    [...element.attributes].forEach((attribute) => element.removeAttribute(attribute.name));
    if (element.tagName === "A" && /^(https?:|mailto:)/i.test(href)) { element.setAttribute("href", href); element.setAttribute("target", "_blank"); element.setAttribute("rel", "noopener noreferrer"); }
  });
  return parsed.body.innerHTML;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("workspace");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadLocalWorkspace() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("workspace", "readonly").objectStore("workspace").get("current");
    request.onsuccess = () => {
      if (!request.result) return resolve(createEmptyWorkspace());
      try { resolve(sanitizeWorkspaceContent(normalizeWorkspaceBackup(request.result))); }
      catch (error) { reject(error); }
    };
    request.onerror = () => reject(request.error);
  });
}

function sanitizeWorkspaceContent(value) {
  value.projects.forEach((project) => {
    project.articleHtml = sanitizeArticleClient(project.articleHtml);
    project.versions = project.versions.map((version) => ({ ...version, html: sanitizeArticleClient(version.html) }));
  });
  return value;
}

async function persistLocalWorkspace() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("workspace", "readwrite").objectStore("workspace").put(workspace, "current");
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
}

async function saasRequest(path, { method = "GET", body, organization = true } = {}) {
  const response = await fetch(`${configuredApiBaseUrl}/api/saas${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(saasSessionToken ? { authorization: `Bearer ${saasSessionToken}` } : {}),
      ...(organization && activeOrganizationId ? { "x-organization-id": activeOrganizationId } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = response.headers.get("content-type")?.includes("application/json") ? await response.json() : { error: "服务返回了无法解析的响应" };
  if (!response.ok) {
    if (response.status === 401 && saasSessionToken) clearSaasSession();
    const error = new Error(result.error || "SaaS 请求失败");
    error.code = result.code;
    error.status = response.status;
    error.currentVersion = result.currentVersion;
    throw error;
  }
  return result;
}

function clearSaasSession() {
  saasSessionToken = "";
  saasUser = undefined;
  saasOrganizations = [];
  activeOrganizationId = "";
  activeOrganizationRole = "";
  activeSubscription = undefined;
  sessionStorage.removeItem("wechat-saas-session");
  sessionStorage.removeItem("wechat-saas-organization");
}

function acceptSaasSession(result) {
  saasSessionToken = result.token;
  saasUser = result.user;
  saasOrganizations = result.organizations || [];
  activeOrganizationId = saasOrganizations.some((item) => item.organization.id === activeOrganizationId)
    ? activeOrganizationId
    : saasOrganizations[0]?.organization.id || result.organization?.id || "";
  sessionStorage.setItem("wechat-saas-session", saasSessionToken);
  sessionStorage.setItem("wechat-saas-organization", activeOrganizationId);
}

async function loadCloudWorkspace() {
  const result = await saasRequest("/workspace");
  cloudWorkspaceVersion = result.version;
  workspace = sanitizeWorkspaceContent(normalizeWorkspaceBackup(result.data));
  const organization = await saasRequest("/organization");
  activeOrganizationRole = organization.role;
  activeSubscription = organization.subscription;
}

async function persistWorkspace() {
  if (!saasEnabled || !saasSessionToken) return persistLocalWorkspace();
  const result = await saasRequest("/workspace", { method: "PUT", body: { version: cloudWorkspaceVersion, data: workspace } });
  cloudWorkspaceVersion = result.version;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveChain = saveChain.then(() => persistWorkspace()).catch((error) => {
      showToast(error?.code === "VERSION_CONFLICT" ? "云端版本已变化，请刷新页面后继续" : "自动保存失败，请导出备份", "error");
    });
  }, 350);
}

function updateProject(id, updater) {
  workspace.projects = workspace.projects.map((project) => project.id === id ? { ...updater(project), updatedAt: now() } : project);
  scheduleSave();
}

async function api(operation, payload) {
  if (staticAgentMode) return runStaticAgentOperation(operation, payload);
  if (directDeepSeekMode) {
    const apiKey = await requestDeepSeekApiKey();
    try {
      return await runAgentOperation(operation, payload, {
        AGENT_PROVIDER_MODE: "openai-compatible",
        AGENT_BASE_URL: "https://api.deepseek.com",
        AGENT_API_KEY: apiKey,
        AGENT_MODEL: "deepseek-v4-flash",
        AGENT_MODEL_QUALITY: "deepseek-v4-pro",
        AGENT_THINKING_MODE: "operation-based",
        AGENT_TIMEOUT_MS: "60000",
      });
    } catch (error) {
      if (/\b(?:401|403)\b/.test(error instanceof Error ? error.message : "")) {
        deepSeekApiKey = "";
      }
      throw error;
    }
  }
  if (remoteAgentConfigured) {
    if (saasEnabled && !saasSessionToken) throw new Error("请先登录企业工作区");
    if (!saasEnabled && !remoteAccessToken) {
      remoteAccessToken = String(window.prompt("请输入写作 Agent 访问码。它不是 DeepSeek API Key。") || "").trim();
      if (!remoteAccessToken) throw new Error("需要访问码才能使用真实 AI");
    }
  }
  try {
    const response = await fetch(`${configuredApiBaseUrl || "."}/api/agent/${operation}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(saasEnabled ? { authorization: `Bearer ${saasSessionToken}`, "x-organization-id": activeOrganizationId, ...(operation === "draft" ? { "x-idempotency-key": uid() } : {}) } : {}),
        ...(!saasEnabled && remoteAccessToken ? { authorization: `Bearer ${remoteAccessToken}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    const isJson = response.headers.get("content-type")?.includes("application/json");
    if (!remoteAgentConfigured && response.status === 404 && !isJson) {
      staticAgentMode = true;
      return runStaticAgentOperation(operation, payload);
    }
    const result = isJson ? await response.json() : { error: "服务返回了无法解析的响应" };
    if (saasEnabled && response.status === 401) {
      clearSaasSession();
      throw new Error("登录已失效，请重新登录");
    }
    if (remoteAgentConfigured && !saasEnabled && response.status === 401) {
      remoteAccessToken = "";
      throw new Error("访问码不正确，请重新操作并输入正确的访问码");
    }
    if (!response.ok) throw new Error(result.error || "Agent 请求失败");
    return result;
  } catch (error) {
    if (!remoteAgentConfigured && error instanceof TypeError) {
      staticAgentMode = true;
      return runStaticAgentOperation(operation, payload);
    }
    throw error;
  }
}

function requestDeepSeekApiKey() {
  if (embeddedMode) return Promise.reject(new Error("为保护 API Key，请直接打开本站，不要在嵌入页面中使用"));
  if (deepSeekApiKey) return Promise.resolve(deepSeekApiKey);
  return new Promise((resolve, reject) => {
    const root = $("#modal-root");
    root.innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="deepseek-key-title"><header class="modal-header"><h2 id="deepseek-key-title">连接 DeepSeek</h2><button class="icon-button modal-close" type="button" aria-label="关闭">${icon("x")}</button></header><form id="deepseek-key-form" class="modal-form"><p>API Key 仅保存在当前页面内存中，并直接发送至 DeepSeek 官方接口。刷新或关闭页面后自动清除。</p><label>DeepSeek API Key<input id="deepseek-key-input" type="password" autocomplete="off" spellcheck="false" placeholder="sk-…" required></label><button class="button primary full" type="submit">连接真实 AI</button></form></section></div>`;
    const finish = (key) => {
      root.innerHTML = "";
      if (!key) reject(new Error("需要 DeepSeek API Key 才能使用真实 AI"));
      else {
        deepSeekApiKey = key;
        resolve(key);
      }
    };
    $(".modal-close", root).addEventListener("click", () => finish(""));
    $(".modal-backdrop", root).addEventListener("mousedown", (event) => { if (event.target.classList.contains("modal-backdrop")) finish(""); });
    $("#deepseek-key-form", root).addEventListener("submit", (event) => {
      event.preventDefault();
      finish($("#deepseek-key-input", root).value.trim());
    });
    $("#deepseek-key-input", root).focus();
  });
}

function agentStatusLabel() {
  if (saasEnabled) return `DeepSeek V4 · ${activeSubscription?.draftsRemaining ?? "-"}篇`;
  if (remoteAgentConfigured || directDeepSeekMode) return "DeepSeek V4";
  return staticAgentMode ? "演示模式" : "本地 AI";
}

async function runTask(task) {
  busy = true; renderAgent(); renderCanvasHeaderOnly();
  try { return await task(); }
  catch (error) { showToast(error instanceof Error ? error.message : "操作失败", "error"); }
  finally { busy = false; renderAgent(); renderCanvasHeaderOnly(); }
}

function showToast(message, type = "success") {
  const root = $("#toast-root");
  root.innerHTML = `<div class="toast ${type}" role="${type === "error" ? "alert" : "status"}">${escapeHtml(message)}</div>`;
  setTimeout(() => { if (root.textContent === message) root.innerHTML = ""; }, 2800);
}

function openModal(title, content, setup, wide = false) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-backdrop"><section class="modal ${wide ? "modal-wide" : ""}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}"><header class="modal-header"><h2>${escapeHtml(title)}</h2><button class="icon-button modal-close" type="button" aria-label="关闭">${icon("x")}</button></header>${content}</section></div>`;
  $(".modal-backdrop", root).addEventListener("mousedown", (event) => { if (event.target.classList.contains("modal-backdrop")) closeModal(); });
  $(".modal-close", root).addEventListener("click", closeModal);
  setup?.(root);
}

function closeModal() { $("#modal-root").innerHTML = ""; }

function renderSidebar() {
  const list = $("#project-list");
  list.innerHTML = `<div class="section-label">最近项目</div>${workspace.projects.length ? workspace.projects.map((project) => `
    <button type="button" class="project-row ${project.id === workspace.activeProjectId ? "selected" : ""}" data-project-id="${project.id}">
      ${icon("folder")}<span class="project-row-copy"><span class="project-title">${escapeHtml(project.title)}</span><span class="project-meta">${project.campaignType === "product" ? "产品宣传" : "活动宣传"} · ${STATUS_LABELS[project.status]}</span></span>
    </button>`).join("") : '<p class="empty-projects">还没有文章项目</p>'}`;
  $$('[data-project-id]', list).forEach((button) => button.addEventListener("click", () => {
    workspace.activeProjectId = button.dataset.projectId;
    selectedRange = undefined; selectedText = ""; rewritePreview = undefined;
    scheduleSave(); renderAll(); closeSidebar();
  }));
}

function showNewProject() {
  openModal("新建宣传文章", `<form id="new-project-form" class="form-stack">
    <label>项目名称<input name="title" placeholder="例如：夏日新品发布" maxlength="80" autofocus></label>
    <fieldset><legend>宣传类型</legend><div class="segmented-control"><button type="button" class="selected" data-type="product">产品宣传</button><button type="button" data-type="event">活动宣传</button></div></fieldset>
    <label>粗浅想法<textarea name="idea" rows="6" maxlength="4000" placeholder="不用整理，写下产品、活动和你最想表达的几句话。Agent 会继续追问。"></textarea></label>
    <div class="modal-actions"><button class="button secondary modal-cancel" type="button">取消</button><button class="button primary" type="submit">开始创作</button></div>
  </form>`, (root) => {
    let campaignType = "product";
    $$('[data-type]', root).forEach((button) => button.addEventListener("click", () => {
      campaignType = button.dataset.type;
      $$('[data-type]', root).forEach((item) => item.classList.toggle("selected", item === button));
    }));
    $(".modal-cancel", root).addEventListener("click", closeModal);
    $("#new-project-form", root).addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const title = String(data.get("title") || "").trim();
      const idea = String(data.get("idea") || "").trim();
      if (title.length < 2 || idea.length < 5) return showToast("请填写项目名称和至少五个字的想法", "error");
      const time = now();
      const project = { id: uid(), title, campaignType, idea, status: "idea", messages: [], answers: [], directions: [], articleHtml: "", versions: [], assets: [], auditIssues: [], createdAt: time, updatedAt: time };
      workspace.projects.unshift(project); workspace.activeProjectId = project.id;
      scheduleSave(); closeModal(); renderAll();
    });
  });
}

function showBrandSettings() {
  const fields = [
    ["companyName", "公司或品牌名称", "用于文章署名与自称"], ["targetAudience", "主要目标客户", "例如：正在数字化转型的中小企业"],
    ["tone", "品牌语气", "例如：专业、清晰、有温度"], ["defaultCta", "默认行动指令", "例如：预约体验或联系顾问"],
    ["summary", "品牌简介", "公司做什么，解决什么问题", true], ["keyPoints", "长期产品事实", "可公开的产品能力、资质与事实依据", true],
    ["forbiddenTerms", "禁用词与限制", "用逗号分隔"],
  ];
  openModal("品牌档案", `<form id="brand-form" class="brand-form"><p class="form-intro">这些内容会作为每次创作的固定上下文。只填写可以公开、可以验证的信息。</p><div class="form-grid">
    ${fields.map(([key, label, placeholder, multi]) => `<label class="${multi ? "span-two" : ""}">${label}${multi ? `<textarea name="${key}" rows="3" placeholder="${placeholder}">${escapeHtml(workspace.brand[key])}</textarea>` : `<input name="${key}" value="${escapeHtml(workspace.brand[key])}" placeholder="${placeholder}">`}</label>`).join("")}
    <label>品牌主色<div class="color-input"><input name="primaryColor" type="color" value="${workspace.brand.primaryColor}"><span>${workspace.brand.primaryColor}</span></div></label>
    <label>辅助色<div class="color-input"><input name="accentColor" type="color" value="${workspace.brand.accentColor}"><span>${workspace.brand.accentColor}</span></div></label>
  </div><div class="modal-actions"><button class="button secondary modal-cancel" type="button">取消</button><button class="button primary" type="submit">保存品牌档案</button></div></form>`, (root) => {
    $(".modal-cancel", root).addEventListener("click", closeModal);
    $$('input[type="color"]', root).forEach((input) => input.addEventListener("input", () => input.nextElementSibling.textContent = input.value));
    $("#brand-form", root).addEventListener("submit", (event) => {
      event.preventDefault(); const data = new FormData(event.currentTarget);
      workspace.brand = Object.fromEntries(Object.keys(DEFAULT_BRAND).map((key) => [key, String(data.get(key) || DEFAULT_BRAND[key])]));
      scheduleSave(); closeModal(); renderCanvas(); showToast("品牌档案已保存");
    });
  }, true);
}

function currentStep(status) { return status === "idea" ? 0 : ["interview", "brief"].includes(status) ? 1 : status === "directions" ? 2 : 3; }

function renderAgent() {
  const panel = $("#agent-panel");
  const project = activeProject();
  if (!project) {
    panel.innerHTML = `<header class="agent-header"><div class="agent-title"><h1>Agent</h1><span><b></b>${agentStatusLabel()}</span></div></header><div class="empty-agent"><div class="agent-empty-icon">${icon("sparkle")}</div><h1>从一个粗浅想法开始</h1><p>建立项目后，Agent 会一次追问一个关键问题，再整理成可确认的营销简报。</p></div>`;
    return;
  }
  const step = currentStep(project.status);
  const inspectorContext = project.status === "draft" && project.brief
    ? draftInspectorSummary(project)
    : `<div class="idea-source"><span>最初想法</span><p>${escapeHtml(project.idea)}</p></div>
      ${project.messages.map((message) => `<div class="message ${message.role}"><span class="message-avatar">${message.role === "agent" ? icon("sparkle") : "你"}</span><div><span class="message-role">${message.role === "agent" ? "Agent" : "你"}</span><p>${escapeHtml(message.text)}</p></div></div>`).join("")}`;
  panel.innerHTML = `<header class="agent-header"><div class="agent-title"><h1>Agent</h1><span><b></b>${agentStatusLabel()}</span></div><button id="asset-upload-button" class="icon-button" type="button" title="添加图片素材" aria-label="添加图片素材">${icon("image")}</button><input id="asset-file" hidden type="file" accept="image/*"></header>
    <div class="workflow-steps">${STEPS.map((label, index) => `<div class="${index === step ? "current" : ""} ${index < step ? "done" : ""}"><span>${index < step ? icon("check") : index + 1}</span>${label}</div>`).join("")}</div>
    <div class="agent-scroll">${inspectorContext}${agentStatusContent(project)}
    </div>${project.status === "interview" ? `<div class="agent-composer"><textarea id="agent-answer" rows="2" placeholder="回复 Agent…"></textarea><button id="send-answer" type="button" aria-label="发送回复" ${busy ? "disabled" : ""}>${busy ? icon("circle-notch") : icon("arrow-up")}</button></div>` : ""}`;
  bindAgentEvents(project);
}

function draftInspectorSummary(project) {
  const brief = project.brief;
  return `<section class="inspector-brief"><div class="section-row"><h2>当前创作简报</h2><span>已确认</span></div><dl>
    <div><dt>主题</dt><dd>${escapeHtml(brief.subject)}</dd></div>
    <div><dt>目标读者</dt><dd>${escapeHtml(brief.audience)}</dd></div>
    <div><dt>核心卖点</dt><dd>${escapeHtml(brief.keyMessage)}</dd></div>
    <div><dt>风格语气</dt><dd>${escapeHtml(workspace.brand.tone)}</dd></div>
  </dl></section>`;
}

function agentStatusContent(project) {
  if (project.status === "idea") return `<div class="action-block"><h2>准备开始访谈</h2><p>Agent 将结合品牌档案，在五个问题内补齐文章所需事实。</p><button id="start-interview" class="button primary" type="button" ${busy ? "disabled" : ""}>${busy ? `${icon("circle-notch")} 正在准备` : `${icon("sparkle")} 开始梳理`}</button></div>`;
  if (project.status === "brief" && project.brief) {
    const brief = project.brief;
    return `<div class="brief-form"><div class="section-row"><h2>确认营销简报</h2><span>${brief.missingFacts.length ? `${brief.missingFacts.length} 项待补` : "信息完整"}</span></div>
      <label>宣传主题<textarea data-brief="subject" rows="2">${escapeHtml(brief.subject)}</textarea></label>
      <label>目标读者<input data-brief="audience" value="${escapeHtml(brief.audience)}"></label>
      <label>传播目标<input data-brief="objective" value="${escapeHtml(brief.objective)}"></label>
      <label>核心信息<textarea data-brief="keyMessage" rows="3">${escapeHtml(brief.keyMessage)}</textarea></label>
      <label>事实依据<textarea data-brief-list="proofPoints" rows="3">${escapeHtml(brief.proofPoints.join("\n"))}</textarea></label>
      ${brief.campaignType === "event" ? `<label>活动信息<textarea data-brief="eventDetails" rows="3">${escapeHtml(brief.eventDetails)}</textarea></label>` : ""}
      <label>行动指令<input data-brief="cta" value="${escapeHtml(brief.cta)}"></label>
      ${brief.missingFacts.length ? `<div class="missing-facts">待补充：${escapeHtml(brief.missingFacts.join("、"))}</div>` : ""}
      <button id="confirm-brief" class="button primary full" type="button" ${busy ? "disabled" : ""}>${busy ? `${icon("circle-notch")} 正在生成` : `${icon("check")} 确认并生成方向`}</button></div>`;
  }
  if (project.status === "directions") return `<div class="direction-list"><h2>选择标题与叙事方向</h2>${project.directions.map((direction) => `<button data-direction="${direction.id}" class="direction-option ${direction.id === project.selectedDirectionId ? "selected" : ""}" type="button"><span>${escapeHtml(direction.angle)}</span><strong>${escapeHtml(direction.title)}</strong><ol>${direction.outline.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol></button>`).join("")}<button id="generate-draft" class="button primary full" type="button" ${!project.selectedDirectionId || busy ? "disabled" : ""}>${busy ? `${icon("circle-notch")} 正在写作` : `生成正文 ${icon("arrow-right")}`}</button></div>`;
  if (project.status === "draft") return draftAgentContent(project);
  return "";
}

function draftAgentContent(project) {
  const assets = project.assets.length ? `<div class="asset-strip"><div class="section-row"><h2>图片素材</h2><span>${project.assets.length}/8</span></div>${project.assets.map((asset) => `<div class="asset-row"><img src="${asset.dataUrl}" alt="${escapeHtml(asset.description)}"><div><strong>${escapeHtml(asset.name)}</strong><p>${escapeHtml(asset.description)}</p></div><button data-remove-asset="${asset.id}" type="button" aria-label="移除素材">${icon("x")}</button></div>`).join("")}</div>` : "";
  const rewrite = rewritePreview ? `<div class="rewrite-preview"><div><span>原文</span><p>${escapeHtml(rewritePreview.original)}</p></div><div class="replacement"><span>修改后</span><p>${escapeHtml(rewritePreview.replacement)}</p></div><div class="preview-actions"><button id="cancel-rewrite" class="button secondary" type="button">取消</button><button id="apply-rewrite" class="button primary" type="button">接受修改</button></div></div>` : selectedText ? `<blockquote class="selection-quote">${escapeHtml(selectedText)}</blockquote><div class="rewrite-presets">${["表达更自然", "缩短并精简", "扩写细节", "更有号召力"].map((label, index) => `<button data-rewrite="${label}" type="button" ${busy ? "disabled" : ""}>${icon(["pencil-simple", "list", "article", "magic-wand"][index])}${label}</button>`).join("")}</div><div class="custom-instruction"><input id="rewrite-instruction" placeholder="输入自定义修改要求"><button id="send-rewrite" type="button" aria-label="发送修改要求">${icon("arrow-up")}</button></div>` : `<p class="selection-tip">${icon("pencil-simple")}在正文中选中文字，即可预览 AI 改写。</p>`;
  return `<div class="rewrite-workspace">${assets}<h2>局部 AI 修改</h2>${rewrite}</div>`;
}

function bindAgentEvents(project) {
  $("#asset-upload-button")?.addEventListener("click", () => $("#asset-file").click());
  $("#asset-file")?.addEventListener("change", (event) => addAsset(event.target.files?.[0]));
  $("#start-interview")?.addEventListener("click", startInterview);
  $("#send-answer")?.addEventListener("click", sendAnswer);
  $("#agent-answer")?.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendAnswer(); } });
  $$('[data-brief]').forEach((input) => input.addEventListener("input", () => { project.brief[input.dataset.brief] = input.value; recomputeMissing(project.brief); scheduleSave(); renderCanvas(); }));
  $$('[data-brief-list]').forEach((input) => input.addEventListener("input", () => { project.brief[input.dataset.briefList] = input.value.split(/\n/).map((value) => value.trim()).filter(Boolean); recomputeMissing(project.brief); scheduleSave(); renderCanvas(); }));
  $("#confirm-brief")?.addEventListener("click", confirmBrief);
  $$('[data-direction]').forEach((button) => button.addEventListener("click", () => { project.selectedDirectionId = button.dataset.direction; scheduleSave(); renderAgent(); }));
  $("#generate-draft")?.addEventListener("click", generateDraft);
  $$('[data-rewrite]').forEach((button) => button.addEventListener("click", () => requestRewrite(button.dataset.rewrite)));
  $("#send-rewrite")?.addEventListener("click", () => { const value = $("#rewrite-instruction").value.trim(); if (value) requestRewrite(value); });
  $("#cancel-rewrite")?.addEventListener("click", () => { rewritePreview = undefined; renderAgent(); });
  $("#apply-rewrite")?.addEventListener("click", applyRewrite);
  $$('[data-remove-asset]').forEach((button) => button.addEventListener("click", () => { project.assets = project.assets.filter((asset) => asset.id !== button.dataset.removeAsset); scheduleSave(); renderAgent(); }));
}

function recomputeMissing(brief) {
  brief.missingFacts = [];
  if (!brief.keyMessage || /待补充|待定/.test(brief.keyMessage)) brief.missingFacts.push(brief.campaignType === "event" ? "现场体验内容" : "产品核心卖点");
  if (!brief.proofPoints.length || brief.proofPoints.some((item) => /待补充|待定|暂无/.test(item))) brief.missingFacts.push("可信事实依据");
  if (brief.campaignType === "event" && (!brief.eventDetails || /待补充|待定/.test(brief.eventDetails))) brief.missingFacts.push("活动时间、地点或参与方式");
}

async function startInterview() {
  const project = activeProject(); if (!project) return;
  await runTask(async () => applyInterviewResult(project, await api("interview", { campaignType: project.campaignType, idea: project.idea, answers: project.answers, brand: workspace.brand })));
  renderAll();
}

async function sendAnswer() {
  const project = activeProject(); const input = $("#agent-answer"); const answer = input?.value.trim();
  if (!project?.pendingQuestion || !answer || busy) return;
  const nextAnswers = [...project.answers, { questionId: project.pendingQuestion.id, question: project.pendingQuestion.text, answer }];
  await runTask(async () => { const result = await api("interview", { campaignType: project.campaignType, idea: project.idea, answers: nextAnswers, brand: workspace.brand }); project.answers = nextAnswers; applyInterviewResult(project, result, answer); });
  renderAll();
}

function applyInterviewResult(project, result, answer) {
  if (answer) project.messages.push({ id: uid(), role: "user", text: answer, createdAt: now() });
  if (result.status === "question") {
    project.status = "interview"; project.pendingQuestion = result.question;
    project.messages.push({ id: uid(), role: "agent", text: result.question.text, createdAt: now() });
  } else {
    project.status = "brief"; project.pendingQuestion = undefined; project.brief = result.brief;
    project.messages.push({ id: uid(), role: "agent", text: "信息已经整理成营销简报。请检查并修改所有事实，再确认内容方向。", createdAt: now() });
  }
  project.updatedAt = now(); scheduleSave();
}

async function confirmBrief() {
  const project = activeProject(); if (!project?.brief) return;
  await runTask(async () => { const result = await api("directions", { brief: project.brief, brand: workspace.brand }); project.directions = result.directions; project.selectedDirectionId = result.directions[0]?.id; project.status = "directions"; project.updatedAt = now(); scheduleSave(); });
  renderAll();
}

async function generateDraft() {
  const project = activeProject(); const direction = project?.directions.find((item) => item.id === project.selectedDirectionId);
  if (!project?.brief || !direction) return;
  await runTask(async () => { const result = await api("draft", { brief: project.brief, direction, brand: workspace.brand, assets: project.assets.map(({ name, description }) => ({ name, description })) }); project.articleHtml = result.articleHtml; project.status = "draft"; project.versions.unshift({ id: uid(), html: result.articleHtml, reason: "生成初稿", createdAt: now() }); project.updatedAt = now(); if (saasEnabled) activeSubscription = (await saasRequest("/subscription")).subscription; scheduleSave(); });
  renderAll();
}

async function requestRewrite(instruction) {
  const project = activeProject(); if (!project || !selectedText || busy) return;
  const original = selectedText;
  await runTask(async () => { const result = await api("rewrite", { text: original, instruction, brand: workspace.brand, brief: project.brief }); rewritePreview = { original, replacement: result.replacement, instruction }; });
  renderAgent();
}

function applyRewrite() {
  const project = activeProject(); const editor = $("#article-editor");
  if (!project || !rewritePreview || !selectedRange || !editor?.contains(selectedRange.commonAncestorContainer)) return showToast("选区已失效，请重新选择文字", "error");
  project.versions.unshift({ id: uid(), html: editor.innerHTML, reason: rewritePreview.instruction, createdAt: now() }); project.versions = project.versions.slice(0, 10);
  selectedRange.deleteContents(); const node = document.createTextNode(rewritePreview.replacement); selectedRange.insertNode(node); selectedRange.setStartAfter(node); selectedRange.collapse(true);
  project.articleHtml = editor.innerHTML; project.auditIssues = []; selectedRange = undefined; selectedText = ""; rewritePreview = undefined; scheduleSave(); renderAgent(); hideBubble(); showToast("已应用修改");
}

function addAsset(file) {
  const project = activeProject(); if (!file || !project) return;
  if (!new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]).has(file.type) || file.size > 2 * 1024 * 1024) return showToast("仅支持 2MB 以内的 PNG、JPEG、WebP 或 GIF", "error");
  if (project.assets.length >= 8) return showToast("每个项目最多保存 8 张图片", "error");
  const description = prompt("请描述图片内容，Agent 将根据说明建议插入位置：", file.name) || file.name;
  const reader = new FileReader(); reader.onload = () => { project.assets.push({ id: uid(), name: file.name, mimeType: file.type, dataUrl: String(reader.result), description, createdAt: now() }); scheduleSave(); renderAgent(); }; reader.readAsDataURL(file);
}

function renderCanvas() {
  const panel = $("#canvas-panel"); const project = activeProject();
  panel.innerHTML = `${canvasHeader(project)}${canvasBody(project)}`;
  bindCanvasEvents(project);
}

function canvasHeader(project) {
  return `<header class="canvas-header"><div class="canvas-title">${icon("file-text")}<span>${project ? escapeHtml(project.title) : "未命名文章"}</span>${project ? `<small>${icon("clock")} 已自动保存</small>` : ""}</div>${project?.status === "draft" ? `<div class="canvas-actions"><button id="preview-article" class="button quiet" type="button">${icon("eye")} 预览</button><button id="audit-article" class="button quiet" type="button" ${busy ? "disabled" : ""}>${icon("shield-check")} 审核</button><button id="copy-article" class="button dark" type="button" ${busy || project.auditIssues.some((issue) => issue.severity === "blocking") ? "disabled" : ""}>${icon("copy")} 复制到公众号</button></div>` : ""}</header>`;
}

function renderCanvasHeaderOnly() {
  const panel = $("#canvas-panel"); const old = $(".canvas-header", panel); const project = activeProject();
  if (old) { const holder = document.createElement("div"); holder.innerHTML = canvasHeader(project); old.replaceWith(holder.firstElementChild); bindCanvasHeader(project); }
}

function canvasBody(project) {
  if (!project) return `<div class="welcome-canvas"><div class="welcome-copy"><span class="welcome-icon">${icon("article")}</span><h2>把零散想法，整理成一篇可以继续编辑的文章。</h2><p>从左侧新建项目。Agent 会先确认事实，再和你一起完成标题、提纲与正文。</p><button id="welcome-new-project" class="button dark" type="button">${icon("plus")} 新建文章</button></div></div>`;
  if (project.status === "draft") {
    const blocking = project.auditIssues.some((issue) => issue.severity === "blocking");
    return `<div class="article-stage">${project.auditIssues.length ? `<div class="audit-banner">${blocking ? icon("warning") : icon("check")}<div>${project.auditIssues.map((issue) => `<p>${escapeHtml(issue.message)}${issue.excerpt ? `（${escapeHtml(issue.excerpt)}）` : ""}</p>`).join("")}</div></div>` : ""}<div class="editor-frame"><div class="editor-toolbar" role="toolbar" aria-label="文章格式"><button data-command="formatBlock" data-value="P" class="text-style-control" title="正文" aria-label="正文">正文 ${icon("caret-down")}</button><span class="toolbar-divider"></span><button data-command="undo" title="撤销" aria-label="撤销">${icon("arrow-counter-clockwise")}</button><button data-command="redo" title="重做" aria-label="重做">${icon("arrow-clockwise")}</button><span class="toolbar-divider"></span><button data-command="formatBlock" data-value="H1" title="一级标题" aria-label="一级标题">${icon("text-h-one")}</button><button data-command="formatBlock" data-value="H2" title="二级标题" aria-label="二级标题">${icon("text-h-two")}</button><button data-command="bold" title="加粗" aria-label="加粗">${icon("text-bolder")}</button><button data-command="italic" title="斜体" aria-label="斜体">${icon("text-italic")}</button><button id="create-link" title="链接" aria-label="链接">${icon("link")}</button><button data-command="insertUnorderedList" title="无序列表" aria-label="无序列表">${icon("list-bullets")}</button><button data-command="insertOrderedList" title="有序列表" aria-label="有序列表">${icon("list-numbers")}</button><button data-command="formatBlock" data-value="BLOCKQUOTE" title="引用" aria-label="引用">${icon("quotes")}</button></div><div id="article-editor" class="article-prose" contenteditable="true" role="textbox" aria-label="公众号文章正文" aria-multiline="true" data-placeholder="正文会在这里生成，你也可以直接开始写作……">${sanitizeArticleClient(project.articleHtml)}</div><button id="selection-bubble" class="bubble-ai" type="button" hidden>${icon("sparkle")} AI 修改</button></div><footer class="article-status"><span>字数 ${articleTextLength(project.articleHtml)}</span><span>已保存 ${icon("check")}</span></footer></div>`;
  }
  if (project.status === "brief" && project.brief) return `<div class="process-sheet" style="--brand-primary:${workspace.brand.primaryColor}"><div class="sheet-kicker">营销简报</div><h2>${escapeHtml(project.brief.subject)}</h2><dl><div><dt>目标读者</dt><dd>${escapeHtml(project.brief.audience)}</dd></div><div><dt>传播目标</dt><dd>${escapeHtml(project.brief.objective)}</dd></div><div><dt>核心信息</dt><dd>${escapeHtml(project.brief.keyMessage)}</dd></div><div><dt>行动指令</dt><dd>${escapeHtml(project.brief.cta)}</dd></div></dl></div>`;
  if (project.status === "directions") return `<div class="process-sheet directions-sheet" style="--brand-primary:${workspace.brand.primaryColor}"><div class="sheet-kicker">三个传播方向</div><h2>先选准叙事角度，再生成整篇正文。</h2>${project.directions.map((direction, index) => `<section><span>0${index + 1}</span><div><h3>${escapeHtml(direction.title)}</h3><p>${escapeHtml(direction.angle)} · ${escapeHtml(direction.outline.join(" / "))}</p></div></section>`).join("")}</div>`;
  return `<div class="process-placeholder"><div class="process-empty"><span>${icon("file-text")}</span><h2>文章将在这里逐步成形</h2><p>回答右侧 Agent 的问题后，营销简报、内容方向和正文会依次出现在写作画布中。</p></div></div>`;
}

function articleTextLength(articleHtml) {
  return new DOMParser().parseFromString(String(articleHtml || ""), "text/html").body.innerText.replace(/\s/g, "").length;
}

function bindCanvasEvents(project) {
  bindCanvasHeader(project);
  $("#welcome-new-project")?.addEventListener("click", showNewProject);
  const editor = $("#article-editor"); if (!editor) return;
  editor.addEventListener("input", () => { project.articleHtml = editor.innerHTML; project.auditIssues = []; project.updatedAt = now(); $(".audit-banner")?.remove(); scheduleSave(); renderCanvasHeaderOnly(); });
  ["mouseup", "keyup"].forEach((eventName) => editor.addEventListener(eventName, captureSelection));
  editor.addEventListener("paste", (event) => { event.preventDefault(); document.execCommand("insertText", false, event.clipboardData.getData("text/plain")); });
  $$('[data-command]').forEach((button) => button.addEventListener("mousedown", (event) => { event.preventDefault(); editor.focus(); document.execCommand(button.dataset.command, false, button.dataset.value || null); project.articleHtml = editor.innerHTML; scheduleSave(); }));
  $("#create-link")?.addEventListener("mousedown", (event) => { event.preventDefault(); const href = prompt("输入链接地址", "https://"); if (href && /^https?:\/\//i.test(href)) { editor.focus(); document.execCommand("createLink", false, href); project.articleHtml = editor.innerHTML; scheduleSave(); } });
  $("#selection-bubble")?.addEventListener("mousedown", (event) => event.preventDefault());
  $("#selection-bubble")?.addEventListener("click", () => requestRewrite("表达更自然"));
}

function bindCanvasHeader(project) {
  if (!project) return;
  $("#audit-article")?.addEventListener("click", () => auditArticle(false));
  $("#copy-article")?.addEventListener("click", () => auditArticle(true));
  $("#preview-article")?.addEventListener("click", showPreview);
}

function captureSelection() {
  const selection = window.getSelection(); const editor = $("#article-editor"); const bubble = $("#selection-bubble");
  if (!selection || !editor || selection.rangeCount === 0 || selection.isCollapsed) { selectedRange = undefined; selectedText = ""; hideBubble(); renderAgent(); return; }
  const range = selection.getRangeAt(0); if (!editor.contains(range.commonAncestorContainer)) return;
  const text = range.toString().trim(); if (!text) return;
  selectedRange = range.cloneRange(); selectedText = text; rewritePreview = undefined;
  const rect = range.getBoundingClientRect(); const frame = editor.parentElement.getBoundingClientRect();
  bubble.hidden = false; bubble.style.left = `${Math.max(12, Math.min(rect.left - frame.left, frame.width - 90))}px`; bubble.style.top = `${Math.max(44, rect.top - frame.top - 38)}px`;
  renderAgent();
}

function hideBubble() { const bubble = $("#selection-bubble"); if (bubble) bubble.hidden = true; }

async function auditArticle(copyAfter) {
  const project = activeProject(); const editor = $("#article-editor"); if (!project?.brief || !editor) return;
  await runTask(async () => {
    const result = await api("audit", { articleText: editor.innerText, brief: project.brief, brand: workspace.brand });
    project.auditIssues = result.issues; scheduleSave();
    const blocking = result.issues.some((issue) => issue.severity === "blocking");
    if (copyAfter && !blocking) { await copyArticle(editor.innerHTML); showToast("已复制富文本，可粘贴到公众号后台"); }
    else if (blocking) showToast("发布检查发现未确认事实，请先处理阻断项", "error");
    else showToast(result.issues.length ? "检查完成，请留意警告" : "发布检查通过");
  });
  renderCanvas();
}

function buildWechatHtml(articleHtml) {
  const styles = {
    H1: "margin:0 0 28px;font-size:28px;line-height:1.42;font-weight:700;color:#17202a;letter-spacing:-0.02em;",
    H2: `margin:36px 0 16px;padding-left:12px;border-left:4px solid ${workspace.brand.primaryColor};font-size:21px;line-height:1.5;font-weight:700;color:#17202a;`,
    P: "margin:0 0 18px;font-size:16px;line-height:1.9;color:#303841;text-align:justify;", BLOCKQUOTE: `margin:24px 0;padding:16px 18px;background:#f5f8fa;border-left:3px solid ${workspace.brand.accentColor};font-size:15px;line-height:1.8;color:#52606d;`,
    UL: "margin:16px 0 20px;padding-left:24px;color:#303841;", OL: "margin:16px 0 20px;padding-left:24px;color:#303841;", LI: "margin:8px 0;font-size:16px;line-height:1.8;", A: `color:${workspace.brand.accentColor};text-decoration:underline;`, STRONG: "font-weight:700;color:#17202a;",
  };
  const documentCopy = new DOMParser().parseFromString(`<section>${articleHtml}</section>`, "text/html"); const root = documentCopy.body.firstElementChild;
  root.setAttribute("style", "max-width:680px;margin:0 auto;padding:24px 18px;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;");
  root.querySelectorAll("*").forEach((element) => { if (styles[element.tagName]) element.setAttribute("style", styles[element.tagName]); element.removeAttribute("class"); element.removeAttribute("id"); });
  return root.outerHTML;
}

async function copyArticle(articleHtml) {
  const html = buildWechatHtml(articleHtml); const parsed = new DOMParser().parseFromString(articleHtml, "text/html"); const plain = parsed.body.innerText;
  if (window.ClipboardItem && navigator.clipboard?.write) return navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([plain], { type: "text/plain" }) })]);
  return navigator.clipboard.writeText(plain);
}

function showPreview() {
  const project = activeProject(); if (!project) return;
  openModal("公众号样式预览", `<div class="wechat-preview">${buildWechatHtml(project.articleHtml)}</div>`, undefined, true);
}

function downloadBackup(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob); link.download = filename; link.click(); URL.revokeObjectURL(link.href);
}

async function exportBackup() {
  try {
    const date = new Date().toISOString().slice(0, 10);
    if (confirm("备份中可能包含未发布文章和图片。是否使用密码加密？")) {
      const passphrase = String(prompt("设置备份密码（至少 10 个字符；丢失后无法恢复）") || "");
      if (!passphrase) return;
      downloadBackup(await encryptBackup(workspace, passphrase), `wechat-agent-backup-${date}.encrypted.json`);
      return showToast("加密备份已导出");
    }
    if (!confirm("明文备份可被任何取得文件的人读取。仍要导出吗？")) return;
    downloadBackup(workspace, `wechat-agent-backup-${date}.json`);
    showToast("明文备份已导出");
  } catch (error) { showToast(error instanceof Error ? error.message : "导出失败", "error"); }
}

async function importBackup(file) {
  try {
    if (file.size > 25 * 1024 * 1024) throw new Error("备份文件不能超过 25MB");
    let parsed = JSON.parse(await file.text());
    if (isEncryptedBackup(parsed)) {
      const passphrase = String(prompt("请输入备份密码") || "");
      if (!passphrase) return;
      parsed = await decryptBackup(parsed, passphrase);
    }
    workspace = sanitizeWorkspaceContent(normalizeWorkspaceBackup(parsed));
    await persistWorkspace(); renderAll(); showToast("备份已验证并恢复");
  }
  catch (error) { showToast(error instanceof Error ? error.message : "导入失败", "error"); }
}

async function requestSaasAuthentication() {
  return new Promise((resolve) => {
    const root = $("#modal-root");
    let mode = "login";
    const render = () => {
      const registering = mode === "register";
      root.innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-label="登录企业工作区"><header class="modal-header"><h2>企业工作区</h2></header><form id="saas-auth-form" class="modal-form"><div class="auth-switch"><button type="button" data-auth-mode="login" class="${registering ? "" : "selected"}">登录</button><button type="button" data-auth-mode="register" class="${registering ? "selected" : ""}">创建企业</button></div><p>${registering ? "创建企业工作区，开始14天试用。数据会安全同步到云端。" : "登录后继续访问企业项目、成员与使用额度。"}</p>${registering ? '<label>姓名<input name="name" autocomplete="name" maxlength="60" required></label><label>企业名称<input name="organizationName" autocomplete="organization" maxlength="80" required></label>' : ""}<label>邮箱<input name="email" type="email" autocomplete="email" maxlength="254" required></label><label>密码<input name="password" type="password" autocomplete="${registering ? "new-password" : "current-password"}" minlength="10" maxlength="128" required></label>${registering ? '<label>平台初始化码（普通用户留空）<input name="bootstrapToken" type="password" autocomplete="off" maxlength="128"></label>' : ""}<button class="button primary full" type="submit">${registering ? "创建并进入" : "登录"}</button><p id="auth-error" class="inline-warning" hidden></p></form></section></div>`;
      $$('[data-auth-mode]', root).forEach((button) => button.addEventListener("click", () => { mode = button.dataset.authMode; render(); }));
      $("#saas-auth-form", root).addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = $('button[type="submit"]', event.currentTarget);
        const errorBox = $("#auth-error", root);
        button.disabled = true; errorBox.hidden = true;
        try {
          const data = Object.fromEntries(new FormData(event.currentTarget));
          const result = await saasRequest(registering ? "/register" : "/login", { method: "POST", body: data, organization: false });
          acceptSaasSession(result);
          root.innerHTML = "";
          resolve(result);
        } catch (error) {
          errorBox.textContent = error instanceof Error ? error.message : "登录失败";
          errorBox.hidden = false;
          button.disabled = false;
        }
      });
      $('input[name="email"]', root)?.focus();
    };
    render();
  });
}

async function ensureSaasSession() {
  if (saasSessionToken) {
    try {
      const current = await saasRequest("/me", { organization: false });
      saasUser = current.user;
      saasOrganizations = current.organizations || [];
      if (!saasOrganizations.some((item) => item.organization.id === activeOrganizationId)) activeOrganizationId = saasOrganizations[0]?.organization.id || "";
      if (activeOrganizationId) sessionStorage.setItem("wechat-saas-organization", activeOrganizationId);
      return;
    } catch { clearSaasSession(); }
  }
  await requestSaasAuthentication();
}

function renderSaasChrome() {
  const organization = saasOrganizations.find((item) => item.organization.id === activeOrganizationId)?.organization;
  $("#organization-settings").hidden = !saasEnabled;
  $("#billing-settings").hidden = !saasEnabled;
  $("#admin-console").hidden = !saasEnabled || !saasUser?.platformAdmin;
  $("#account-status").textContent = saasEnabled ? `${organization?.name || "企业工作区"} · ${saasUser?.name || "未登录"}` : "本地工作区";
  $("#storage-status").innerHTML = `${icon("hard-drive")}${saasEnabled ? "企业云端实时同步" : "数据仅保存在此浏览器"}`;
  $("#clear-local-data").innerHTML = `${icon("trash")}${saasEnabled ? "清空企业云端" : "清除本地数据"}`;
  $("#new-project").disabled = saasEnabled && activeOrganizationRole === "reviewer";
  $("#brand-settings").disabled = saasEnabled && activeOrganizationRole === "reviewer";
}

async function showAccountMenu() {
  if (!saasEnabled) return openModal("当前工作区", '<div class="account-summary"><p>当前为个人本地模式，项目仅保存在这个浏览器中。</p></div>');
  const organizationRows = saasOrganizations.map((item) => `<div class="data-row"><div class="data-row-copy"><strong>${escapeHtml(item.organization.name)}</strong><small>${escapeHtml(item.role)}${item.organization.id === activeOrganizationId ? " · 当前" : ""}</small></div>${item.organization.id === activeOrganizationId ? "" : `<button class="button secondary" data-switch-organization="${item.organization.id}" type="button">切换</button>`}</div>`).join("");
  openModal("账户与工作区", `<div class="account-summary"><dl><div><dt>姓名</dt><dd>${escapeHtml(saasUser?.name)}</dd></div><div><dt>邮箱</dt><dd>${escapeHtml(saasUser?.email)}</dd></div></dl><div class="data-list">${organizationRows}</div><form id="change-password-form" class="modal-form"><h3>修改密码</h3><label>当前密码<input name="currentPassword" type="password" autocomplete="current-password" minlength="10" maxlength="128" required></label><label>新密码<input name="newPassword" type="password" autocomplete="new-password" minlength="10" maxlength="128" required></label><label>确认新密码<input name="confirmPassword" type="password" autocomplete="new-password" minlength="10" maxlength="128" required></label><button class="button primary full" type="submit">更新密码</button><p id="change-password-error" class="inline-warning" hidden></p></form><button id="saas-logout" class="button secondary full" type="button">退出登录</button></div>`, (root) => {
    $$('[data-switch-organization]', root).forEach((button) => button.addEventListener("click", async () => {
      await saveChain;
      activeOrganizationId = button.dataset.switchOrganization;
      sessionStorage.setItem("wechat-saas-organization", activeOrganizationId);
      await loadCloudWorkspace(); closeModal(); renderAll(); showToast("已切换企业工作区");
    }));
    $("#change-password-form", root).addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = Object.fromEntries(new FormData(form));
      const errorBox = $("#change-password-error", root);
      errorBox.hidden = true;
      if (data.newPassword !== data.confirmPassword) { errorBox.textContent = "两次输入的新密码不一致"; errorBox.hidden = false; return; }
      const button = $('button[type="submit"]', form);
      button.disabled = true;
      try {
        const result = await saasRequest("/change-password", { method: "POST", body: { currentPassword: data.currentPassword, newPassword: data.newPassword }, organization: false });
        saasSessionToken = result.token;
        sessionStorage.setItem("wechat-saas-session", saasSessionToken);
        form.reset();
        showToast("密码已更新，其他登录会话已退出");
      } catch (error) {
        errorBox.textContent = error instanceof Error ? error.message : "密码更新失败";
        errorBox.hidden = false;
      } finally { button.disabled = false; }
    });
    $("#saas-logout", root).addEventListener("click", async () => {
      try { await saasRequest("/logout", { method: "POST", body: {}, organization: false }); } catch { /* local cleanup still applies */ }
      clearSaasSession(); location.reload();
    });
  });
}

async function showOrganizationSettings() {
  try {
    const [{ members }, organizationInfo] = await Promise.all([saasRequest("/members"), saasRequest("/organization")]);
    const canManage = ["owner", "admin"].includes(organizationInfo.role);
    const rows = members.map((member) => `<div class="data-row"><div class="data-row-copy"><strong>${escapeHtml(member.name)}</strong><small>${escapeHtml(member.email)} · ${escapeHtml(member.role)}</small></div>${canManage && member.role !== "owner" && member.id !== saasUser.id ? `<div class="data-row-actions"><select data-member-role="${member.id}">${["admin", "editor", "reviewer"].map((role) => `<option value="${role}" ${member.role === role ? "selected" : ""}>${role}</option>`).join("")}</select><button class="button secondary" data-remove-member="${member.id}" type="button">移除</button></div>` : ""}</div>`).join("");
    openModal("企业与成员", `<section class="saas-section"><div class="saas-section-header"><div><h3>${escapeHtml(organizationInfo.organization.name)}</h3><p>当前角色：${escapeHtml(organizationInfo.role)} · ${members.length}/${organizationInfo.subscription.seatLimit} 名成员</p></div></div>${canManage ? `<form id="organization-name-form" class="inline-form"><input name="name" value="${escapeHtml(organizationInfo.organization.name)}" maxlength="80" required><span></span><button class="button secondary" type="submit">更新名称</button></form>` : ""}</section><section class="saas-section"><div class="saas-section-header"><div><h3>成员权限</h3><p>审核人只读；编辑可创作；管理员可管理成员与账单。</p></div></div>${canManage ? '<form id="add-member-form" class="inline-form"><input name="email" type="email" placeholder="已注册成员邮箱" required><select name="role"><option value="editor">编辑</option><option value="reviewer">审核人</option><option value="admin">管理员</option></select><button class="button primary" type="submit">添加</button></form>' : ""}<div class="data-list">${rows}</div></section>`, (root) => {
      $("#organization-name-form", root)?.addEventListener("submit", async (event) => { event.preventDefault(); await saasRequest("/organization", { method: "PATCH", body: { name: new FormData(event.currentTarget).get("name") } }); closeModal(); await showOrganizationSettings(); renderSaasChrome(); });
      $("#add-member-form", root)?.addEventListener("submit", async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget)); try { await saasRequest("/members", { method: "POST", body: data }); closeModal(); await showOrganizationSettings(); } catch (error) { showToast(error.message, "error"); } });
      $$('[data-member-role]', root).forEach((select) => select.addEventListener("change", async () => { try { await saasRequest(`/members/${select.dataset.memberRole}`, { method: "PATCH", body: { role: select.value } }); showToast("成员角色已更新"); } catch (error) { showToast(error.message, "error"); } }));
      $$('[data-remove-member]', root).forEach((button) => button.addEventListener("click", async () => { if (!confirm("确认移除该成员？")) return; try { await saasRequest(`/members/${button.dataset.removeMember}`, { method: "DELETE" }); closeModal(); await showOrganizationSettings(); } catch (error) { showToast(error.message, "error"); } }));
    }, true);
  } catch (error) { showToast(error.message, "error"); }
}

async function showBillingSettings() {
  try {
    const [{ subscription, plans }, { orders }] = await Promise.all([saasRequest("/subscription"), saasRequest("/orders")]);
    activeSubscription = subscription; renderAgent();
    const usedPercent = subscription.draftQuota ? Math.min(100, Math.round(subscription.draftsUsed / subscription.draftQuota * 100)) : 0;
    const planRows = plans.filter((plan) => plan.id !== "trial").map((plan) => `<div class="plan-row ${plan.id === subscription.planId ? "current" : ""}"><div><h4>${escapeHtml(plan.name)} · ¥${(plan.priceCents / 100).toFixed(0)}/月</h4><p>${plan.draftQuota}篇成稿 · ${plan.seatLimit}名成员</p></div>${plan.id === subscription.planId ? "<small>当前套餐</small>" : `<button class="button primary" data-order-plan="${plan.id}" type="button">创建订单</button>`}</div>`).join("");
    const orderRows = orders.map((order) => `<div class="data-row"><div class="data-row-copy"><strong>${escapeHtml(order.planId)} · ¥${(order.amountCents / 100).toFixed(0)}</strong><small>${escapeHtml(order.status)} · ${new Date(order.createdAt).toLocaleDateString()}</small></div>${order.status === "paid" ? `<button class="button secondary" data-refund-order="${order.id}" type="button">申请退款</button>` : ""}</div>`).join("") || '<p class="form-intro">暂无订单</p>';
    openModal("套餐与额度", `<section class="saas-section"><div class="saas-section-header"><div><h3>${escapeHtml(subscription.planId)} · ${subscription.draftsRemaining}篇可用</h3><p>本期已使用 ${subscription.draftsUsed}/${subscription.draftQuota} 篇，截止 ${new Date(subscription.periodEnd).toLocaleDateString()}。</p></div></div><div class="usage-bar"><span style="width:${usedPercent}%"></span></div></section><section class="saas-section"><div class="plan-list">${planRows}</div></section><section class="saas-section"><div class="saas-section-header"><h3>订单与退款</h3></div><div class="data-list">${orderRows}</div></section>`, (root) => {
      $$('[data-order-plan]', root).forEach((button) => button.addEventListener("click", async () => { try { const order = await saasRequest("/orders", { method: "POST", body: { planId: button.dataset.orderPlan, idempotencyKey: uid() } }); showToast(`订单已创建：¥${(order.amountCents / 100).toFixed(0)}，等待支付确认`); closeModal(); await showBillingSettings(); } catch (error) { showToast(error.message, "error"); } }));
      $$('[data-refund-order]', root).forEach((button) => button.addEventListener("click", async () => { const reason = prompt("请输入退款原因"); if (!reason) return; try { await saasRequest(`/orders/${button.dataset.refundOrder}/refund`, { method: "POST", body: { reason } }); showToast("退款申请已提交"); closeModal(); await showBillingSettings(); } catch (error) { showToast(error.message, "error"); } }));
    }, true);
  } catch (error) { showToast(error.message, "error"); }
}

async function showAdminConsole() {
  try {
    const metrics = await saasRequest("/admin/metrics", { organization: false });
    const totals = metrics.totals;
    const orderRows = metrics.pendingOrders.map((order) => `<div class="data-row"><div class="data-row-copy"><strong>${escapeHtml(order.plan_id)} · ¥${(order.amount_cents / 100).toFixed(0)}</strong><small>${escapeHtml(order.organization_id)}</small></div><button class="button primary" data-mark-paid="${order.id}" type="button">确认支付</button></div>`).join("") || '<p class="form-intro">没有待支付订单</p>';
    const refundRows = metrics.pendingRefunds.map((refund) => `<div class="data-row"><div class="data-row-copy"><strong>¥${(refund.amount_cents / 100).toFixed(0)} · ${escapeHtml(refund.reason)}</strong><small>${escapeHtml(refund.organization_id)}</small></div><div class="data-row-actions"><button class="button secondary" data-refund-reject="${refund.id}" type="button">拒绝</button><button class="button primary" data-refund-approve="${refund.id}" type="button">批准</button></div></div>`).join("") || '<p class="form-intro">没有待处理退款</p>';
    openModal("平台管理", `<section class="saas-section"><div class="saas-grid"><div class="metric"><span>企业</span><strong>${totals.organizations}</strong></div><div class="metric"><span>收入</span><strong>¥${(totals.revenue_cents / 100).toFixed(0)}</strong></div><div class="metric"><span>模型成本</span><strong>$${(totals.cost_microusd / 1_000_000).toFixed(4)}</strong></div></div></section><section class="saas-section"><div class="saas-section-header"><h3>待支付订单</h3></div><div class="data-list">${orderRows}</div></section><section class="saas-section"><div class="saas-section-header"><h3>待处理退款</h3></div><div class="data-list">${refundRows}</div></section>`, (root) => {
      $$('[data-mark-paid]', root).forEach((button) => button.addEventListener("click", async () => { await saasRequest(`/admin/orders/${button.dataset.markPaid}/paid`, { method: "POST", body: {}, organization: false }); closeModal(); await showAdminConsole(); }));
      const processRefund = async (id, approved) => { await saasRequest(`/admin/refunds/${id}/process`, { method: "POST", body: { approved }, organization: false }); closeModal(); await showAdminConsole(); };
      $$('[data-refund-approve]', root).forEach((button) => button.addEventListener("click", () => processRefund(button.dataset.refundApprove, true)));
      $$('[data-refund-reject]', root).forEach((button) => button.addEventListener("click", () => processRefund(button.dataset.refundReject, false)));
    }, true);
  } catch (error) { showToast(error.message, "error"); }
}

async function clearLocalData() {
  if (!confirm(saasEnabled ? "将清空当前企业的全部云端项目、图片和品牌档案。此操作无法撤销。" : "将删除此浏览器中的全部项目、图片、品牌档案和临时访问码。此操作无法撤销。")) return;
  workspace = createEmptyWorkspace(); deepSeekApiKey = ""; remoteAccessToken = ""; sessionStorage.removeItem("agent-access-token");
  if (saasEnabled) { await persistWorkspace(); renderAll(); return showToast("企业云端工作区已清空"); }
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const request = db.transaction("workspace", "readwrite").objectStore("workspace").delete("current");
    request.onsuccess = resolve; request.onerror = () => reject(request.error);
  });
  renderAll(); showToast("本地数据已清除");
}

function openSidebar() { $("#sidebar-wrap").classList.add("open"); $("#sidebar-scrim").style.display = "block"; }
function closeSidebar() { $("#sidebar-wrap").classList.remove("open"); $("#sidebar-scrim").style.display = ""; }
function renderAll() { renderSidebar(); renderAgent(); renderCanvas(); renderSaasChrome(); }

async function init() {
  sessionStorage.removeItem("agent-access-token");
  if (embeddedMode) {
    $("#loading").innerHTML = "<strong>为防止点击劫持，请在浏览器地址栏中直接打开本站。</strong>";
    return;
  }
  let localWorkspace;
  try { localWorkspace = await loadLocalWorkspace(); }
  catch { localWorkspace = structuredClone(EMPTY_WORKSPACE); showToast("无法读取旧数据，已打开空白工作区", "error"); }
  if (saasEnabled) {
    await ensureSaasSession();
    await loadCloudWorkspace();
    const localHasContent = localWorkspace.projects.length || localWorkspace.brand.companyName;
    const cloudHasContent = workspace.projects.length || workspace.brand.companyName;
    if (localHasContent && !cloudHasContent && confirm("检测到这个浏览器中已有本地项目，是否迁移到企业云端？")) {
      workspace = localWorkspace;
      await persistWorkspace();
    }
  } else workspace = localWorkspace;
  $("#loading").hidden = true; $("#app").hidden = false; renderAll();
  $("#account-menu").addEventListener("click", showAccountMenu);
  $("#new-project").addEventListener("click", showNewProject);
  $("#brand-settings").addEventListener("click", showBrandSettings);
  $("#organization-settings").addEventListener("click", showOrganizationSettings);
  $("#billing-settings").addEventListener("click", showBillingSettings);
  $("#admin-console").addEventListener("click", showAdminConsole);
  $("#export-backup").addEventListener("click", exportBackup);
  $("#import-backup").addEventListener("change", (event) => event.target.files?.[0] && importBackup(event.target.files[0]));
  $("#clear-local-data").addEventListener("click", () => clearLocalData().catch(() => showToast("清除本地数据失败", "error")));
  $("#mobile-menu").addEventListener("click", () => $("#sidebar-wrap").classList.contains("open") ? closeSidebar() : openSidebar());
  $("#sidebar-scrim").addEventListener("click", closeSidebar);
  $$('[data-mobile-view]').forEach((button) => button.addEventListener("click", () => {
    $("#app").classList.toggle("mobile-canvas", button.dataset.mobileView === "canvas");
    $$('[data-mobile-view]').forEach((item) => item.classList.toggle("selected", item === button));
  }));
}

init().catch((error) => {
  $("#loading").innerHTML = `<strong>企业工作区无法打开</strong><p>${escapeHtml(error instanceof Error ? error.message : "服务暂时不可用")}</p><button id="retry-init" class="button primary" type="button">重试</button>`;
  $("#retry-init")?.addEventListener("click", () => location.reload());
});
