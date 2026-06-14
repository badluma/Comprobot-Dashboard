import index from "./index.html";
import appDirs from "appdirsjs";
import { parse, stringify } from "smol-toml";
import { join } from "path";
import type { ServerWebSocket } from "bun";

const dataDir =
    process.env.COMPROBOT_DATA_DIR || appDirs({ appName: "Comprobot" }).data;
const botDir = join(import.meta.dir, "..");

const ALLOWED = new Set([
    "active.toml",
    "config.toml",
    "ai.toml",
    "keywords.toml",
    "descriptions.toml",
    "output.toml",
    "moderation.toml",
    "error-messages.toml",
    ".env",
]);

// --- Env helpers ---
function parseEnv(text: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const idx = trimmed.indexOf("=");
        if (idx === -1) continue;
        result[trimmed.slice(0, idx)] = trimmed
            .slice(idx + 1)
            .replace(/^['"]|['"]$/g, "");
    }
    return result;
}

function stringifyEnv(data: Record<string, string>): string {
    return (
        Object.entries(data)
            .map(([k, v]) => `${k}=${v}`)
            .join("\n") + "\n"
    );
}

function toJson(data: unknown): Response {
    const json = JSON.stringify(data, (_k, v) => {
        if (typeof v === "bigint")
            return v <= BigInt(Number.MAX_SAFE_INTEGER)
                ? Number(v)
                : v.toString();
        return v;
    });
    return new Response(json, {
        headers: { "Content-Type": "application/json" },
    });
}

function coerceArrayItem(item: string): string | number | bigint {
    const s = item.trim();
    if (/^\d{16,}$/.test(s)) {
        try {
            return BigInt(s);
        } catch {
            /* fall through */
        }
    }
    const n = Number(s);
    if (!isNaN(n) && s !== "") return n;
    return s;
}

// --- Bot process management ---
let botProc: ReturnType<typeof Bun.spawn> | null = null;
let botStartTime: number | null = null;
const logBuffer: string[] = [];
const MAX_LOGS = 5000;
const wsClients = new Set<ServerWebSocket<unknown>>();

const logStats = {
    totalLines: 0,
    errorLines: 0,
    perMinute: [] as {
        t: number;
        count: number;
        errors: number;
        commands: number;
        deleted: number;
        timeouts: number;
        kicks: number;
        bans: number;
        messages: number;
    }[],
};

let lineBuffer = "";

function broadcast(msg: unknown) {
    const json = JSON.stringify(msg);
    for (const ws of wsClients) {
        try {
            ws.send(json);
        } catch {
            /* client disconnected */
        }
    }
}

function appendLog(text: string) {
    lineBuffer += text;
    const parts = lineBuffer.split("\n");
    lineBuffer = parts.pop() ?? "";

    for (const line of parts) {
        logBuffer.push(line);
        if (logBuffer.length > MAX_LOGS) logBuffer.shift();

        logStats.totalLines++;
        const isMessage = line.startsWith("\x1b[90m");
        const stripped = line.replace(/\x1b\[[^m]*m/g, "").toLowerCase();
        const isError =
            stripped.includes("error") ||
            stripped.includes("exception") ||
            stripped.includes("traceback");
        const isCommand = /\b(command|invoked|cmd)\b/.test(stripped);
        const isDeleted = /\b(deleted message|message deleted)\b/.test(
            stripped,
        );
        const isTimeout = /\b(timed out|muted)\b/.test(stripped);
        const isKick = /\bkicked\b/.test(stripped);
        const isBan = /\bbanned\b/.test(stripped);
        if (isError) logStats.errorLines++;

        const bucket = Math.floor(Date.now() / 60000);
        const last = logStats.perMinute[logStats.perMinute.length - 1];
        if (last && last.t === bucket) {
            last.count++;
            if (isError) last.errors++;
            if (isCommand) last.commands++;
            if (isDeleted) last.deleted++;
            if (isTimeout) last.timeouts++;
            if (isKick) last.kicks++;
            if (isBan) last.bans++;
            if (isMessage) last.messages++;
        } else {
            logStats.perMinute.push({
                t: bucket,
                count: 1,
                errors: isError ? 1 : 0,
                commands: isCommand ? 1 : 0,
                deleted: isDeleted ? 1 : 0,
                timeouts: isTimeout ? 1 : 0,
                kicks: isKick ? 1 : 0,
                bans: isBan ? 1 : 0,
                messages: isMessage ? 1 : 0,
            });
            // Keep ~25h of per-minute buckets so the 24h stats view has full history
            if (logStats.perMinute.length > 1500) logStats.perMinute.shift();
        }

        broadcast({ type: "log", data: line });
    }
}

async function pipeToLogs(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) appendLog(dec.decode(value));
        }
    } catch {
        /* stream closed */
    }
}

async function startBotProcess(): Promise<{ ok: boolean; error?: string }> {
    // Kill existing process if running
    if (botProc) {
        try {
            botProc.kill();
        } catch {
            /* ignore */
        }
        try {
            await botProc.exited;
        } catch {
            /* ignore */
        }
        botProc = null;
    }

    try {
        const proc = Bun.spawn(["comprobot", "start"], {
            cwd: botDir,
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, PYTHONUNBUFFERED: "1" },
        });

        botProc = proc;
        botStartTime = Date.now();

        appendLog("\x1b[32m[Dashboard] Bot process started\x1b[0m\n");

        pipeToLogs(proc.stdout as ReadableStream<Uint8Array>).catch(() => {});
        pipeToLogs(proc.stderr as ReadableStream<Uint8Array>).catch(() => {});

        proc.exited
            .then((code) => {
                if (botProc === proc) {
                    botProc = null;
                    botStartTime = null;
                }
                appendLog(
                    `\x1b[33m[Dashboard] Bot exited with code ${code}\x1b[0m\n`,
                );
                broadcast({ type: "status", running: false });
            })
            .catch(() => {});

        broadcast({ type: "status", running: true });
        return { ok: true };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}

function stopBotProcess(): { ok: boolean; error?: string } {
    if (!botProc) return { ok: false, error: "Bot is not running" };
    try {
        botProc.kill();
        return { ok: true };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}

// --- Discord API ---
async function getBotToken(): Promise<string | null> {
    try {
        const text = await Bun.file(join(dataDir, ".env")).text();
        return parseEnv(text)["BOT_TOKEN"] || null;
    } catch {
        return null;
    }
}

async function discordFetch(path: string): Promise<Response> {
    const token = await getBotToken();
    if (!token) {
        return new Response(
            JSON.stringify({ error: "BOT_TOKEN not configured in .env" }),
            {
                status: 401,
                headers: { "Content-Type": "application/json" },
            },
        );
    }
    return fetch(`https://discord.com/api/v10${path}`, {
        headers: { Authorization: `Bot ${token}` },
    });
}

async function discordPatch(path: string, body: unknown): Promise<Response> {
    const token = await getBotToken();
    if (!token) {
        return new Response(
            JSON.stringify({ error: "BOT_TOKEN not configured in .env" }),
            {
                status: 401,
                headers: { "Content-Type": "application/json" },
            },
        );
    }
    return fetch(`https://discord.com/api/v10${path}`, {
        method: "PATCH",
        headers: {
            Authorization: `Bot ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
}

// --- Server ---
Bun.serve({
    routes: {
        // Config API (existing)
        "/api/config/:file": async (req) => {
            const file = decodeURIComponent(req.params.file);
            if (!ALLOWED.has(file))
                return new Response("Not found", { status: 404 });
            const path = join(dataDir, file);

            if (req.method === "GET") {
                try {
                    if (file === ".env")
                        return toJson(parseEnv(await Bun.file(path).text()));
                    return toJson(
                        parse(await Bun.file(path).text(), {
                            integersAsBigInt: true,
                        }),
                    );
                } catch (e) {
                    return Response.json({ error: String(e) }, { status: 500 });
                }
            }

            if (req.method === "PATCH") {
                try {
                    const { section, key, value } = (await req.json()) as {
                        section?: string;
                        key: string;
                        value: unknown;
                    };

                    if (file === ".env") {
                        const data = parseEnv(await Bun.file(path).text());
                        data[key] = String(value);
                        await Bun.write(path, stringifyEnv(data));
                        return Response.json({ ok: true });
                    }

                    const data = parse(await Bun.file(path).text(), {
                        integersAsBigInt: true,
                    }) as Record<string, unknown>;
                    const coerced = Array.isArray(value)
                        ? (value as string[]).map(coerceArrayItem)
                        : value;

                    if (section) {
                        const sec = data[section] as
                            | Record<string, unknown>
                            | undefined;
                        if (!sec)
                            return new Response("Section not found", {
                                status: 400,
                            });
                        sec[key] = coerced;
                    } else {
                        data[key] = coerced;
                    }

                    await Bun.write(path, stringify(data));
                    return Response.json({ ok: true });
                } catch (e) {
                    return Response.json({ error: String(e) }, { status: 500 });
                }
            }

            return new Response("Method Not Allowed", { status: 405 });
        },

        // Bot status
        "/api/bot/status": () =>
            Response.json({
                running: !!botProc,
                uptime: botStartTime ? Date.now() - botStartTime : null,
                logs: logStats.totalLines,
                errors: logStats.errorLines,
                perMinute: logStats.perMinute,
            }),

        // Bot control
        "/api/bot/start": async (req) => {
            if (req.method !== "POST")
                return new Response("Method Not Allowed", { status: 405 });
            return Response.json(await startBotProcess());
        },

        "/api/bot/stop": async (req) => {
            if (req.method !== "POST")
                return new Response("Method Not Allowed", { status: 405 });
            return Response.json(stopBotProcess());
        },

        // Discord profile
        "/api/discord/me": async () => {
            try {
                const res = await discordFetch("/users/@me");
                const data = await res.json();
                return Response.json(data, { status: res.status });
            } catch (e) {
                return Response.json({ error: String(e) }, { status: 500 });
            }
        },

        // Discord guilds
        "/api/discord/guilds": async () => {
            try {
                const res = await discordFetch("/users/@me/guilds");
                const data = await res.json();
                return Response.json(data, { status: res.status });
            } catch (e) {
                return Response.json({ error: String(e) }, { status: 500 });
            }
        },

        // Discord avatar/banner update
        "/api/discord/avatar": async (req) => {
            if (req.method !== "POST")
                return new Response("Method Not Allowed", { status: 405 });
            try {
                const { data } = (await req.json()) as { data: string };
                const res = await discordPatch("/users/@me", { avatar: data });
                return Response.json(await res.json(), { status: res.status });
            } catch (e) {
                return Response.json({ error: String(e) }, { status: 500 });
            }
        },

        // Discord bot username update
        "/api/discord/name": async (req) => {
            if (req.method !== "POST")
                return new Response("Method Not Allowed", { status: 405 });
            try {
                const { username } = (await req.json()) as { username: string };
                const res = await discordPatch("/users/@me", { username });
                return Response.json(await res.json(), { status: res.status });
            } catch (e) {
                return Response.json({ error: String(e) }, { status: 500 });
            }
        },

        "/api/discord/banner": async (req) => {
            if (req.method !== "POST")
                return new Response("Method Not Allowed", { status: 405 });
            try {
                const { data } = (await req.json()) as { data: string };
                const res = await discordPatch("/users/@me", { banner: data });
                return Response.json(await res.json(), { status: res.status });
            } catch (e) {
                return Response.json({ error: String(e) }, { status: 500 });
            }
        },

        // Log history
        "/api/bot/logs": () => Response.json({ logs: logBuffer.slice(-500) }),

        // WebSocket upgrade
        "/api/ws": (req, server) => {
            if (server.upgrade(req)) return;
            return new Response("WebSocket upgrade failed", { status: 400 });
        },

        "/*": index,
    },

    websocket: {
        open(ws) {
            wsClients.add(ws);
            ws.send(
                JSON.stringify({
                    type: "history",
                    data: logBuffer.slice(-500),
                    status: {
                        running: !!botProc,
                        uptime: botStartTime ? Date.now() - botStartTime : null,
                    },
                }),
            );
        },
        message(_ws, _msg) {
            /* reserved */
        },
        close(ws) {
            wsClients.delete(ws);
        },
    },

    hostname: "0.0.0.0",
    port: parseInt(process.env.PORT || "7626"),
});
