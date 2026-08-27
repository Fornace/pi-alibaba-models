// DashScope built-in tools, called from a Pi function-tool (sidecar).
// The main chat stays on whatever format /alibaba selected; this module
// POSTs its own Cloud Completions or Responses request and never mixes
// web_search_call events into pi's agent stream.

export type SidecarAction = "research" | "search" | "code" | "image";
export type SidecarStrategy = "turbo" | "max" | "agent" | "agent_max";
export type SidecarTransport = "responses" | "completions";

export const SIDECAR_RESULT_CHAR_LIMIT = 48_000;

export const ALIBABA_TOOLS_PARAMETERS = {
  type: "object" as const,
  properties: {
    action: {
      type: "string" as const,
      enum: ["research", "search", "code", "image"],
      description:
        "research: live web + page extract + code sandbox (recommended). " +
        "search: web search only. code: DashScope code interpreter. " +
        "image: search images by text (web_search_image).",
    },
    task: {
      type: "string" as const,
      description: "Natural-language task, search query, code question, or image-search prompt.",
    },
    strategy: {
      type: "string" as const,
      enum: ["turbo", "max", "agent", "agent_max"],
      description:
        "Optional Completions search_strategy (turbo/max/agent/agent_max). Ignored on the Responses path.",
    },
  },
  required: ["action", "task"],
};

export function isQwenChatId(id: string): boolean {
  if (!/^qwen/i.test(id)) return false;
  return !/(omni|realtime|tts|asr|embed|rerank|wan|vl|coder|character|ocr)/i.test(id);
}

/** Models that may take Responses built-in tools (Qwen line only). */
export function responsesToolsAllowed(id: string): boolean {
  if (!isQwenChatId(id)) return false;
  return /qwen3(\.|-max)|qwen-plus|qwen-flash/i.test(id);
}

/**
 * Completions `enable_search`. 3.6+/3.7-max (and similar) are documented as
 * Responses-only for search.
 */
export function completionsSearchAllowed(id: string): boolean {
  if (!isQwenChatId(id)) return false;
  if (/qwen3\.7-max/i.test(id)) return false;
  if (/^qwen3\.[6-9]/i.test(id) && !/qwen3\.7-plus/i.test(id)) return false;
  return /qwen-plus|qwen-flash|qwen3\.5|qwen3\.7-plus|qwen3-max/i.test(id);
}

export function pickSidecarTransport(id: string, action: SidecarAction): SidecarTransport | null {
  if (action === "search") {
    if (responsesToolsAllowed(id)) return "responses";
    if (completionsSearchAllowed(id)) return "completions";
    return null;
  }
  return responsesToolsAllowed(id) ? "responses" : null;
}

const RESPONSES_PREF = [
  "qwen3.8-max",
  "qwen3.7-plus",
  "qwen3.7-max",
  "qwen3.8-flash",
  "qwen3.7-flash",
  "qwen3.6-plus",
  "qwen3.5-plus",
  "qwen-plus",
  "qwen-flash",
  "qwen3-max",
];

const COMPLETIONS_PREF = ["qwen-plus", "qwen3.7-plus", "qwen-flash", "qwen3.5-plus"];

function firstInCatalog(pref: string[], catalog: Set<string>, allowed: (id: string) => boolean): string | undefined {
  for (const id of pref) {
    if (catalog.has(id) && allowed(id)) return id;
  }
  for (const id of catalog) {
    if (allowed(id)) return id;
  }
  return undefined;
}

export function pickSidecarModel(opts: {
  preferred?: string;
  catalogIds: string[];
  action: SidecarAction;
}): { id: string; transport: SidecarTransport } | { error: string } {
  const catalog = new Set(opts.catalogIds);
  if (opts.preferred) {
    const transport = pickSidecarTransport(opts.preferred, opts.action);
    if (!transport) {
      return {
        error:
          `Sidecar model "${opts.preferred}" cannot run action "${opts.action}". ` +
          "Use a Qwen id (not DeepSeek/Kimi/GLM/MiniMax). 3.7 Max / 3.6 Plus+ search is Responses-only.",
      };
    }
    return { id: opts.preferred, transport };
  }

  if (opts.action === "search") {
    const responsesId = firstInCatalog(RESPONSES_PREF, catalog, responsesToolsAllowed);
    if (responsesId) return { id: responsesId, transport: "responses" };
    const completionsId = firstInCatalog(COMPLETIONS_PREF, catalog, completionsSearchAllowed);
    if (completionsId) return { id: completionsId, transport: "completions" };
    return {
      id: "qwen-plus",
      transport: completionsSearchAllowed("qwen-plus") ? "completions" : "responses",
    };
  }

  const id = firstInCatalog(RESPONSES_PREF, catalog, responsesToolsAllowed) ?? "qwen3.7-plus";
  const transport = pickSidecarTransport(id, opts.action);
  if (!transport) {
    return { error: `No Qwen model in the Cloud catalog can run action "${opts.action}" via DashScope built-in tools.` };
  }
  return { id, transport };
}

export function sidecarToolsFor(action: SidecarAction): Array<{ type: string }> {
  switch (action) {
    case "research":
      return [{ type: "web_search" }, { type: "web_extractor" }, { type: "code_interpreter" }];
    case "search":
      return [{ type: "web_search" }];
    case "code":
      return [{ type: "code_interpreter" }];
    case "image":
      return [{ type: "web_search_image" }];
  }
}

export interface SidecarSource {
  url?: string;
  title?: string;
  snippet?: string;
}

export interface SidecarParsed {
  text: string;
  sources: SidecarSource[];
  calls: string[];
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function pushSources(into: SidecarSource[], raw: unknown) {
  if (!Array.isArray(raw)) return;
  for (const item of raw) {
    const r = asRecord(item);
    if (!r) continue;
    const url = typeof r.url === "string" ? r.url : typeof r.link === "string" ? r.link : undefined;
    const title = typeof r.title === "string" ? r.title : undefined;
    const snippet = typeof r.snippet === "string" ? r.snippet : typeof r.summary === "string" ? r.summary : undefined;
    if (url || title) into.push({ url, title, snippet });
  }
}

function messageText(item: Record<string, unknown>): string {
  const content = item.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    const b = asRecord(block);
    if (typeof b?.text === "string") parts.push(b.text);
  }
  return parts.join("");
}

export function parseSidecarResponse(body: unknown): SidecarParsed {
  const root = asRecord(body) ?? {};
  let text = typeof root.output_text === "string" ? root.output_text : "";
  const sources: SidecarSource[] = [];
  const calls: string[] = [];

  const output = Array.isArray(root.output) ? root.output : [];
  for (const raw of output) {
    const item = asRecord(raw);
    if (!item) continue;
    const type = typeof item.type === "string" ? item.type : "";
    const action = asRecord(item.action);
    if (type === "web_search_call") {
      const q = typeof action?.query === "string" ? action.query : undefined;
      calls.push(q ? `web_search: ${q}` : "web_search");
      pushSources(sources, action?.sources ?? item.sources);
    } else if (type === "web_extractor_call") {
      const url = typeof action?.url === "string" ? action.url : undefined;
      calls.push(url ? `web_extractor: ${url}` : "web_extractor");
    } else if (type === "code_interpreter_call") {
      calls.push("code_interpreter");
    } else if (type === "web_search_image_call" || type === "image_search_call") {
      calls.push(type.replace(/_call$/, ""));
    } else if (type === "message" && !text) {
      text = messageText(item);
    }
  }

  if (!text) {
    const choices = Array.isArray(root.choices) ? root.choices : [];
    const msg = asRecord(asRecord(choices[0])?.message);
    const content = msg?.content;
    if (typeof content === "string") text = content;
  }

  return { text: text.trim(), sources, calls };
}

export function dashScopeErrorMessage(status: number, body: unknown): string {
  const root = asRecord(body);
  const err = asRecord(root?.error);
  const msg =
    (typeof err?.message === "string" && err.message) ||
    (typeof root?.message === "string" && root.message) ||
    (typeof root?.raw === "string" && root.raw.slice(0, 500)) ||
    JSON.stringify(body).slice(0, 500);
  return `DashScope sidecar HTTP ${status}: ${msg}`;
}

export function formatSidecarResult(parsed: SidecarParsed): string {
  const parts: string[] = [];
  if (parsed.calls.length) parts.push(`Calls:\n${parsed.calls.map((c) => `- ${c}`).join("\n")}`);
  parts.push(parsed.text || "(empty sidecar response)");
  if (parsed.sources.length) {
    const lines = parsed.sources.slice(0, 12).map((s) => {
      const title = s.title || s.url || "source";
      return s.url ? `- ${title} — ${s.url}` : `- ${title}`;
    });
    parts.push(`Sources:\n${lines.join("\n")}`);
  }
  let out = parts.join("\n\n");
  if (out.length > SIDECAR_RESULT_CHAR_LIMIT) {
    out = `${out.slice(0, SIDECAR_RESULT_CHAR_LIMIT)}\n\n[truncated sidecar output at ${SIDECAR_RESULT_CHAR_LIMIT} chars]`;
  }
  return out;
}

export function compatibleModeBase(domain: string): string {
  return `https://${domain}/compatible-mode/v1`;
}

export function buildSidecarRequest(opts: {
  model: string;
  transport: SidecarTransport;
  action: SidecarAction;
  task: string;
  strategy?: SidecarStrategy;
}): { url: string; body: Record<string, unknown>; timeoutMs: number } {
  const timeoutMs = opts.action === "research" ? 180_000 : 90_000;
  if (opts.transport === "completions") {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: [{ role: "user", content: opts.task }],
      enable_search: true,
    };
    if (opts.strategy) body.search_options = { search_strategy: opts.strategy };
    return { url: "/chat/completions", body, timeoutMs };
  }
  const body: Record<string, unknown> = {
    model: opts.model,
    input: opts.task,
    tools: sidecarToolsFor(opts.action),
  };
  if (opts.action === "research" || opts.action === "code") body.enable_thinking = true;
  return { url: "/responses", body, timeoutMs };
}

export async function postSidecar(
  domain: string,
  apiKey: string,
  req: { url: string; body: Record<string, unknown>; timeoutMs: number },
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(`${compatibleModeBase(domain)}${req.url}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { ok: res.ok, status: res.status, json };
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error("DashScope sidecar timed out or was aborted.");
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

