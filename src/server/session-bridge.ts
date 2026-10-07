/** Read-only Pi session browsing and independent conversation handoffs, without replaying tools or extension state. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, ModelThinkingLevel, ToolCall } from "@earendil-works/pi-ai";
import {
    convertToLlm,
    CURRENT_SESSION_VERSION,
    type FileEntry,
    type SessionContext,
    getAgentDir,
    migrateSessionEntries,
    SessionManager,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
    AssistantEntry,
    type ConversationId,
    ToolResultEntry,
    UserEntry,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { SessionImportsDoc, SessionSourceDoc, SessionsDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";
import { modelList } from "./models.ts";
import { expandHome } from "./paths.ts";

const context = BACKGROUND_CONTEXT;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_SESSIONS = 200;
const HANDOFF_WARNING =
    "This is an independent copy of the selected context. System instructions, extension state, running work, schedules, and approvals are not transferred.";

function hash(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

function requireOwner(user: User): void {
    if (user.role !== "owner") {
        throw new HttpError(403, "Only the owner can browse or import local Pi sessions");
    }
}

/** Plain, bounded preview text. Image data and provider signatures never enter the picker. */
function textOf(content: unknown): string {
    if (typeof content === "string") {
        return content.slice(0, 4000);
    }

    if (!Array.isArray(content)) {
        return "";
    }

    return content
        .map((part) => {
            if (part.type === "text") {
                return part.text;
            }

            if (part.type === "thinking") {
                return "[thinking]";
            }

            if (part.type === "toolCall") {
                return `[tool call: ${part.name}]`;
            }

            return part.type === "image" ? "[image]" : "";
        })
        .join("\n")
        .slice(0, 4000);
}

function previewEntry(entry: SessionEntry) {
    return {
        id: entry.id,
        kind: entry.type === "message" ? entry.message.role : entry.type,
        text:
            entry.type === "message"
                ? textOf("content" in entry.message ? entry.message.content : "")
                : entry.type === "compaction" || entry.type === "branch_summary"
                  ? entry.summary.slice(0, 4000)
                  : entry.type === "custom_message"
                    ? textOf(entry.content)
                    : "",
    };
}

/** Reject malformed model-facing payloads before they become stored destination context. */
function validateMessage(message: Message): void {
    const bad = () => {
        throw new HttpError(400, "The conversation contains malformed messages");
    };

    if (!Number.isFinite(message.timestamp)) {
        bad();
    }

    if (message.role === "user" && typeof message.content === "string") {
        return;
    }

    if (!Array.isArray(message.content)) {
        bad();

        return;
    }

    for (const part of message.content) {
        if (!part || typeof part !== "object") {
            bad();
            continue;
        }

        if (part.type === "text" && typeof part.text === "string") {
            continue;
        }

        if (
            part.type === "image" &&
            message.role !== "assistant" &&
            typeof part.data === "string" &&
            typeof part.mimeType === "string"
        ) {
            continue;
        }

        if (
            message.role === "assistant" &&
            part.type === "thinking" &&
            typeof part.thinking === "string"
        ) {
            continue;
        }

        if (
            message.role === "assistant" &&
            part.type === "toolCall" &&
            typeof part.id === "string" &&
            typeof part.name === "string" &&
            part.arguments !== null &&
            typeof part.arguments === "object" &&
            !Array.isArray(part.arguments)
        ) {
            continue;
        }

        bad();
    }

    if (
        message.role === "assistant" &&
        (typeof message.api !== "string" ||
            typeof message.provider !== "string" ||
            typeof message.model !== "string" ||
            !message.usage ||
            !message.usage.cost ||
            typeof message.stopReason !== "string")
    ) {
        bad();
    }

    if (
        message.role === "toolResult" &&
        (typeof message.toolCallId !== "string" ||
            typeof message.toolName !== "string" ||
            typeof message.isError !== "boolean")
    ) {
        bad();
    }
}

/** Resolve incomplete calls as historical errors, never as executable pending work. */
export function handoffMessages(source: readonly Message[], warnings: string[]): Message[] {
    const messages: Message[] = [];
    const pending = new Map<string, ToolCall>();
    const seen = new Set<string>();

    const finish = () => {
        for (const call of pending.values()) {
            messages.push({
                role: "toolResult",
                toolCallId: call.id,
                toolName: call.name,
                content: [
                    {
                        type: "text",
                        text: "Interrupted before handoff; not executed by the destination.",
                    },
                ],
                isError: true,
                timestamp: Date.now(),
            });
            warnings.push(
                `Unfinished tool call ${call.name} was closed with an error; it will not be replayed.`,
            );
        }

        pending.clear();
    };

    for (const message of source) {
        if (message.role === "system") {
            continue;
        }

        validateMessage(message);

        if (message.role === "toolResult") {
            if (!pending.has(message.toolCallId)) {
                warnings.push(
                    `Orphan tool result ${message.toolName} was left out of active context.`,
                );
                continue;
            }

            if (pending.get(message.toolCallId)?.name !== message.toolName) {
                throw new HttpError(400, "A tool result does not match its historical call");
            }

            pending.delete(message.toolCallId);
            messages.push(message);
            continue;
        }

        finish();

        if (message.role === "assistant") {
            if (["pending", "deferred", "error", "aborted"].includes(message.stopReason)) {
                warnings.push(
                    `An ${message.stopReason} assistant response was left out of active context.`,
                );
                continue;
            }

            for (const part of message.content) {
                if (part.type === "toolCall") {
                    if (seen.has(part.id)) {
                        throw new HttpError(400, "The conversation has duplicate tool call IDs");
                    }

                    seen.add(part.id);
                    pending.set(part.id, part);
                }
            }
        }

        messages.push(message);
    }

    finish();

    return messages;
}

class AlreadyImported extends Error {
    readonly id: ConversationId;

    constructor(id: number) {
        super("This snapshot was already imported");
        this.id = id as ConversationId;
    }
}

export type ImportRequest = {
    source: string;
    snapshot: string;
    leafId?: string;
    cwd: string;
    model: { provider: string; modelId: string };
    thinkingLevel?: string;
};

export class SessionBridge {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    #root(): string {
        return resolve(
            expandHome(
                process.env.PI_CODING_AGENT_SESSION_DIR ??
                    this.#app.settings.getSessionDir() ??
                    join(getAgentDir(), "sessions"),
            ),
        );
    }

    /** Only regular JSONL files immediately in the configured root or one project directory below it. */
    async #path(source: string): Promise<string> {
        if (typeof source !== "string" || !/^[A-Za-z0-9_-]{1,4096}$/.test(source)) {
            throw new HttpError(400, "Invalid Pi session source");
        }

        const name = Buffer.from(source, "base64url").toString("utf8");
        const parts = name.split("/");

        if (
            parts.length > 2 ||
            parts.some(
                (part) => part === "" || part === "." || part === ".." || part.includes("\\"),
            ) ||
            !name.endsWith(".jsonl")
        ) {
            throw new HttpError(400, "Invalid Pi session source");
        }

        const root = await realpath(this.#root());
        const file = join(root, ...parts);
        const real = await realpath(file);

        if (real !== file || !real.startsWith(root + sep) || !(await lstat(file)).isFile()) {
            throw new HttpError(
                400,
                "Pi session must be a regular file inside the session directory",
            );
        }

        return file;
    }

    async #snapshot(source: string) {
        let file: FileHandle;

        try {
            file = await open(await this.#path(source), constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch (error) {
            if (error instanceof HttpError) {
                throw error;
            }

            throw new HttpError(404, "Pi session not found");
        }

        let raw: string;
        let modified: number;

        try {
            const before = await file.stat();

            if (!before.isFile() || before.size > MAX_BYTES) {
                throw new HttpError(413, "Pi session exceeds the 20 MiB import limit");
            }

            // A bounded read also protects against a file growing while it is read.
            const buffer = Buffer.alloc(before.size + 1);
            let length = 0;

            while (length < buffer.length) {
                const read = await file.read(buffer, length, buffer.length - length, length);

                if (read.bytesRead === 0) {
                    break;
                }

                length += read.bytesRead;
            }

            const after = await file.stat();

            if (
                before.size !== after.size ||
                before.mtimeMs !== after.mtimeMs ||
                length !== before.size
            ) {
                throw new HttpError(
                    409,
                    "Pi session changed while being read. Refresh and try again.",
                );
            }

            raw = buffer.subarray(0, length).toString("utf8");
            modified = before.mtimeMs;
        } finally {
            await file.close();
        }

        try {
            // Strict parsing, unlike best-effort CLI discovery: never silently lose a malformed final line.
            const entries = raw
                .split(/\r?\n/)
                .filter((line) => line.trim() !== "")
                .map((line) => JSON.parse(line) as FileEntry);
            const header = entries[0];

            if (
                !header ||
                header.type !== "session" ||
                typeof header.id !== "string" ||
                typeof header.cwd !== "string" ||
                (header.version ?? 1) > CURRENT_SESSION_VERSION ||
                entries.length > MAX_ENTRIES
            ) {
                throw new Error("Invalid or unsupported session header");
            }

            const legacy = (header.version ?? 1) < 2;

            migrateSessionEntries(entries);

            if (legacy) {
                // The SDK gives v1 entries random IDs. Stabilize them by file position so a preview's
                // branch ID and an import's deduplication key survive rereads and server restarts.
                const ids = new Map(
                    entries
                        .filter((entry) => entry.type !== "session")
                        .map((entry, index) => [
                            entry.id,
                            (index + 1).toString(16).padStart(8, "0"),
                        ]),
                );

                for (const entry of entries) {
                    if (entry.type === "session") {
                        continue;
                    }

                    entry.id = ids.get(entry.id)!;
                    entry.parentId = entry.parentId === null ? null : ids.get(entry.parentId)!;

                    if (entry.type === "compaction") {
                        entry.firstKeptEntryId =
                            ids.get(entry.firstKeptEntryId) ?? entry.firstKeptEntryId;
                    }

                    if (entry.type === "context_edit" || entry.type === "label") {
                        entry.targetId = ids.get(entry.targetId) ?? entry.targetId;
                    }

                    if (entry.type === "branch_summary") {
                        entry.fromId = ids.get(entry.fromId) ?? entry.fromId;
                    }
                }
            }

            const manager = SessionManager.inMemory(header.cwd, undefined, entries);
            const seen = new Set<string>();

            for (const entry of manager.getEntries()) {
                if (
                    typeof entry.id !== "string" ||
                    seen.has(entry.id) ||
                    (entry.parentId !== null && !seen.has(entry.parentId))
                ) {
                    throw new Error("Invalid entry ancestry");
                }

                seen.add(entry.id);
            }

            return { manager, snapshot: hash(raw), modified };
        } catch {
            throw new HttpError(
                400,
                "Pi session is malformed, incomplete, or uses an unsupported format",
            );
        }
    }

    async list(user: User) {
        requireOwner(user);
        const root = this.#root();
        const warnings: string[] = [];
        const candidates: { source: string; modified: number }[] = [];
        let scanned = 0;

        const scan = async (directory: string) => {
            for await (const entry of await readdir(join(root, directory), {
                withFileTypes: true,
            })) {
                if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
                    continue;
                }

                scanned++;

                if (scanned > 1000) {
                    break;
                }

                const path = join(root, directory, entry.name);
                const name = relative(root, path).split(sep).join("/");
                const stat = await lstat(path).catch(() => undefined);

                if (stat?.isFile() && stat.size <= MAX_BYTES) {
                    candidates.push({
                        source: Buffer.from(name).toString("base64url"),
                        modified: stat.mtimeMs,
                    });
                } else {
                    warnings.push(`${entry.name} was skipped (missing or larger than 20 MiB).`);
                }
            }
        };

        try {
            await scan("");

            for (const entry of await readdir(root, { withFileTypes: true })) {
                if (entry.isDirectory() && scanned <= 1000) {
                    await scan(entry.name);
                }
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw new HttpError(400, "Cannot read the Pi session directory");
            }
        }

        candidates.sort((a, b) => b.modified - a.modified);
        const sessions = [];

        for (const candidate of candidates.slice(0, MAX_SESSIONS)) {
            try {
                const { manager, modified } = await this.#snapshot(candidate.source);
                const first = manager
                    .getEntries()
                    .find((entry) => entry.type === "message" && entry.message.role === "user");

                sessions.push({
                    source: candidate.source,
                    id: manager.getSessionId(),
                    cwd: manager.getCwd(),
                    name:
                        manager.getSessionName() ??
                        (first ? previewEntry(first).text.slice(0, 100) : "Pi session"),
                    modified,
                    messageCount: manager.getEntries().filter((entry) => entry.type === "message")
                        .length,
                });
            } catch {
                warnings.push(`A Pi session was skipped because it could not be read safely.`);
            }
        }

        if (candidates.length > MAX_SESSIONS || scanned > 1000) {
            warnings.push("Showing at most 200 recent sessions from up to 1000 files.");
        }

        return { root, sessions, warnings: [...new Set(warnings)] };
    }

    async #selection(source: string, leafId?: string) {
        const snapshot = await this.#snapshot(source);
        const { manager } = snapshot;

        if (leafId !== undefined) {
            if (typeof leafId !== "string" || manager.getEntry(leafId) === undefined) {
                throw new HttpError(400, "No such branch entry");
            }

            manager.branch(leafId);
        }

        const branch = manager.getBranch();
        const warnings = [HANDOFF_WARNING];

        if (branch.some((entry) => entry.type === "custom")) {
            warnings.push(
                "Extension state is kept only in the source archive, not loaded by Pocket.",
            );
        }

        let resolved: SessionContext;

        try {
            resolved = manager.buildSessionContext();
        } catch {
            throw new HttpError(400, "This branch contains invalid context or compaction entries");
        }

        let messages: Message[];

        try {
            const converted = convertToLlm(resolved.messages);

            if (converted.length < resolved.messages.length) {
                warnings.push(
                    "Unsupported or excluded messages were left out of active context; see the source archive.",
                );
            }

            messages = handoffMessages(converted, warnings);
        } catch (error) {
            if (error instanceof HttpError) {
                throw error;
            }

            throw new HttpError(400, "This branch contains malformed messages");
        }

        return { ...snapshot, branch, resolved, messages, warnings: [...new Set(warnings)] };
    }

    async preview(user: User, source: string, leafId?: string) {
        requireOwner(user);
        const { manager, snapshot, branch, resolved, messages, warnings } = await this.#selection(
            source,
            leafId,
        );
        const entries = manager.getEntries();
        const parents = new Set(entries.map((entry) => entry.parentId));

        return {
            source,
            snapshot,
            leafId: manager.getLeafId(),
            cwd: manager.getCwd(),
            name: manager.getSessionName() ?? "Imported Pi session",
            model: resolved.model,
            thinkingLevel: resolved.thinkingLevel,
            branches: entries
                .filter((entry) => !parents.has(entry.id))
                .map((entry) => ({
                    id: entry.id,
                    label:
                        manager.getLabel(entry.id) ??
                        `${entry.id} · ${entry.type} · ${entry.timestamp}`,
                })),
            entries: branch.slice(-100).map(previewEntry),
            totalEntries: branch.length,
            contextMessages: messages.length,
            warnings,
        };
    }

    async import(user: User, request: ImportRequest) {
        requireOwner(user);

        if (
            !request ||
            typeof request.cwd !== "string" ||
            typeof request.snapshot !== "string" ||
            typeof request.model?.provider !== "string" ||
            typeof request.model?.modelId !== "string"
        ) {
            throw new HttpError(400, "source, snapshot, cwd, and model are required");
        }

        const selected = await this.#selection(request.source, request.leafId);

        if (request.snapshot !== selected.snapshot) {
            throw new HttpError(
                409,
                "Pi session changed since the preview. Refresh it before importing.",
            );
        }

        const cwd = this.#app.workspace.checkDirectory(request.cwd);
        const model = modelList(this.#app.models).find(
            (model) =>
                model.provider === request.model.provider && model.id === request.model.modelId,
        );
        const thinkingLevel = request.thinkingLevel ?? selected.resolved.thinkingLevel;

        if (!model || !model.levels.includes(thinkingLevel)) {
            throw new HttpError(400, "Choose an available model and supported thinking level");
        }

        if (
            !model.images &&
            selected.messages.some(
                (message) =>
                    Array.isArray(message.content) &&
                    message.content.some((part) => part.type === "image"),
            )
        ) {
            throw new HttpError(
                400,
                "This conversation contains images. Choose a model that accepts images.",
            );
        }

        const leafId = selected.manager.getLeafId();

        if (!leafId || selected.messages.length === 0) {
            throw new HttpError(400, "This branch has no transferable conversation context");
        }

        const ref = { provider: model.provider, modelId: model.id };
        const key = hash(
            JSON.stringify([
                selected.manager.getSessionId(),
                selected.snapshot,
                leafId,
                cwd,
                ref,
                thinkingLevel,
            ]),
        );
        const now = Date.now();
        const jsonl =
            [selected.manager.getHeader(), ...selected.branch]
                .map((entry) => JSON.stringify(entry))
                .join("\n") + "\n";

        try {
            const conversation = await this.#app.harness.createConversation(
                {
                    ownership: { kind: "ownerless" },
                    agent: { cwd, model: ref, thinkingLevel: thinkingLevel as ModelThinkingLevel },
                    init: async (tx, id) => {
                        const imports = await tx.doc(SessionImportsDoc);
                        const existing = imports.items[key];

                        if (existing !== undefined) {
                            throw new AlreadyImported(existing);
                        }

                        imports.items[key] = Number(id);
                        (await tx.doc(SessionsDoc)).items[String(id)] = {
                            cwd,
                            title: `${selected.manager.getSessionName() ?? "Pi session"} · imported`.slice(
                                0,
                                120,
                            ),
                            createdAt: now,
                            updatedAt: now,
                            createdBy: user.id,
                        };
                        Object.assign(await tx.doc(SessionSourceDoc, id), {
                            jsonl,
                            sessionId: selected.manager.getSessionId(),
                            snapshot: selected.snapshot,
                            leafId,
                            warnings: selected.warnings,
                        });

                        for (const message of selected.messages) {
                            if (message.role === "toolResult") {
                                await tx.appendEntry(ToolResultEntry, id, {
                                    model: [message],
                                    data: { diagnostics: [] },
                                });
                            } else {
                                await tx.appendEntry(
                                    message.role === "assistant" ? AssistantEntry : UserEntry,
                                    id,
                                    { model: [message] },
                                );
                            }
                        }
                    },
                },
                context,
            );

            return { id: conversation.id, warnings: selected.warnings, existing: false };
        } catch (error) {
            if (error instanceof AlreadyImported) {
                return { id: error.id, warnings: selected.warnings, existing: true };
            }

            throw error;
        }
    }

    async sourceArchive(user: User, id: ConversationId): Promise<string> {
        requireOwner(user);
        this.#app.requireSee(user, id);
        const source = await this.#app.harness.snapshot(SessionSourceDoc, id, context);

        if (!source?.jsonl) {
            throw new HttpError(404, "This conversation has no imported source archive");
        }

        return source.jsonl;
    }

    async exportPi(user: User, id: ConversationId) {
        this.#app.requireSee(user, id);
        const conversation = await this.#app.conversation(id);
        const active = await conversation.context(context);
        const warnings = [HANDOFF_WARNING];
        const messages = handoffMessages(active.messages, warnings);
        const agent = await conversation.agent(context);
        const cwd = agent.cwd ?? this.#app.defaultCwd;
        const manager = SessionManager.inMemory(cwd);

        if (agent.model) {
            manager.appendModelChange(agent.model.provider, agent.model.modelId);
        }

        manager.appendThinkingLevelChange(agent.thinkingLevel ?? "off");
        manager.appendSessionInfo(await this.#app.conversationTitle(id));
        manager.appendCustomEntry("pocket.handoff", {
            version: 1,
            conversationId: Number(id),
            warnings: [...new Set(warnings)],
            exportedAt: new Date().toISOString(),
        });

        for (const message of messages) {
            manager.appendMessage(message);
        }

        const jsonl =
            [manager.getHeader(), ...manager.getEntries()]
                .map((entry) => JSON.stringify(entry))
                .join("\n") + "\n";

        const source =
            user.role === "owner"
                ? await this.#app.harness.snapshot(SessionSourceDoc, id, context)
                : undefined;

        return {
            filename: `${basename(cwd).replace(/[^a-zA-Z0-9_-]/g, "-") || "session"}-${Number(id)}.jsonl`,
            jsonl,
            warnings: [...new Set(warnings)],
            sourceAvailable: Boolean(source?.jsonl),
        };
    }
}
