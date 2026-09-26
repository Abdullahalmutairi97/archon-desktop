/**
 * Pure IDE document, transcript-artifact, and path projection models.
 *
 * Origin: `current/ide-model.cjs` (SHA-256
 * a4b58955c072b532c1d90d966cad3b09422a78f6714e0306434e91afe5249b09).
 * Transformation: the CommonJS collector and workspace state machine are
 * typed and keyed by the complete execution scope; filesystem ownership and
 * I/O remain the responsibility of an injected `IdeFilePort`.
 */

import {
  documentKeyId,
  isDocumentKey,
  makeDocumentKey,
  sameExecutionScope,
  type DocumentKey,
  type ExecutionScope,
} from "./identity";

export const IDE_MAX_READ_BYTES = 500_000;

export interface IdeMessage {
  id?: string;
  role: "user" | "agent";
  content: string;
  nativeKind?: string;
  streaming?: boolean;
  tools?: readonly IdeToolReference[];
}

export interface IdeToolReference {
  kind?: string;
  target?: string;
}

export interface FileArtifact {
  id: string;
  kind: "file";
  path: string;
  label: string;
  source: string;
}

export interface SnippetArtifact {
  id: string;
  kind: "snippet";
  label: string;
  language: string;
  content: string;
  streaming?: boolean;
  source: string;
}

export type IdeArtifact = FileArtifact | SnippetArtifact;

export interface IdeFileReadResult {
  content?: string;
  binary?: boolean;
  truncated?: boolean;
  revision?: string;
  error?: string;
}

export interface IdeFileWriteResult {
  ok: boolean;
  conflict?: boolean;
  revision?: string;
  error?: string;
}

/** A pure transport contract; implementations must enforce actual path ownership. */
export interface IdeFilePort {
  read(scope: ExecutionScope, path: string, maxBytes: number): Promise<IdeFileReadResult>;
  write(scope: ExecutionScope, path: string, text: string, expectedBase?: string): Promise<IdeFileWriteResult>;
}

export interface IdeDocument {
  id: string;
  kind: "file" | "snippet";
  key?: DocumentKey;
  path?: string;
  label: string;
  text: string;
  base: string;
  readOnly: boolean;
  loading?: boolean;
  saving?: boolean;
  error?: string;
  notice?: string;
  language?: string;
  streaming?: boolean;
  source?: string;
  revision?: string;
}

export interface IdeWorkspaceState {
  docs: Readonly<Record<string, IdeDocument>>;
  tabs: readonly string[];
  active: string;
}

export interface OpenFileOptions {
  protectedEntry?: boolean;
  reload?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function collectRows(input: unknown, depth = 0): unknown[] {
  if (Array.isArray(input)) return input;
  if (depth >= 4 || !isRecord(input)) return [];
  if (Array.isArray(input.messages)) return input.messages;
  if (Array.isArray(input.items)) return input.items;
  for (const key of ["data", "payload", "result"]) {
    const nested = input[key];
    if (Array.isArray(nested)) return nested;
    if (isRecord(nested)) {
      const rows = collectRows(nested, depth + 1);
      if (rows.length > 0) return rows;
    }
  }
  if (isRecord(input.message)) return [input.message];
  return [];
}

/** Normalize server/legacy envelopes into the role and block names consumed by artifact extraction. */
export function normalizeIdeMessages(input: unknown): IdeMessage[] {
  const normalized: IdeMessage[] = [];
  for (const value of collectRows(input)) {
    if (!isRecord(value)) continue;
    const rawRole = value.role;
    const role = rawRole === "user" ? "user" : rawRole === "agent" || rawRole === "assistant" ? "agent" : undefined;
    if (!role) continue;

    const contentValue = value.content;
    let content: string;
    if (typeof contentValue === "string") {
      content = contentValue;
    } else if (Array.isArray(contentValue)) {
      content = contentValue
        .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
        .map((block) => (block as Record<string, unknown>).text as string)
        .join("\n");
    } else {
      content = "";
    }

    const explicitKind = asString(value.nativeKind);
    const backendKind = asString(value.kind);
    const kind = explicitKind || (backendKind && !["text", "message", "assistant", "user"].includes(backendKind) ? backendKind : undefined);
    const idValue = value.id;
    const id = typeof idValue === "string" || typeof idValue === "number" ? String(idValue) : undefined;
    const tools = Array.isArray(value.tools)
      ? value.tools.flatMap((tool): IdeToolReference[] => {
          if (!isRecord(tool)) return [];
          return [{ kind: asString(tool.kind), target: asString(tool.target) }];
        })
      : undefined;
    normalized.push({
      ...(id === undefined ? {} : { id }),
      role,
      content,
      ...(kind ? { nativeKind: kind } : {}),
      ...(value.streaming === true ? { streaming: true } : {}),
      ...(tools ? { tools } : {}),
    });
  }
  return normalized;
}

/** Match the release helper's accepted path syntax without touching the filesystem. */
export function filePath(value: unknown, cwd = ""): string | null {
  let path = String(value || "")
    .trim()
    .replace(/^<|>$/g, "")
    .replace(/(?:#L\d+(?:C\d+)?|:\d+(?::\d+)?)$/, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (
    !path ||
    /[\x00-\x1f]/.test(path) ||
    /^[a-z][a-z\d+.-]*:/i.test(path) ||
    path.startsWith("//")
  ) {
    return null;
  }
  if (!/\.(?:[a-z\d]{1,12})$/i.test(path) && !/(?:^|\/)(?:Dockerfile|Makefile|LICENSE)$/.test(path)) {
    return null;
  }
  if (!path.startsWith("/") && cwd) path = `${cwd.replace(/\/$/, "")}/${path}`;

  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const bit of path.split("/")) {
    if (!bit || bit === ".") continue;
    if (bit === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(bit);
    }
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

/** Project explicit file and code references from normalized assistant messages. */
export function collectArtifacts(input: unknown, sessionId: string, cwd = ""): IdeArtifact[] {
  const items: IdeArtifact[] = [];
  const files = new Set<string>();
  const addFile = (raw: unknown, source: string): void => {
    const path = filePath(raw, cwd);
    if (!path || files.has(path)) return;
    files.add(path);
    items.push({ id: `file:${path}`, kind: "file", path, label: path.split("/").pop() || path, source });
  };

  const messages = normalizeIdeMessages(input);
  messages.forEach((message, messageIndex) => {
    if (message.role !== "agent" || message.nativeKind === "thinking" || message.nativeKind === "tool_result") return;
    const source = message.id || String(messageIndex);
    const text = String(message.content || "");

    if (message.nativeKind === "tool") {
      const split = text.indexOf("\n");
      const name = text.slice(0, split < 0 ? text.length : split);
      const raw = split < 0 ? "" : text.slice(split + 1);
      if (/write|edit|patch/i.test(name)) {
        let args: Record<string, unknown> | null = null;
        try {
          const parsed: unknown = JSON.parse(raw);
          if (isRecord(parsed)) args = parsed;
        } catch {
          // Some patch tools return unified patch text instead of JSON args.
        }
        if (args) addFile(args.path || args.file_path || args.filename, source);
        const patch = typeof args?.patch === "string" ? args.patch : typeof args?.input === "string" ? args.input : raw;
        for (const hit of patch.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)) addFile(hit[1], source);
        const code = args?.content ?? args?.new_string ?? args?.newText;
        if (typeof code === "string") {
          const toolPath = asString(args?.path) || asString(args?.file_path) || "edit";
          items.push({
            id: `snippet:${sessionId}:${source}:tool`,
            kind: "snippet",
            label: `Tool output · ${toolPath}`,
            language: "text",
            content: code,
            source,
          });
        }
      }
      return;
    }

    if (message.nativeKind) return;
    const lines = text.split(/\r?\n/);
    let fence: { mark: string; info: string } | null = null;
    let block: string[] = [];
    let snippetIndex = 0;
    const prose: string[] = [];
    const finishFence = (): void => {
      if (!fence) return;
      const info = fence.info;
      const filename = info.match(/(?:file(?:name)?|path|title)=["']([^"']+)["']|(?:file(?:name)?|path|title)=(\S+)/i);
      const language = info.split(/\s/)[0] || "text";
      const label = filename?.[1] || filename?.[2] || `Snippet ${snippetIndex + 1} · ${language}`;
      items.push({
        id: `snippet:${sessionId}:${source}:${snippetIndex++}`,
        kind: "snippet",
        label,
        language,
        content: block.join("\n"),
        streaming: message.streaming === true,
        source,
      });
      fence = null;
      block = [];
    };

    for (const line of lines) {
      if (!fence) {
        const hit = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if (hit) fence = { mark: hit[1], info: hit[2].trim() };
        else prose.push(line);
      } else if (new RegExp(`^ {0,3}${fence.mark[0]}{${fence.mark.length},}\\s*$`).test(line)) {
        finishFence();
      } else {
        block.push(line);
      }
    }
    if (fence && message.streaming) finishFence();

    const outside = prose.join("\n");
    for (const hit of outside.matchAll(/\[[^\]]+\]\((<[^>]+>|[^)]+)\)/g)) addFile(hit[1], source);
    for (const hit of outside.matchAll(/`([^`\n]+)`/g)) {
      const candidate = hit[1].trim();
      if (candidate.includes("/") || candidate.startsWith("./") || candidate.startsWith("/")) addFile(candidate, source);
    }
    for (const tool of message.tools || []) if (tool.kind === "diff") addFile(tool.target, source);
  });
  return items;
}

export class IdeWorkspace {
  private state: IdeWorkspaceState = { docs: {}, tabs: [], active: "" };
  private readonly listeners = new Set<() => void>();
  private readonly requests = new Map<string, object>();

  constructor(private readonly port: IdeFilePort, private readonly maxBytes = IDE_MAX_READ_BYTES) {}

  snapshot = (): IdeWorkspaceState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(next: IdeWorkspaceState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private patch(id: string, change: Partial<IdeDocument>): void {
    const old = this.state.docs[id];
    if (!old) return;
    this.publish({ ...this.state, docs: { ...this.state.docs, [id]: { ...old, ...change } } });
  }

  isDirty(id: string): boolean {
    const document = this.state.docs[id];
    return !!document && document.kind === "file" && !document.readOnly && document.text !== document.base;
  }

  hasDirtyDocuments(scope?: ExecutionScope): boolean {
    return Object.values(this.state.docs).some((document) =>
      this.isDirty(document.id) && (!scope || (document.key && sameExecutionScope(document.key.scope, scope))),
    );
  }

  select(id: string): void {
    if (this.state.docs[id]) this.publish({ ...this.state, active: id });
  }

  async openFile(key: DocumentKey, options: OpenFileOptions = {}): Promise<void> {
    if (!isDocumentKey(key)) throw new TypeError("Invalid document key");
    if (options.protectedEntry) return;
    const scopedKey = makeDocumentKey(key.scope, key.path);
    const id = documentKeyId(scopedKey);
    const old = this.state.docs[id];
    if (old?.saving) {
      this.select(id);
      return;
    }
    if (old && !options.reload && (!old.error || this.isDirty(id))) {
      this.select(id);
      return;
    }

    const request = {};
    this.requests.set(id, request);
    const tabs = this.state.tabs.includes(id) ? this.state.tabs : [...this.state.tabs, id];
    this.publish({
      ...this.state,
      active: id,
      tabs,
      docs: {
        ...this.state.docs,
        [id]: {
          ...old,
          id,
          kind: "file",
          key: scopedKey,
          path: scopedKey.path,
          label: scopedKey.path.split("/").pop() || scopedKey.path,
          text: old?.text ?? "",
          base: old?.base ?? "",
          error: "",
          readOnly: old?.readOnly ?? true,
          loading: true,
        },
      },
    });
    try {
      const result = await this.port.read(scopedKey.scope, scopedKey.path, this.maxBytes);
      if (this.requests.get(id) !== request) return;
      if (!result || typeof result.content !== "string" || result.error) throw new Error("invalid read response");
      const readOnly = result.binary === true || result.truncated === true;
      this.patch(id, {
        text: result.content,
        base: result.content,
        loading: false,
        readOnly,
        revision: result.revision,
        notice: result.binary ? "Binary preview — read-only" : result.truncated ? "Partial preview — read-only" : "",
      });
    } catch {
      if (this.requests.get(id) === request) {
        this.patch(id, {
          loading: false,
          error: "Could not read this file. Retry when connected.",
          readOnly: old?.readOnly ?? true,
        });
      }
    }
  }

  openSnippet(item: SnippetArtifact): void {
    this.publish({
      ...this.state,
      active: item.id,
      tabs: this.state.tabs.includes(item.id) ? this.state.tabs : [...this.state.tabs, item.id],
      docs: {
        ...this.state.docs,
        [item.id]: {
          ...item,
          id: item.id,
          kind: "snippet",
          text: item.content,
          base: item.content,
          readOnly: true,
        },
      },
    });
  }

  syncSnippets(items: readonly IdeArtifact[]): void {
    let changed = false;
    const docs = { ...this.state.docs };
    for (const item of items) {
      const document = docs[item.id];
      if (item.kind !== "snippet" || !document) continue;
      if (document.text === item.content && document.streaming === item.streaming) continue;
      docs[item.id] = { ...document, ...item, text: item.content, base: item.content };
      changed = true;
    }
    if (changed) this.publish({ ...this.state, docs });
  }

  edit(id: string, text: string): void {
    const document = this.state.docs[id];
    if (document && !document.readOnly && !document.loading && document.kind === "file") this.patch(id, { text });
  }

  close(id: string, discard = false): boolean {
    if (this.state.docs[id]?.saving || (this.isDirty(id) && !discard)) return false;
    this.requests.delete(id);
    const oldIndex = this.state.tabs.indexOf(id);
    const tabs = this.state.tabs.filter((tab) => tab !== id);
    const docs = { ...this.state.docs };
    delete docs[id];
    const active = this.state.active === id
      ? tabs[Math.max(0, oldIndex - 1)] || tabs[0] || ""
      : this.state.active;
    this.publish({ ...this.state, tabs, docs, active });
    return true;
  }

  async save(id: string): Promise<void> {
    const document = this.state.docs[id];
    if (!document || document.kind !== "file" || !document.key || !this.isDirty(id) || document.saving || document.loading) return;
    const text = document.text;
    const base = document.base;
    const request = this.requests.get(id);
    if (!request) return;
    const current = (): boolean => this.requests.get(id) === request && this.state.docs[id]?.saving === true;
    this.patch(id, { saving: true, error: "" });
    try {
      const remote = await this.port.read(document.key.scope, document.path || document.key.path, this.maxBytes);
      if (!current()) return;
      if (!remote || typeof remote.content !== "string" || remote.error) {
        throw new Error("Could not verify this file. Retry when connected.");
      }
      if (
        remote.binary ||
        remote.truncated ||
        remote.content !== base ||
        (document.revision && remote.revision && document.revision !== remote.revision)
      ) {
        throw new Error("File changed on disk. Reload to review the agent’s changes before saving.");
      }

      const result = await this.port.write(
        document.key.scope,
        document.path || document.key.path,
        text,
        document.revision || remote.revision || base,
      );
      if (!current()) return;
      if (!result || result.ok !== true) {
        if (result?.conflict) throw new Error("File changed on disk. Reload to review the agent’s changes before saving.");
        throw new Error(result?.error || "Could not save this file.");
      }
      // A pre-write read revision no longer describes the saved document. Keep
      // only a revision explicitly returned for the successful write.
      this.patch(id, { base: text, saving: false, revision: result.revision });
    } catch (error) {
      if (current()) {
        const message = error instanceof Error && error.message ? error.message : "Save failed";
        this.patch(id, { saving: false, error: message });
      }
    }
  }
}
