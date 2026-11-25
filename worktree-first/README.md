# worktree-first

Keeps a repository's main worktree on its default branch, and sends every code change to a git worktree instead. Built for working with coding agents across several projects, where a session that edits the main worktree quietly puts commits on `dev` or `main` and collides with the other sessions running beside it.

## What it does

**Blocks code changes in the main worktree.** Edit, Write and NotebookEdit are refused while the session sits in a repository's main worktree. The refusal tells Claude to call `EnterWorktree` and make the change there, so in practice a worktree simply appears instead of a stray edit. `git commit` through Bash is refused the same way while the main worktree is on its default branch.

The guard acts only on files that belong to that repository, so a scratch file, another project or a plugin folder is never in its way. Files the repository ignores are let through too, as `git check-ignore` decides: notes in a gitignored `_temp/` or `.dump/` folder can be written from the main worktree, since they can never reach a commit. A tracked file stays guarded even where an ignore rule matches it. It never acts outside a git repository, and never inside a worktree. If it cannot work out where it is, it lets the work through: this steers a workflow, it is not a security boundary.

**Furnishes each new worktree.** `git worktree add` gives you tracked files only, so a fresh worktree has no dependencies and no environment files, and nothing builds. After `EnterWorktree` succeeds, this mod copies across what the repository ignores but a build needs:

- **Environment files are symlinked** (`.env`, `.env.local`, `.envrc`, `.npmrc` …), so they stay in step with the main worktree.
- **Heavy directories are APFS clones** (`node_modules`), using `cp -Rc`. A clone shares its blocks with the original until something writes, so a 1.4 GB `node_modules` takes seconds and costs no extra disk. Unlike a symlink it is independent: `npm install` on a dependency branch changes only that worktree.

Nothing already present in the worktree is overwritten, and `git worktree remove` still works afterwards, since all of it is gitignored. Tools that list worktrees, such as the Offshoot menu bar app, keep working unchanged.

**Brings the terminal along.** In the Claude desktop app, the integrated terminal's shells start in the main worktree and stay there when the session moves, so a command you type runs on `dev` or `main` while Claude works on another branch. When the session enters a worktree and the Terminal panel has a tab open, this mod adds a tab whose shell starts in the worktree, titled with its branch, without bringing the panel up. A session that has no terminal in use gets none. If you open the terminal later, the worktree's tab is added when the current turn ends, or at once with `/worktree-terminal`.

The app cannot move a shell that is already running, so the tab is a new one and the earlier tabs stay where they were; a worktree that already has a tab gets no second one. The new tab runs `git status -sb` once, which is how it is added without the panel opening, and shows the branch it is on. In a plain terminal session there is no panel and nothing happens.

**Shows which project you are in.** A row above the prompt names the repository first, then where the session sits: **web-app** `· worktree · fix/login-redirect`, or a warning **web-app** `· main worktree · dev · changes go to a worktree`, red if the main worktree has drifted off its default branch. After the branch it shows changed files, untracked files and commits to push and pull, e.g. `· 3 changed · 2 untracked · ↑2 ↓1` (ahead and behind as of the last fetch; the mod does not fetch itself). Untracked files are counted apart, since they touch no diff, pull or commit until they are added, and that count is the first to go where the row runs out of room. The row is re-read after every git command and at the end of each turn, so a branch switched from Bash or your own terminal shows up straight away. The name comes from the repository's main working tree, so it stays the project's name inside a worktree. With several sessions side by side and the sidebar hidden, this row is the only thing saying which project each one belongs to, so it sheds the wordier parts as the column narrows and shortens a long branch from the middle.

## Per-repository setup

Defaults suit a Node project. To change what is linked or cloned, add `.claude/worktree-first.json` to the repository:

```json
{
  "link": [".env", ".env.local"],
  "clone": ["node_modules", "ios/Pods"],
  "terminal": true
}
```

`link` is for small shared files, `clone` for directories expensive to rebuild. `terminal: false` stops the mod adding a terminal tab for the worktree. Entries missing from the main worktree are skipped. Cloning is worth it for anything slower to regenerate than to copy; `ios/Pods` is a good candidate on a React Native project, and is left out of the defaults because most sessions never build iOS.

## Commands

`/worktree-terminal` opens the Terminal panel with a tab in the worktree the session works in, for when no terminal was in use as it entered.

`/worktree-guard` turns the guard off for the current session, and on again. Use it for the times you deliberately want to edit the main worktree.

## Requirements

macOS with an APFS volume for the clone step; elsewhere the clone is reported as not set up and the dependencies need installing in the worktree. Everything else is plain git.
