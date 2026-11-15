# claude-mods

Claude Code mods: plugins that change how Claude Code itself behaves. This repository is a plugin marketplace, so Claude Code installs them straight from here.

| Mod | What it does |
| --- | --- |
| [worktree-first](worktree-first/) | Keeps a repository's main worktree on its default branch. Code changes go to a linked worktree, set up with symlinked env files and APFS-cloned dependencies. A row above the prompt names the project, branch, changed files and commits to push or pull. |

## Install

In Claude Code (terminal or desktop app):

```
/plugin marketplace add JakobFelixJulius/claude-mods
/plugin install worktree-first@jsudau-mods
```

Or from a shell:

```bash
claude plugin marketplace add JakobFelixJulius/claude-mods
claude plugin install worktree-first@jsudau-mods
```

Restart Claude Code afterwards. In the desktop app, quit it fully (⌘Q) and reopen it: plugins load when a session starts.

## Update

```bash
claude plugin marketplace update jsudau-mods
claude plugin update worktree-first@jsudau-mods
```

Then restart Claude Code again.

## Requirements

- Claude Code 2.1.322 or newer. Mods use the function-hooks plugin API, which is early access and may change between releases.
- macOS for the dependency cloning in worktree-first (APFS copy-on-write). Everything else is plain git.

## Developing

Each mod is a folder with `.claude-plugin/plugin.json`, `hooks/hooks.json` and a hooks module. Check one with:

```bash
claude plugin validate worktree-first
claude plugin test worktree-first
```

## License

[MIT](LICENSE)
