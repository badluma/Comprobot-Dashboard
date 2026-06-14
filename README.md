# Comprobot Dashboard

A web dashboard for [Comprobot](https://github.com/badluma/Comprobot) to start/stop the bot, edit config files, update the Discord profile, and monitor live logs and moderation stats.

![](./image.png)

## Requirements

- [Bun](https://bun.sh) v1.0+
- [Comprobot](https://github.com/badluma/Comprobot) installed and configured

## Install Bun

```sh
curl -fsSL https://bun.sh/install | bash
```

Windows:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

## Install

```sh
git clone https://github.com/badluma/Comprobot-Dashboard
cd Comprobot-Dashboard
bun install
```

## Run in background

Installs the dashboard as a system service that starts automatically on login and restarts on crash:

```sh
bun run install-service
```

| Platform | Mechanism |
|----------|-----------|
| macOS | launchd (`~/Library/LaunchAgents/`) |
| Linux | systemd user service (`~/.config/systemd/user/`) |
| Windows | Startup folder |

The dashboard runs at `http://localhost:7626`. To use a different port, set the `PORT` environment variable before running the install script.

## Run manually

```sh
bun start
```

For development with automatic reload on changes:

```sh
bun dev
```

# Disclaimer

This dashboard is entirely made by AI, so there might be bugs or unexpected behavior. If you are a web developer and want to help make a better version, feel free to create a pull request or contact me on [Discord](https://discord.gg/9M2agkVKun)!
