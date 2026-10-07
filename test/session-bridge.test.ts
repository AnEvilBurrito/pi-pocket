// Independent handoffs preserve selected context without mutating Pi files or replaying historical work.
import {
    type App,
    cleanUp,
    context,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync, statSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ResetEntry, UsageDoc } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import { handoffMessages } from "../src/server/session-bridge.ts";
import { SessionSourceDoc } from "../src/server/docs.ts";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

let app: App;
let server: Server;
let base: string;
let modelCalls = 0;
const sessionsDir = join(process.env.PI_CODING_AGENT_DIR!, "sessions", "--project--");
const sourceFile = join(sessionsDir, "history.jsonl");
const image = { type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" };

function sourceSession() {
    const manager = SessionManager.inMemory(work);

    manager.appendModelChange("faux", "faux-1");
    manager.appendThinkingLevelChange("off");
    manager.appendSessionInfo("Old Pi work");
    manager.appendMessage({
        role: "system",
        content: "Do not transfer",
        sections: { secret: "old prompt" },
        timestamp: 1,
    });
    manager.appendMessage({ role: "user", content: "older history", timestamp: 2 });
    manager.appendMessage(fauxAssistantMessage([fauxText("older reply")]));
    const retained = manager.appendMessage({
        role: "user",
        content: "retained history",
        timestamp: 3,
    });

    manager.appendCompaction("summary of older history", retained, 1000);
    const forkPoint = manager.appendMessage(fauxAssistantMessage([fauxText("shared reply")]));

    manager.appendMessage({ role: "user", content: "branch A only", timestamp: 4 });
    const branchA = manager.appendMessage(fauxAssistantMessage([fauxText("A answer")]));

    manager.branch(forkPoint);
    const edited = manager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "branch B original" }, image],
        timestamp: 5,
    });

    manager.appendContextEdit(edited, {
        content: [{ type: "text", text: "branch B edited" }, image],
    });
    manager.appendCustomEntry("dangerous.extension", { command: "must not run" });
    manager.appendMessage(
        fauxAssistantMessage(
            [fauxToolCall("bash", { command: "touch must-not-exist" }, { id: "historical-call" })],
            { stopReason: "toolUse" },
        ),
    );
    const branchB = manager.getLeafId()!;
    const entries: FileEntry[] = [manager.getHeader()!, ...manager.getEntries()];

    return { entries, branchA, branchB };
}

const fixture = sourceSession();
const source = Buffer.from("--project--/history.jsonl").toString("base64url");
const headers = () => ({
    authorization: `Bearer ${app.config.ownerToken}`,
    "X-Pocket": "1",
    "Content-Type": "application/json",
});
const request = (path: string, body?: unknown, token?: string) =>
    fetch(`${base}/api/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: token ? { ...headers(), authorization: `Bearer ${token}` } : headers(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
const preview = (leafId = fixture.branchB) => app.sessionBridge.preview(owner(app), source, leafId);

const importBranch = async (leafId = fixture.branchB) => {
    const selected = await preview(leafId);

    return app.sessionBridge.import(owner(app), {
        source,
        snapshot: selected.snapshot,
        leafId,
        cwd: work,
        model: { provider: "faux", modelId: "faux-vision" },
        thinkingLevel: "off",
    });
};

before(async () => {
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
        sourceFile,
        fixture.entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
    app = await openApp(
        scriptedModel(() => {
            modelCalls++;

            return fauxAssistantMessage([fauxText("continued")]);
        }),
    );
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    for (const client of app?.clients ?? []) {
        client.close?.();
        app.detach(client);
    }

    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("owner can discover and preview branches without changing the source", async () => {
    const bytes = readFileSync(sourceFile);
    const mtime = statSync(sourceFile).mtimeMs;
    const listing = await app.sessionBridge.list(owner(app));

    assert.equal(listing.sessions.length, 1);
    assert.equal(listing.sessions[0]!.name, "Old Pi work");
    assert.equal(listing.sessions[0]!.cwd, work);
    const selected = await preview();

    assert.equal(selected.branches.length, 2);
    assert.equal(selected.leafId, fixture.branchB);
    assert.match(JSON.stringify(selected.entries), /branch B original/);
    assert.doesNotMatch(JSON.stringify(selected.entries), /branch A only/);
    assert.doesNotMatch(
        JSON.stringify(selected.entries),
        /aW1hZ2U=/,
        "picker excludes image payloads",
    );
    assert.ok(selected.warnings.some((warning) => warning.includes("Unfinished tool call")));
    assert.deepEqual(readFileSync(sourceFile), bytes);
    assert.equal(statSync(sourceFile).mtimeMs, mtime);
});

test("import resolves compaction and edits, preserves images, and starts no work", async () => {
    const before = modelCalls;
    const result = await importBranch();
    const texts = (await modelTexts(app, result.id)).join("\n");

    assert.match(texts, /summary of older history/);
    assert.match(texts, /retained history/);
    assert.match(texts, /branch B edited/);
    assert.match(texts, /aW1hZ2U=/);
    assert.doesNotMatch(texts, /branch A only|branch B original|old prompt|older reply/);
    const active = await (await app.conversation(result.id)).context(context);

    assert.equal(active.messages.at(-1)?.role, "toolResult");
    assert.match(JSON.stringify(active.messages.at(-1)), /not executed/);
    assert.equal(modelCalls, before);
    assert.equal(app.isBusy(result.id), false);
    const usage = await app.harness.snapshot(UsageDoc, result.id, context);

    assert.equal(
        Object.keys(usage?.models ?? {}).length,
        0,
        "historical costs are not billed again",
    );
    const archive = await app.sessionBridge.sourceArchive(owner(app), result.id);

    assert.match(archive, /dangerous.extension/);
    assert.match(archive, /older reply/);
    assert.doesNotMatch(archive, /branch A only/);
    await say(app, result.id, "continue from here");
    assert.equal(modelCalls, before + 1, "only the new request runs");
});

test("retrying or concurrently importing the same snapshot creates one session", async () => {
    const count = app.sessions().length;
    const results = await Promise.all([
        importBranch(fixture.branchA),
        importBranch(fixture.branchA),
    ]);

    assert.equal(results[0]!.id, results[1]!.id);
    assert.equal(results.filter((result) => result.existing).length, 1);
    assert.equal(app.sessions().length, count + 1);
    const texts = (await modelTexts(app, results[0]!.id)).join("\n");

    assert.match(texts, /branch A only/);
    assert.doesNotMatch(texts, /branch B/);
});

test("a changed source requires a new preview", async () => {
    const selected = await preview();
    const original = readFileSync(sourceFile, "utf8");

    try {
        writeFileSync(sourceFile, original + "\n");
        await assert.rejects(
            app.sessionBridge.import(owner(app), {
                source,
                snapshot: selected.snapshot,
                cwd: work,
                model: { provider: "faux", modelId: "faux-1" },
            }),
            /changed since the preview/,
        );
    } finally {
        writeFileSync(sourceFile, original);
    }
});

test("malformed JSON, cycles, unsupported versions and path escapes are rejected", async () => {
    const badFile = join(sessionsDir, "bad.jsonl");
    const badSource = Buffer.from("--project--/bad.jsonl").toString("base64url");
    const malformed = [
        '{"type":"session",',
        JSON.stringify({ ...fixture.entries[0], version: 999 }),
        [
            fixture.entries[0],
            {
                type: "message",
                id: "cycle",
                parentId: "cycle",
                timestamp: new Date().toISOString(),
                message: { role: "user", content: "bad", timestamp: 0 },
            },
        ]
            .map((entry) => JSON.stringify(entry))
            .join("\n"),
    ];

    for (const content of malformed) {
        writeFileSync(badFile, content);
        await assert.rejects(app.sessionBridge.preview(owner(app), badSource), /malformed/);
    }

    for (const name of ["../history.jsonl", "/etc/history.jsonl", "--project--/../history.jsonl"]) {
        await assert.rejects(
            app.sessionBridge.preview(owner(app), Buffer.from(name).toString("base64url")),
            /Invalid Pi session source/,
        );
    }

    const outside = join(root, "outside.jsonl");
    const link = join(sessionsDir, "link.jsonl");

    writeFileSync(outside, readFileSync(sourceFile));
    symlinkSync(outside, link);
    await assert.rejects(
        app.sessionBridge.preview(
            owner(app),
            Buffer.from("--project--/link.jsonl").toString("base64url"),
        ),
        /regular file/,
    );
});

test("Pi JSONL export restores selected context and excludes Pocket runtime state", async () => {
    const { id } = await importBranch();
    const output = await app.sessionBridge.exportPi(owner(app), id);
    const entries = output.jsonl
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as FileEntry);
    const manager = SessionManager.inMemory(work, undefined, entries);
    const restored = manager.buildSessionContext();

    assert.equal(manager.getCwd(), work);
    assert.equal(restored.model?.modelId, "faux-vision");
    assert.match(JSON.stringify(restored.messages), /branch B edited/);
    assert.match(JSON.stringify(restored.messages), /aW1hZ2U=/);
    assert.doesNotMatch(JSON.stringify(restored.messages), /dangerous.extension|old prompt/);
    assert.ok(
        manager
            .getEntries()
            .some((entry) => entry.type === "custom" && entry.customType === "pocket.handoff"),
    );
    const original = await (await app.conversation(id)).context(context);

    assert.deepEqual(
        restored.messages,
        original.messages.filter((message) => message.role !== "system"),
    );
});

test("exports respect reset boundaries and histories inherited by forks", async () => {
    const id = await newSession(app);

    await say(app, id, "before reset");
    await (
        await app.conversation(id)
    ).commit(async (tx) => {
        await tx.appendEntry(ResetEntry, id, {
            head: "self",
            model: [{ role: "user", content: "handoff after reset", timestamp: 1 }],
        });
    }, context);
    await say(app, id, "after reset");
    const conversation = await app.conversation(id);
    const page = await conversation.entries({}, 256, undefined, context);
    const last = page.items.find((entry) => entry.kind === "pi.assistant")!;
    const { id: fork } = await app.commands.fork(id, owner(app), { entryId: Number(last.id) });
    const output = await app.sessionBridge.exportPi(owner(app), fork);

    assert.match(output.jsonl, /after reset/);
    const restored = SessionManager.inMemory(
        work,
        undefined,
        output.jsonl
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as FileEntry),
    );

    assert.doesNotMatch(JSON.stringify(restored.buildSessionContext().messages), /before reset/);
});

test("HTTP routes enforce owner-only discovery, import and source archives, and session visibility for export", async () => {
    const guest = app.config.addUser("Guest", "guest");
    const viewer = app.config.addUser("Viewer", "viewer");
    const { id } = await importBranch();
    const restricted = app.config.addUser("Restricted", "viewer", [String(id)]);
    const other = await newSession(app);

    for (const token of [guest.token, viewer.token, restricted.token]) {
        assert.equal((await request("pi-sessions", undefined, token)).status, 403);
        assert.equal(
            (await request(`pi-sessions/preview?source=${source}`, undefined, token)).status,
            403,
        );
        assert.equal((await request("pi-sessions/import", {}, token)).status, 403);
        assert.equal((await request(`c/${id}/source-pi`, undefined, token)).status, 403);
    }

    assert.equal((await request("pi-sessions")).status, 200);
    assert.equal((await request(`pi-sessions/preview?source=${source}`)).status, 200);
    assert.equal((await request(`c/${id}/export-pi`, undefined, restricted.token)).status, 200);
    assert.equal((await request(`c/${other}/export-pi`, undefined, restricted.token)).status, 404);
    const exported = await request(`c/${id}/export-pi`);

    assert.match(exported.headers.get("content-disposition") ?? "", /\.jsonl/);
    assert.equal((await request(`c/${other}/source-pi`)).status, 404);
    assert.equal(
        (await app.harness.snapshot(SessionSourceDoc, id, context))?.leafId,
        fixture.branchB,
    );
});

test("legacy Pi sessions are migrated only in memory", async () => {
    const file = join(sessionsDir, "legacy.jsonl");
    const legacySource = Buffer.from("--project--/legacy.jsonl").toString("base64url");
    const jsonl = [
        {
            type: "session",
            version: 1,
            id: "legacy-session",
            cwd: work,
            timestamp: new Date().toISOString(),
        },
        {
            type: "message",
            timestamp: new Date().toISOString(),
            message: { role: "user", content: "legacy question", timestamp: 1 },
        },
        {
            type: "message",
            timestamp: new Date().toISOString(),
            message: fauxAssistantMessage([fauxText("legacy reply")]),
        },
    ]
        .map((entry) => JSON.stringify(entry))
        .join("\n");

    writeFileSync(file, jsonl);
    const mtime = statSync(file).mtimeMs;
    const selected = await app.sessionBridge.preview(owner(app), legacySource);

    assert.match(JSON.stringify(selected.entries), /legacy question/);
    assert.equal(selected.contextMessages, 2);
    assert.equal(
        (await app.sessionBridge.preview(owner(app), legacySource)).leafId,
        selected.leafId,
        "legacy branch IDs stay stable across reads",
    );
    const input = {
        source: legacySource,
        snapshot: selected.snapshot,
        leafId: selected.leafId!,
        cwd: work,
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    };
    const imported = await app.sessionBridge.import(owner(app), input);

    assert.equal((await app.sessionBridge.import(owner(app), input)).id, imported.id);
    assert.match((await modelTexts(app, imported.id)).join("\n"), /legacy reply/);
    assert.equal(readFileSync(file, "utf8"), jsonl);
    assert.equal(statSync(file).mtimeMs, mtime);
});

test("a custom session directory can be browsed without accepting symlinked projects", async () => {
    const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
    const directory = join(root, "custom-sessions");

    mkdirSync(directory);
    writeFileSync(join(directory, "flat.jsonl"), readFileSync(sourceFile));
    symlinkSync(sessionsDir, join(directory, "linked-project"));
    process.env.PI_CODING_AGENT_SESSION_DIR = directory;

    try {
        const listing = await app.sessionBridge.list(owner(app));

        assert.equal(listing.sessions.length, 1);
        assert.equal(listing.root, directory);
        assert.equal(
            (await app.sessionBridge.preview(owner(app), listing.sessions[0]!.source))
                .contextMessages,
            6,
        );
        await assert.rejects(
            app.sessionBridge.preview(
                owner(app),
                Buffer.from("linked-project/history.jsonl").toString("base64url"),
            ),
            /regular file/,
        );
    } finally {
        if (previous === undefined) {
            delete process.env.PI_CODING_AGENT_SESSION_DIR;
        } else {
            process.env.PI_CODING_AGENT_SESSION_DIR = previous;
        }
    }
});

test("model, image support, thinking and directory validation leave no partial sessions", async () => {
    const selected = await preview();
    const count = app.sessions().length;
    const valid = {
        source,
        snapshot: selected.snapshot,
        leafId: selected.leafId!,
        cwd: work,
        model: { provider: "faux", modelId: "faux-vision" },
        thinkingLevel: "off",
    };

    const available = app.models.getAvailableSnapshot;

    app.models.getAvailableSnapshot = () =>
        available
            .call(app.models)
            .map((model) =>
                model.id === "faux-1" ? { ...model, input: ["text" as const] } : model,
            );

    try {
        await assert.rejects(
            app.sessionBridge.import(owner(app), {
                ...valid,
                model: { provider: "faux", modelId: "faux-1" },
            }),
            /contains images/,
        );
    } finally {
        app.models.getAvailableSnapshot = available;
    }

    await assert.rejects(
        app.sessionBridge.import(owner(app), {
            ...valid,
            model: { provider: "missing", modelId: "unknown" },
        }),
        /available model/,
    );
    await assert.rejects(
        app.sessionBridge.import(owner(app), { ...valid, thinkingLevel: "not-a-level" }),
        /thinking level/,
    );
    await assert.rejects(
        app.sessionBridge.import(owner(app), { ...valid, cwd: join(root, "missing") }),
        /not a directory/,
    );
    await assert.rejects(
        app.sessionBridge.preview(owner(app), source, "missing-leaf"),
        /No such branch/,
    );
    assert.equal(app.sessions().length, count);
});

test("oversized and excessive-entry source files are refused before import", async () => {
    const file = join(sessionsDir, "oversized.jsonl");
    const oversizedSource = Buffer.from("--project--/oversized.jsonl").toString("base64url");
    const count = app.sessions().length;

    writeFileSync(file, Buffer.alloc(20 * 1024 * 1024 + 1));
    await assert.rejects(app.sessionBridge.preview(owner(app), oversizedSource), /20 MiB/);
    const entries = [
        fixture.entries[0],
        ...Array.from({ length: 10_001 }, (_, index) => ({
            type: "message",
            id: String(index),
            parentId: index === 0 ? null : String(index - 1),
            timestamp: new Date().toISOString(),
            message: { role: "user", content: "large history", timestamp: index },
        })),
    ];

    writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n"));
    await assert.rejects(app.sessionBridge.preview(owner(app), oversizedSource), /malformed/);
    assert.equal(app.sessions().length, count);
});

test("complete tool results survive; orphan, incomplete and failed turns cannot become runnable work", () => {
    const assistant = fauxAssistantMessage(
        [
            fauxToolCall("read", { path: "old.txt" }, { id: "call-1" }),
            fauxToolCall("bash", { command: "old-command" }, { id: "call-2" }),
        ],
        { stopReason: "toolUse" },
    );
    const result: Message = {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "historical output" }, image],
        isError: false,
        timestamp: 1,
    };
    const orphan: Message = { ...result, toolCallId: "orphan" };
    const warnings: string[] = [];
    const messages = handoffMessages(
        [
            assistant,
            result,
            orphan,
            { role: "user", content: "next turn", timestamp: 2 },
            fauxAssistantMessage([fauxText("failed")], { stopReason: "error" }),
        ],
        warnings,
    );

    assert.deepEqual(messages[1], result);
    assert.match(JSON.stringify(messages[2]), /not executed/);
    assert.equal(messages.length, 4);
    assert.ok(warnings.some((warning) => warning.includes("Orphan")));
    assert.ok(warnings.some((warning) => warning.includes("error assistant")));
    assert.throws(() => handoffMessages([assistant, assistant], []), /duplicate tool call/);
    assert.throws(
        () => handoffMessages([assistant, { ...result, toolName: "wrong-name" }], []),
        /does not match/,
    );
    assert.throws(
        () =>
            handoffMessages(
                [{ role: "user", content: [{}], timestamp: 1 } as unknown as Message],
                [],
            ),
        /malformed messages/,
    );
});

test("imports and their source archives survive a restart without duplicate sessions", async () => {
    const model = scriptedModel();
    const data = join(root, "bridge-restart");
    let local = await openApp(model, data);
    const selected = await local.sessionBridge.preview(owner(local), source, fixture.branchA);
    const input = {
        source,
        snapshot: selected.snapshot,
        leafId: fixture.branchA,
        cwd: work,
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    };

    try {
        const imported = await local.sessionBridge.import(owner(local), input);

        await local.close();
        local = await openApp(model, data);
        const retried = await local.sessionBridge.import(owner(local), input);

        assert.equal(retried.id, imported.id);
        assert.equal(retried.existing, true);
        assert.equal(local.sessions().length, 1);
        assert.match(
            await local.sessionBridge.sourceArchive(owner(local), retried.id),
            /branch A only/,
        );
        assert.match((await modelTexts(local, retried.id)).join("\n"), /A answer/);
    } finally {
        await local.close();
    }
});

test("HTTP import accepts a confirmed snapshot, requires X-Pocket and does not expose the source to viewers", async () => {
    const selected = await preview(fixture.branchA);
    const input = {
        source,
        snapshot: selected.snapshot,
        leafId: fixture.branchA,
        cwd: work,
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    };
    const response = await request("pi-sessions/import", input);

    assert.equal(response.status, 200);
    const imported = (await response.json()) as { id: number };

    assert.equal(
        (
            await fetch(`${base}/api/pi-sessions/import`, {
                method: "POST",
                headers: { authorization: headers().authorization },
                body: JSON.stringify(input),
            })
        ).status,
        403,
    );
    assert.equal((await fetch(`${base}/api/pi-sessions`)).status, 401);
    const viewer = app.config.addUser("Handoff viewer", "viewer", [String(imported.id)]);
    const info = (await (
        await request(`c/${imported.id}/export-pi?preview=1`, undefined, viewer.token)
    ).json()) as { sourceAvailable: boolean; jsonl?: unknown };

    assert.equal(info.sourceAvailable, false);
    assert.equal(info.jsonl, undefined);
});

test(
    "the import and handoff sheets work on desktop and phone without console errors",
    {
        skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
    },
    async () => {
        const browsers = new Browsers({ dataDir: join(root, "bridge-browser") });

        try {
            const page = await browsers.open(1);
            const wait = async (expression: string, what: string) =>
                until(
                    async () =>
                        JSON.parse(
                            await page.evaluate(`return JSON.stringify(Boolean(${expression}))`),
                        ) === true,
                    what,
                    20_000,
                );

            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await wait(
                '(await import("/store.js")).store.state.me?.role === "owner"',
                "owner sign-in",
            );

            for (const width of [1280, 390]) {
                await page.setViewport({ width, height: 900, scale: 1, mobile: width < 600 });
                await page.evaluate('(await import("/store.js")).openSheet({ type: "import-pi" })');
                await wait(
                    'document.querySelector("[aria-label=\\"Search Pi sessions\\"]")',
                    "session picker",
                );
                await wait(
                    '[...document.querySelectorAll(".sheet button")].some(button => button.textContent.includes("Old Pi work"))',
                    "Pi session list",
                );
                await page.evaluate(
                    '[...document.querySelectorAll(".sheet button")].find(button => button.textContent.includes("Old Pi work")).click()',
                );
                await wait(
                    'document.querySelector("[aria-label=\\"Pi branch\\"]")?.options.length === 2',
                    "branch selector",
                );
                await page.evaluate(`
                const branches = document.querySelector('[aria-label="Pi branch"]');
                branches.value = ${JSON.stringify(fixture.branchA)};
                branches.dispatchEvent(new Event("change", { bubbles: true }));
            `);
                await wait(
                    'document.querySelector(".sheet textarea")?.value.includes("branch A only")',
                    "selected branch preview",
                );
                await page.evaluate(`
                const model = document.querySelector('[aria-label="Import model"]');
                model.value = "faux/faux-vision";
                model.dispatchEvent(new Event("change", { bubbles: true }));
            `);
                await page.evaluate(
                    '[...document.querySelectorAll(".sheet button")].find(button => button.textContent.trim() === "Continue in Pocket").click()',
                );
                await wait(
                    '!(await import("/store.js")).store.state.sheet && (await import("/store.js")).store.state.view.conversation?.title?.includes("imported")',
                    "imported conversation",
                );
                await page.evaluate('(await import("/store.js")).openSheet({ type: "export-pi" })');
                await wait(
                    'document.querySelector(".sheet a[download]")',
                    "terminal handoff download",
                );
                assert.match(
                    await page.evaluate('return document.querySelector(".sheet pre").textContent'),
                    /pi --session/,
                );
                assert.equal(
                    JSON.parse(
                        await page.evaluate(
                            'return JSON.stringify(document.querySelectorAll(".sheet a[download]").length)',
                        ),
                    ),
                    2,
                    "owner also gets source archive",
                );
                assert.equal(
                    JSON.parse(
                        await page.evaluate(
                            'return JSON.stringify(document.querySelector(".sheet").scrollWidth > document.querySelector(".sheet").clientWidth)',
                        ),
                    ),
                    false,
                    "sheet fits the viewport",
                );
                await page.evaluate('(await import("/store.js")).closeSheet()');
                await new Promise((resolve) => setTimeout(resolve, 250));
            }

            assert.deepEqual(
                page.logs().filter((entry) => entry.level === "error"),
                [],
            );
        } catch (error) {
            console.error(error);
            const page = browsers.page(1);

            if (page) {
                console.error(await page.evaluate("return document.body.innerText"));
                console.error(page.logs());
            }

            throw error;
        } finally {
            await browsers.closeAll({ final: true });
        }
    },
);
