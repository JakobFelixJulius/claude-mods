/** Where the session sits, as of the last look. `null` outside a git repository. */
export type RepoState = {
  /** The session's directory. */
  path: string
  /** The repository's main working tree, even when the session is in a worktree. */
  root: string
  /** The project's name: the main working tree's folder name. */
  name: string
  /** A linked worktree, rather than the repository's main worktree. */
  isWorktree: boolean
  /** The checked-out branch, or null when the head is detached. */
  branch: string | null
  /** The remote's default branch (`origin/HEAD`), when it is known. */
  defaultBranch: string | null
  /** Tracked files with uncommitted changes, staged or not. */
  changes: number
  /** Untracked files that are not ignored: new files nobody has added yet. */
  untracked: number
  /** Commits not yet pushed to the upstream branch, as of the last fetch. */
  ahead: number
  /** Commits on the upstream branch not yet pulled, as of the last fetch. */
  behind: number
  /** Whether the branch tracks an upstream at all; ahead/behind mean nothing without one. */
  hasUpstream: boolean
} | null

declare module 'claude-code' {
  interface PluginState {
    'worktree-first': {
      repo: RepoState
      /** The guard is off for this session, after the slash command. */
      isGuardOff: boolean
    }
  }
}
