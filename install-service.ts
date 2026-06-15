#!/usr/bin/env bun
import { join } from "path";
import { homedir, platform } from "os";
import appDirs from "appdirsjs";

async function readDashboardPort(): Promise<string> {
    const dataDir = appDirs({ appName: "Comprobot" }).data;
    try {
        const text = await Bun.file(join(dataDir, ".env")).text();
        for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.startsWith("DASHBOARD_PORT=")) {
                const val = trimmed.slice("DASHBOARD_PORT=".length).trim();
                if (val) return val;
            }
        }
    } catch { /* .env not found or unreadable */ }
    return "7626";
}

const PORT = await readDashboardPort();
const bun = process.execPath;
const dir = import.meta.dir;

async function mac() {
    const plistPath = join(homedir(), "Library/LaunchAgents/com.comprobot.dashboard.plist");
    await Bun.write(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.comprobot.dashboard</string>
    <key>ProgramArguments</key>
    <array>
        <string>${bun}</string>
        <string>index.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${dir}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>${PORT}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/comprobot-dashboard.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/comprobot-dashboard.error.log</string>
</dict>
</plist>`);
    await Bun.$`launchctl unload ${plistPath}`.nothrow().quiet();
    await Bun.$`launchctl load ${plistPath}`;
    console.log(`Installed launchd service. Dashboard at http://localhost:${PORT}`);
}

async function linux() {
    const serviceDir = join(homedir(), ".config/systemd/user");
    const servicePath = join(serviceDir, "comprobot-dashboard.service");
    await Bun.$`mkdir -p ${serviceDir}`;
    await Bun.write(servicePath, `[Unit]
Description=Comprobot Dashboard
After=network.target

[Service]
Type=simple
ExecStart=${bun} index.ts
WorkingDirectory=${dir}
Environment=PORT=${PORT}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target`);
    await Bun.$`systemctl --user daemon-reload`;
    await Bun.$`systemctl --user enable --now comprobot-dashboard`;
    console.log(`Installed systemd user service. Dashboard at http://localhost:${PORT}`);
}

async function windows() {
    const bat = join(dir, "_start-dashboard.bat");
    await Bun.write(bat, `@echo off\ncd /d "${dir}"\nset PORT=${PORT}\n"${bun}" index.ts`);
    const startup = join(
        process.env.APPDATA!,
        "Microsoft\\Windows\\Start Menu\\Programs\\Startup\\comprobot-dashboard.bat"
    );
    await Bun.$`copy /y "${bat}" "${startup}"`;
    await Bun.$`start "" "${bat}"`;
    console.log(`Installed startup entry. Dashboard at http://localhost:${PORT}`);
}

const os = platform();
if (os === "darwin") await mac();
else if (os === "linux") await linux();
else if (os === "win32") await windows();
else {
    console.error(`Unsupported platform: ${os}`);
    process.exit(1);
}
