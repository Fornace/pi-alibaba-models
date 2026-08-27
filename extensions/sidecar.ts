// DashScope built-in tools, called from a Pi function-tool (sidecar).
// The main chat stays on whatever format /alibaba selected; this module
// POSTs its own Cloud Completions or Responses request and never mixes
// web_search_call events into pi's agent stream.

export type SidecarAction = "research" | "search" | "code" | "image";
export type SidecarStrategy = "turbo" | "max" | "agent" | "agent_max";
export type SidecarTransport = "responses" | "completions";

export const SIDECAR_RESULT_CHAR_LIMIT = 48_000;
export const SIDECAR_HEARTBEAT_MS = 4_000;

export const ALIBABA_TOOLS_PARAMETERS = {
  type: "object" as const,
  properties: {
    action: {
      type: "string" as const,
      enum: ["search", "research", "code", "image"],
      default: "search",
      description:
        "search: quick current-web lookup (default). research: page extraction or multi-source synthesis; " +
        "slower and costlier. code: sandbox computation. image: picture search.",
    },
    task: {
      type: "string" as const,
      description: "Natural-language task, search query, code question, or image-search prompt.",
    },
    strategy: {
      type: "string" as const,
      enum: ["turbo", "max", "agent", "agent_max"],
      description:
        "Usually omit. Legacy Completions search strategy; ignored on the usual Responses path.",
    },
  },
  required: ["task"],
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

// Prefer Flash/Plus so the sidecar does not silently bill a second Max
// sitting in the coding-agent picker.
const LIGHT_PREF = [
  "qwen-flash",
  "qwen3.8-flash",
  "qwen3.7-flash",
  "qwen3.6-flash",
  "qwen3.5-flash",
  "qwen-plus",
  "qwen3.7-plus",
  "qwen3.6-plus",
  "qwen3.5-plus",
  "qwen3.8-max",
  "qwen3.7-max",
  "qwen3-max",
];

const RESEARCH_PREF = [
  "qwen3.7-plus",
  "qwen3.8-flash",
  "qwen-plus",
  "qwen3.7-flash",
  "qwen3.8-max",
  "qwen3.7-max",
  "qwen-flash",
  "qwen3-max",
];

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

  const pref = opts.action === "research" ? RESEARCH_PREF : LIGHT_PREF;
  if (opts.action === "search") {
    const responsesId = firstInCatalog(pref, catalog, responsesToolsAllowed);
    if (responsesId) return { id: responsesId, transport: "responses" };
    const completionsId = firstInCatalog(pref, catalog, completionsSearchAllowed);
    if (completionsId) return { id: completionsId, transport: "completions" };
    return { id: "qwen-plus", transport: "completions" };
  }

  const id = firstInCatalog(pref, catalog, responsesToolsAllowed) ?? "qwen-plus";
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

export function sidecarTimeoutMs(action: SidecarAction, env: NodeJS.ProcessEnv = process.env): number {
  const override = Number(env.ALIBABA_SIDECAR_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) return Math.floor(override);
  if (action === "research") return 480_000;
  return 180_000;
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

function pushCall(calls: string[], line: string) {
  if (!calls.includes(line)) calls.push(line);
}

function recordOutputItem(parsed: SidecarParsed, item: Record<string, unknown>) {
  const type = typeof item.type === "string" ? item.type : "";
  const action = asRecord(item.action);
  if (type === "web_search_call") {
    const q = typeof action?.query === "string" ? action.query : undefined;
    pushCall(parsed.calls, q ? `web_search: ${q}` : "web_search");
    pushSources(parsed.sources, action?.sources ?? item.sources);
  } else if (type === "web_extractor_call") {
    const url = typeof action?.url === "string" ? action.url : undefined;
    pushCall(parsed.calls, url ? `web_extractor: ${url}` : "web_extractor");
  } else if (type === "code_interpreter_call") {
    pushCall(parsed.calls, "code_interpreter");
  } else if (type === "web_search_image_call" || type === "image_search_call") {
    pushCall(parsed.calls, type.replace(/_call$/, ""));
  } else if (type === "message" && !parsed.text) {
    parsed.text = messageText(item);
  }
}

export function parseSidecarResponse(body: unknown): SidecarParsed {
  const root = asRecord(body) ?? {};
  const parsed: SidecarParsed = {
    text: typeof root.output_text === "string" ? root.output_text : "",
    sources: [],
    calls: [],
  };

  const output = Array.isArray(root.output) ? root.output : [];
  for (const raw of output) {
    const item = asRecord(raw);
    if (item) recordOutputItem(parsed, item);
  }

  if (!parsed.text) {
    const choices = Array.isArray(root.choices) ? root.choices : [];
    const msg = asRecord(asRecord(choices[0])?.message);
    const content = msg?.content;
    if (typeof content === "string") parsed.text = content;
  }

  parsed.text = parsed.text.trim();
  return parsed;
}

/** Fold one Responses/Completions SSE JSON object into accumulated sidecar state. */
export function applySidecarStreamEvent(parsed: SidecarParsed, event: unknown): void {
  const ev = asRecord(event);
  if (!ev) return;
  const type = typeof ev.type === "string" ? ev.type : "";

  if (type === "response.completed" || type === "response.incomplete") {
    const full = parseSidecarResponse(ev.response ?? ev);
    if (full.text) parsed.text = full.text;
    for (const c of full.calls) pushCall(parsed.calls, c);
    parsed.sources.push(...full.sources);
    return;
  }

  if (type === "response.output_text.delta" || type === "response.output_text.done") {
    const delta = typeof ev.delta === "string" ? ev.delta : typeof ev.text === "string" ? ev.text : "";
    if (delta && type.endsWith("delta")) parsed.text += delta;
    return;
  }

  const item = asRecord(ev.item);
  if (item && (type === "response.output_item.added" || type === "response.output_item.done")) {
    recordOutputItem(parsed, item);
    return;
  }

  if (type.includes("web_search") || type.includes("web_extractor") || type.includes("code_interpreter") || type.includes("image_search")) {
    const short = type.replace(/^response\./, "").replace(/\.in_progress$|\.completed$|\.searching$/, "");
    if (short) pushCall(parsed.calls, short);
  }

  const choice = asRecord(Array.isArray(ev.choices) ? ev.choices[0] : undefined);
  const delta = asRecord(choice?.delta);
  if (typeof delta?.content === "string") parsed.text += delta.content;
}

export function consumeSseChunk(buffer: string, onEvent: (data: unknown) => void): string {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const block of parts) {
    const dataLines = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart());
    const payload = dataLines.join("\n");
    if (!payload || payload === "[DONE]") continue;
    try { onEvent(JSON.parse(payload)); } catch { /* ignore keepalives / malformed */ }
  }
  return rest;
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

export function formatSidecarResult(parsed: SidecarParsed, heading?: string): string {
  const parts: string[] = [];
  if (heading) parts.push(heading);
  if (parsed.calls.length) parts.push(`Calls:\n${parsed.calls.map((c) => `- ${c}`).join("\n")}`);
  parts.push(parsed.text || "(empty sidecar response)");
  if (parsed.sources.length) {
    const uniq = new Map<string, SidecarSource>();
    for (const s of parsed.sources) uniq.set(s.url || s.title || JSON.stringify(s), s);
    const lines = [...uniq.values()].slice(0, 12).map((s) => {
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

export function formatSidecarProgress(action: SidecarAction, elapsedMs: number, parsed: SidecarParsed): string {
  const secs = Math.max(1, Math.round(elapsedMs / 1000));
  return formatSidecarResult(parsed, `DashScope sidecar (${action}) running… ${secs}s`);
}

export function sidecarTimeoutMessage(action: SidecarAction, timeoutMs: number, userAbort: boolean): string {
  if (userAbort) return "DashScope sidecar aborted.";
  const secs = Math.round(timeoutMs / 1000);
  const hint = action === "research"
    ? "Retry with action=search (faster) or a narrower task."
    : "Retry with a narrower task, or raise ALIBABA_SIDECAR_TIMEOUT_MS.";
  return `DashScope sidecar timed out after ${secs}s (action=${action}). ${hint}`;
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
  timeoutMs?: number;
}): { url: string; body: Record<string, unknown>; timeoutMs: number; action: SidecarAction } {
  const timeoutMs = opts.timeoutMs ?? sidecarTimeoutMs(opts.action);
  if (opts.transport === "completions") {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: [{ role: "user", content: opts.task }],
      enable_search: true,
      stream: true,
    };
    if (opts.strategy) body.search_options = { search_strategy: opts.strategy };
    return { url: "/chat/completions", body, timeoutMs, action: opts.action };
  }
  const body: Record<string, unknown> = {
    model: opts.model,
    input: opts.task,
    tools: sidecarToolsFor(opts.action),
    stream: true,
  };
  if (opts.action === "research" || opts.action === "code") body.enable_thinking = true;
  return { url: "/responses", body, timeoutMs, action: opts.action };
}

export type SidecarProgressFn = (parsed: SidecarParsed, elapsedMs: number) => void;

export async function postSidecar(
  domain: string,
  apiKey: string,
  req: { url: string; body: Record<string, unknown>; timeoutMs: number; action: SidecarAction },
  signal?: AbortSignal,
  onProgress?: SidecarProgressFn,
): Promise<{ ok: boolean; status: number; json: unknown; parsed: SidecarParsed }> {
  const ctrl = new AbortController();
  const started = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, req.timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);

  const parsed: SidecarParsed = { text: "", sources: [], calls: [] };
  const beat = setInterval(() => onProgress?.(parsed, Date.now() - started), SIDECAR_HEARTBEAT_MS);

  try {
    const res = await fetch(`${compatibleModeBase(domain)}${req.url}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json",
      },
      body: JSON.stringify(req.body),
      signal: ctrl.signal,
    });

    const ctype = res.headers.get("content-type") || "";
    if (!res.ok) {
      const text = await res.text();
      let json: unknown;
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
      return { ok: false, status: res.status, json, parsed };
    }

    if (!res.body || (!ctype.includes("event-stream") && ctype.includes("json"))) {
      const text = await res.text();
      let json: unknown;
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
      const done = parseSidecarResponse(json);
      return { ok: true, status: res.status, json, parsed: done };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let lastEmit = 0;
    const absorb = (event: unknown) => {
      applySidecarStreamEvent(parsed, event);
      const now = Date.now();
      if (now - lastEmit > 400) {
        lastEmit = now;
        onProgress?.(parsed, now - started);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf = consumeSseChunk(buf + decoder.decode(value, { stream: true }), absorb);
    }
    if (buf.trim()) consumeSseChunk(buf + "\n\n", absorb);

    const json = {
      output_text: parsed.text,
      output: parsed.calls.map((c) => ({ type: "note", summary: c })),
    };
    return { ok: true, status: res.status, json, parsed };
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new Error(sidecarTimeoutMessage(req.action, req.timeoutMs, !timedOut));
    }
    throw e;
  } finally {
    clearInterval(beat);
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
