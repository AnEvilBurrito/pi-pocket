// Browse read-only local Pi history, then continue an independent copy in Pocket or export one back to Pi.
import { useEffect, useState } from "preact/hooks";
import { api, closeSheet, navigate, notify, openSheet, store } from "../store.js";
import { html, Sheet, shortPath, timeAgo } from "../ui.js";

function Warnings({ warnings }) {
    return html`<div class="group" role="note">
        <div class="group-title">Handoff notes</div>
        <ul>${warnings.map((warning) => html`<li>${warning}</li>`)}</ul>
    </div>`;
}

export function PiImportSheet() {
    const { models, server } = store.state;
    const [listing, setListing] = useState(null);
    const [query, setQuery] = useState("");
    const [target, setTarget] = useState(null);
    const [preview, setPreview] = useState(null);
    const [cwd, setCwd] = useState("");
    const [modelKey, setModelKey] = useState("");
    const [thinking, setThinking] = useState("off");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [refresh, setRefresh] = useState(0);

    useEffect(() => {
        let current = true;

        setListing(null);
        setError("");
        api("pi-sessions").then(
            (result) => current && setListing(result),
            (error) => current && setError(error.message),
        );

        return () => {
            current = false;
        };
    }, [refresh]);

    useEffect(() => {
        let current = true;

        setPreview(null);
        setError("");

        if (target) {
            const parameters = new URLSearchParams({ source: target.source });

            if (target.leafId) {
                parameters.set("leafId", target.leafId);
            }

            api(`pi-sessions/preview?${parameters}`).then(
                (result) => {
                    if (!current) {
                        return;
                    }

                    setPreview(result);
                    setCwd(result.cwd || server?.defaultCwd || "~");
                    const preferred =
                        models.find(
                            (model) =>
                                model.provider === result.model?.provider &&
                                model.id === result.model?.modelId,
                        ) ?? models[0];

                    setModelKey(preferred ? `${preferred.provider}/${preferred.id}` : "");
                    setThinking(
                        preferred?.levels.includes(result.thinkingLevel)
                            ? result.thinkingLevel
                            : "off",
                    );
                },
                (error) => current && setError(error.message),
            );
        }

        return () => {
            current = false;
        };
    }, [target]);

    const model = models.find((model) => `${model.provider}/${model.id}` === modelKey);
    const levels = model?.levels ?? ["off"];
    const needle = query.toLowerCase().trim();
    const groups = new Map();

    for (const session of listing?.sessions ?? []) {
        if (needle && !`${session.name} ${session.cwd}`.toLowerCase().includes(needle)) {
            continue;
        }

        const group = groups.get(session.cwd) ?? [];

        group.push(session);
        groups.set(session.cwd, group);
    }

    const proceed = async () => {
        if (busy || !preview || !model) {
            return;
        }

        setBusy(true);
        setError("");

        try {
            const created = await api("pi-sessions/import", {
                source: preview.source,
                snapshot: preview.snapshot,
                leafId: preview.leafId,
                cwd,
                model: { provider: model.provider, modelId: model.id },
                thinkingLevel: thinking,
            });

            closeSheet();
            navigate(created.id);
            notify(
                "info",
                created.existing
                    ? "Opened the existing imported copy."
                    : "Imported. Send a new message to continue; no old tools were run.",
            );
        } catch (error) {
            setError(error.message);
        } finally {
            setBusy(false);
        }
    };

    return html`<${Sheet} title="Import from Pi" onClose=${closeSheet}>
        ${error && html`<p role="alert">${error}</p>`}
        ${
            !target
                ? html`<p class="muted">Browse Pi sessions on this server. Originals stay untouched.</p>
                    <div class="row">
                        <input
                            aria-label="Search Pi sessions"
                            placeholder="Search names or projects"
                            value=${query}
                            onInput=${(event) => setQuery(event.currentTarget.value)}
                        />
                        <button class="button" onClick=${() => setRefresh(refresh + 1)}>Refresh</button>
                    </div>
                    ${!listing && !error && html`<p class="muted" role="status">Loading Pi sessions…</p>`}
                    ${
                        listing &&
                        html`<p class="muted small mono">
                        ${shortPath(listing.root, server?.home)}
                    </p>`
                    }
                    ${listing?.warnings.length > 0 && html`<${Warnings} warnings=${listing.warnings} />`}
                    ${listing && groups.size === 0 && html`<p class="muted">No matching Pi sessions.</p>`}
                    ${[...groups].map(
                        ([folder, sessions]) => html`<div class="group">
                            <div class="group-title mono">
                                ${shortPath(folder, server?.home) || "Unknown project"}
                            </div>
                            ${sessions.map(
                                (session) => html`<button
                                    class="list-item"
                                    onClick=${() => setTarget({ source: session.source })}
                                >
                                    <span>${session.name}</span>
                                    <span class="muted small">
                                        ${session.messageCount} messages · ${timeAgo(session.modified)}
                                    </span>
                                </button>`,
                            )}
                        </div>`,
                    )} `
                : html`<div class="row">
                    <button
                        class="button"
                        disabled=${busy}
                        onClick=${() => setTarget(null)}
                    >
                        Back
                    </button>
                    <button
                        class="button"
                        disabled=${busy}
                        onClick=${() => setTarget({ ...target })}
                    >
                        Refresh preview
                    </button>
                </div>
                ${!preview && !error && html`<p class="muted" role="status">Loading branch…</p>`}
                ${
                    preview &&
                    html`<div class="group">
                        <div class="group-title">${preview.name}</div>
                        <label class="field">
                            Branch
                            <select
                                aria-label="Pi branch"
                                value=${preview.leafId}
                                disabled=${busy}
                                onChange=${(event) =>
                                    setTarget({
                                        source: target.source,
                                        leafId: event.currentTarget.value,
                                    })}
                            >
                                ${preview.branches.map(
                                    (branch) => html`<option value=${branch.id}>
                                    ${branch.label}
                                </option>`,
                                )}
                            </select>
                        </label>
                        <p class="muted small">
                            ${`Last ${preview.entries.length} of ${preview.totalEntries} source entries; ${preview.contextMessages} resolved context messages will transfer.`}
                        </p>
                        <label class="field">
                            Original branch preview (before context edits)
                            <textarea
                                class="mono"
                                rows="12"
                                readonly
                                value=${preview.entries
                                    .map((entry) => `[${entry.kind}] ${entry.text}`)
                                    .join("\n\n")}
                            />
                        </label>
                        <${Warnings} warnings=${preview.warnings} />
                        <p class="muted">
                            Only resolved context transfers. The selected branch is also kept as an owner-only source archive. The new Pocket conversation follows the usual sharing rules.
                        </p>
                        <label class="field">
                            Working directory
                            <input
                                class="mono"
                                aria-label="Import working directory"
                                value=${cwd}
                                disabled=${busy}
                                onInput=${(event) => setCwd(event.currentTarget.value)}
                            />
                        </label>
                        <label class="field">
                            Destination model
                            <select
                                aria-label="Import model"
                                value=${modelKey}
                                disabled=${busy}
                                onChange=${(event) => {
                                    setModelKey(event.currentTarget.value);
                                    setThinking("off");
                                }}
                            >
                                ${
                                    models.length === 0 &&
                                    html`<option value="">
                                    No available models
                                </option>`
                                }
                                ${models.map(
                                    (model) => html`<option
                                    value=${`${model.provider}/${model.id}`}
                                >
                                    ${model.name} (${model.provider})
                                </option>`,
                                )}
                            </select>
                        </label>
                        <label class="field">
                            Thinking level
                            <select
                                aria-label="Import thinking level"
                                value=${thinking}
                                disabled=${busy}
                                onChange=${(event) => setThinking(event.currentTarget.value)}
                            >
                                ${levels.map((level) => html`<option value=${level}>${level}</option>`)}
                            </select>
                        </label>
                        ${
                            models.length === 0 &&
                            html`<button
                            class="button"
                            onClick=${() => openSheet({ type: "providers" })}
                        >
                            Add a provider first
                        </button>`
                        }
                        <button
                            class="button primary wide"
                            disabled=${busy || !model || preview.contextMessages === 0}
                            onClick=${proceed}
                        >
                            ${busy ? "Importing…" : "Continue in Pocket"}
                        </button>
                    </div>`
                }`
        }
    <//>`;
}

export function PiExportSheet() {
    const [id] = useState(store.state.view.conversation?.id);
    const [info, setInfo] = useState(null);
    const [error, setError] = useState("");

    useEffect(() => {
        let current = true;

        api(`c/${id}/export-pi?preview=1`).then(
            (result) => current && setInfo(result),
            (error) => current && setError(error.message),
        );

        return () => {
            current = false;
        };
    }, [id]);

    return html`<${Sheet} title="Continue in terminal Pi" onClose=${closeSheet}>
        ${error && html`<p role="alert">${error}</p>`}
        ${!info && !error && html`<p class="muted" role="status">Preparing handoff…</p>`}
        ${
            info &&
            html`<p>
                Download a Pi-compatible session containing the current resolved context, then open it in terminal Pi:
            </p>
            <pre class="mono">${`pi --session "./${info.filename}"`}</pre>
            <p class="muted">
                Run this where you saved the file. Both conversations remain independent; use Markdown export for the whole Pocket history.
            </p>
            <${Warnings} warnings=${info.warnings} />
            <a
                class="button primary wide"
                href=${`/api/c/${id}/export-pi`}
                download
            >
                Download Pi session
            </a>
            ${
                info.sourceAvailable &&
                html`<div class="group">
                    <div class="group-title">Original Pi source</div>
                    <p class="muted">
                        The imported branch before conversion, including old prompt and extension data. Archive only; not the recommended handoff.
                    </p>
                    <a class="button" href=${`/api/c/${id}/source-pi`} download>
                        Download source archive
                    </a>
                </div>`
            }`
        }
    <//>`;
}
