<div align="center">

# 🌿 Canopy

**A lightweight, opinionated Python IDE that gets out of your way.**

[![version](https://forthebadge.com/api/badges/generate?panels=2&primaryLabel=version&secondaryLabel=0.2.0&primaryBGColor=%231A56DB&primaryTextColor=%23FFFFFF&secondaryBGColor=%231040A8&secondaryTextColor=%23FFFFFF&primaryFontSize=12&primaryFontWeight=600&primaryLetterSpacing=2&primaryFontFamily=Roboto&primaryTextTransform=uppercase&secondaryFontSize=12&secondaryFontWeight=900&secondaryLetterSpacing=2&secondaryFontFamily=Montserrat&secondaryTextTransform=uppercase&primaryIcon=git&primaryIconColor=%23FFFFFF&primaryIconSize=16&primaryIconPosition=left)](package.json)
[![electron](https://forthebadge.com/api/badges/generate?panels=2&primaryLabel=electron&secondaryLabel=v41&primaryBGColor=%2347848F&primaryTextColor=%23FFFFFF&secondaryBGColor=%23316070&secondaryTextColor=%23FFFFFF&primaryFontSize=12&primaryFontWeight=600&primaryLetterSpacing=2&primaryFontFamily=Roboto&primaryTextTransform=uppercase&secondaryFontSize=12&secondaryFontWeight=900&secondaryLetterSpacing=2&secondaryFontFamily=Montserrat&secondaryTextTransform=uppercase&primaryIcon=electron&primaryIconColor=%23FFFFFF&primaryIconSize=16&primaryIconPosition=left)](https://www.electronjs.org/)
[![svelte](https://forthebadge.com/api/badges/generate?panels=2&primaryLabel=svelte&secondaryLabel=v5&primaryBGColor=%23FF3E00&primaryTextColor=%23FFFFFF&secondaryBGColor=%23C43000&secondaryTextColor=%23FFFFFF&primaryFontSize=12&primaryFontWeight=600&primaryLetterSpacing=2&primaryFontFamily=Roboto&primaryTextTransform=uppercase&secondaryFontSize=12&secondaryFontWeight=900&secondaryLetterSpacing=2&secondaryFontFamily=Montserrat&secondaryTextTransform=uppercase&primaryIcon=svelte&primaryIconColor=%23FFFFFF&primaryIconSize=16&primaryIconPosition=left)](https://svelte.dev/)
[![python](https://forthebadge.com/api/badges/generate?panels=2&primaryLabel=python&secondaryLabel=first&primaryBGColor=%233776AB&primaryTextColor=%23FFFFFF&secondaryBGColor=%232A5F8A&secondaryTextColor=%23FFFFFF&primaryFontSize=12&primaryFontWeight=600&primaryLetterSpacing=2&primaryFontFamily=Roboto&primaryTextTransform=uppercase&secondaryFontSize=12&secondaryFontWeight=900&secondaryLetterSpacing=2&secondaryFontFamily=Montserrat&secondaryTextTransform=uppercase&primaryIcon=python&primaryIconColor=%23FFFFFF&primaryIconSize=16&primaryIconPosition=left)](https://python.org)
[![uv](https://forthebadge.com/api/badges/generate?panels=2&primaryLabel=astral.sh&secondaryLabel=uv&primaryBGColor=%236B21A8&primaryTextColor=%23FFFFFF&secondaryBGColor=%23B040CC&secondaryTextColor=%23FFFFFF&primaryFontSize=12&primaryFontWeight=600&primaryLetterSpacing=2&primaryFontFamily=Roboto&primaryTextTransform=uppercase&secondaryFontSize=12&secondaryFontWeight=900&secondaryLetterSpacing=2&secondaryFontFamily=Montserrat&secondaryTextTransform=uppercase&primaryIcon=astral&primaryIconColor=%23FFFFFF&primaryIconSize=16&primaryIconPosition=left)](https://github.com/astral-sh/uv)
[![ty](https://forthebadge.com/api/badges/generate?panels=2&primaryLabel=astral.sh&secondaryLabel=ty&primaryBGColor=%23B45309&primaryTextColor=%23FFFFFF&secondaryBGColor=%23F7C948&secondaryTextColor=%23111111&primaryFontSize=12&primaryFontWeight=600&primaryLetterSpacing=2&primaryFontFamily=Roboto&primaryTextTransform=uppercase&secondaryFontSize=12&secondaryFontWeight=900&secondaryLetterSpacing=2&secondaryFontFamily=Montserrat&secondaryTextTransform=uppercase&primaryIcon=astral&primaryIconColor=%23FFFFFF&primaryIconSize=16&primaryIconPosition=left)](https://github.com/astral-sh/ty)

</div>

---

## The Story

I spent years writing Python in VS Code. At first it felt fine — until it didn't.

The extensions marketplace became a graveyard of half-maintained plugins. The IDE started phoning home. Copilot got bolted on everywhere whether I wanted it or not. Pyright was the only real LSP option, baked in so tightly that swapping it out was a fight. And the whole thing kept getting heavier — more telemetry, more nag screens, more things I didn't ask for and couldn't turn off.

I wanted a Python IDE that was **small**, **private**, **fast**, and **honest about what it is**. So I built Canopy.

It's opinionated by design. It won't try to sell you AI features, it won't report your keystrokes anywhere, and it won't bloat itself with an extension ecosystem. It's just a clean, fast editor for people who write Python and want to stay in flow.

---

## What Canopy is

### Lightweight by default

Canopy ships as a single lean binary. There's no extension marketplace, no plugin runtime overhead, no background update daemons. The build pipeline aggressively strips source maps, test files, and type declarations from the bundle. It loads fast and stays fast.

### Zero telemetry. Full stop.

No analytics. No crash reporters phoning home. No event tracking. The only network traffic Canopy generates is the traffic *you* initiate — running your code, fetching packages. The environment variable pipeline is also locked down: only a curated allowlist of safe vars (PATH, HOME, SHELL, PYENV_ROOT, etc.) is forwarded to child processes. Nothing leaks.

### Python first

Canopy was built for one language and it shows. Virtual environment detection is automatic — drop a `.venv` in your project and Canopy picks it up, reads `pyvenv.cfg`, and configures the language server without asking. It watches for new environments appearing mid-session. `pyproject.toml` is a first-class citizen.

### Beautiful, minimal UI

Dark mode. Clean layout. A Zed-inspired syntax theme with purposeful color choices — purples for keywords, greens for strings, cyans for operators, yellows for types. The interface has a file tree, an editor, a terminal, a status bar, and nothing else fighting for your attention.

### Native uv support + ty type checking

Canopy auto-detects [uv](https://github.com/astral-sh/uv) and integrates it natively for environment and dependency management — no configuration needed. For type checking, you can choose between [basedpyright](https://github.com/DetachHead/basedpyright) (battle-tested) and [ty](https://github.com/astral-sh/ty) (Astral's blazing-fast new type checker). Switch between them in one click. Both are supported as first-class LSP adapters with full semantic highlighting, diagnostics, hover types, completions, and go-to-definition.

### AI your way — or not at all

Canopy doesn't bundle Copilot. It doesn't nudge you toward any AI assistant. If you want AI help, you already know where to find it: open the built-in terminal and run [Claude Code](https://claude.ai/code), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [OpenCode](https://github.com/sst/opencode), or whatever you prefer. Your editor and your AI workflow stay decoupled — the way they should be.

---

## Screenshots

<div align="center">

![Canopy Editor](assets/1.png)
*Editor with file tree, integrated terminal, and venv status — clean and nothing else*

![Command Palette](assets/2.png)
*Command palette: find in file, open by name, toggle panels — keyboard-driven*

![Diagnostics Panel](assets/3.png)
*Project-wide diagnostics from ty or basedpyright, all in one place*

</div>

---

## Features

| | |
|---|---|
| Monaco Editor | Full IntelliSense-grade editing experience |
| Dual LSP support | basedpyright or ty, switchable at runtime |
| Integrated terminal | Full PTY, multiple tabs, your login shell |
| Auto venv detection | Finds `.venv`, `venv`, `.env` automatically |
| Native uv support | First-class environment manager integration |
| Session restore | Remembers open tabs and active file per project |
| File watcher | Detects external changes, prompts to reload |
| Zero telemetry | No analytics, no crash reporters, no phone home |

---

## Installation

Grab the latest release for your platform from the [Releases](../../releases) page.

| Platform | Format |
|---|---|
| macOS | `.dmg` |
| Linux | `.AppImage`, `.deb`, `.rpm` |
| Windows | `.exe` (NSIS) |

---

## Coming Soon

**Agentic development features** — deeper integration with AI coding workflows, directly inside the IDE. Designed the right way: opt-in, composable, and without lock-in.

---

## Built with

- [Electron](https://www.electronjs.org/) — desktop runtime
- [Svelte 5 + SvelteKit](https://svelte.dev/) — UI framework
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) — code editing engine
- [xterm.js](https://xtermjs.org/) — terminal emulation
- [node-pty](https://github.com/microsoft/node-pty) — PTY backend
- [basedpyright](https://github.com/DetachHead/basedpyright) / [ty](https://github.com/astral-sh/ty) — language servers

---

## License

MIT © [Rafael Pierre](https://github.com/rafaelpierre)
