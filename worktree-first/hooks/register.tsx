import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RepoState } from '../types'

const repoState = atom({ plugin: 'worktree-first', key: 'repo' } as const, null)
const guardOff = atom({ plugin: 'worktree-first', key: 'isGuardOff' } as const, false)

/** Tools that change files in the checkout they run in. */
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const

/** Small, shared files a worktree should see the same as the main worktree. */
const LINK = ['.env', '.env.local', '.env.development.local', '.env.production.local', '.envrc', '.npmrc']

/** Expensive directories copied as APFS clones: instant, and no extra disk until written. */
const CLONE = ['node_modules']

/** `.claude/worktree-first.json` in the repository overrides each of these. */
type Setup = { link: string[]; clone: string[]; terminal: boolean }

/** The desktop app's Terminal panel, reached through its own tools. Absent in a plain terminal session. */
const OPEN_TAB = 'mcp__terminal__open_terminal_tab'
const LIST_TABS = 'mcp__terminal__list_terminal_tabs'
const RUN_IN_TAB = 'mcp__terminal__run_in_terminal'

async function git($: EngineInterface, argv: string[], cwd?: string) {
  const ran = await $.process.run(['git', ...argv], cwd ? { cwd } : undefined)
  return { ok: ran.exitCode === 0, out: ran.stdout.trim(), err: ran.stderr.trim() }
}

async function exists($: EngineInterface, path: string) {
  return (await $.process.run(['/bin/test', '-e', path])).exitCode === 0
}

function basename(path: string) {
  return path.split('/').filter(part => part !== '').pop() ?? path
}

/** Shortens a branch name from the middle, where the telling part usually sits. */
function short(text: string, limit: number) {
  if (text.length <= limit || limit < 8) return text
  const head = Math.ceil((limit - 1) / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - (limit - 1 - head))}`
}

/** Whether a path is the folder itself or something under it. */
function within(path: string, folder: string) {
  return path === folder || path.startsWith(`${folder}/`)
}

/**
 * Whether git ignores the path, so it can never reach a commit: a new file under an
 * ignored `_temp/` or `.dump/` is, a tracked file never is, even where a rule matches
 * it. Only a clear yes counts; an error leaves the guard in place.
 */
async function isIgnored($: EngineInterface, root: string, path: string) {
  return (await git($, ['check-ignore', '-q', '--', path], root)).ok
}

/** The checkout a `git -C <dir>` command acts on, resolved from the session's folder. */
async function commitTarget($: EngineInterface, dir: string) {
  const script =
    'd=$1; case $d in "~"*) d=$HOME${d#\\~};; esac; cd -- "$d" || exit 1; ' +
    'git rev-parse --path-format=absolute --git-dir --git-common-dir || exit 1; ' +
    'git branch --show-current; git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true'
  const ran = await $.process.run(['/bin/sh', '-c', script, 'sh', dir], { cwd: await $.session.cwd() })
  if (ran.exitCode !== 0) return null
  const [gitDir, commonDir, branch = '', origin = ''] = ran.stdout.trim().split('\n')
  return {
    isWorktree: gitDir !== commonDir,
    branch: branch === '' ? null : branch,
    defaultBranch: origin === '' ? null : origin.replace(/^origin\//, ''),
  }
}

/** Reads where the session sits. `null` when it is not in a git repository. */
async function look($: EngineInterface): Promise<RepoState> {
  const path = await $.session.cwd()
  const dir = await git($, ['rev-parse', '--path-format=absolute', '--git-dir'], path)
  if (!dir.ok) return null

  const common = await git($, ['rev-parse', '--path-format=absolute', '--git-common-dir'], path)
  // One status call gives the branch, its upstream, ahead/behind and the changed
  // files. --no-optional-locks keeps it from taking the index lock an agent may need.
  const status = await git($, ['--no-optional-locks', 'status', '--porcelain=v2', '--branch'], path)
  const head = await git($, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'], path)
  // `repo.root` is the main working tree's even from a worktree, so its name
  // identifies the project rather than the worktree folder.
  const repo = await $.session.repo()
  const root = repo?.root ?? path

  let branch: string | null = null
  let hasUpstream = false
  let ahead = 0
  let behind = 0
  let changes = 0
  let untracked = 0
  for (const line of status.out.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const name = line.slice('# branch.head '.length)
      branch = name === '(detached)' ? null : name
    } else if (line.startsWith('# branch.upstream ')) {
      hasUpstream = true
    } else if (line.startsWith('# branch.ab ')) {
      const [, , a = '+0', b = '-0'] = line.split(' ')
      ahead = Number(a.slice(1)) || 0
      behind = Number(b.slice(1)) || 0
    } else if (line.startsWith('? ')) {
      // Counted apart: a new file is work not yet committed, but until it is added
      // it touches no diff, pull or commit, so it must not read as a change.
      untracked += 1
    } else if (line !== '' && !line.startsWith('#') && !line.startsWith('!')) {
      changes += 1
    }
  }

  return {
    path,
    root,
    name: basename(root),
    isWorktree: common.ok && dir.out !== common.out,
    branch,
    defaultBranch: head.ok && head.out.startsWith('origin/') ? head.out.slice('origin/'.length) : null,
    changes,
    untracked,
    ahead,
    behind,
    hasUpstream,
  }
}

async function readSetup($: EngineInterface, main: string): Promise<Setup> {
  try {
    const text = await $.fs.read(`${main}/.claude/worktree-first.json`)
    const parsed: unknown = JSON.parse(typeof text === 'string' ? text : String(text))
    const from = (key: 'link' | 'clone', fallback: string[]) => {
      const value = (parsed as Record<string, unknown>)?.[key]
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : fallback
    }
    const terminal = (parsed as Record<string, unknown>)?.terminal
    return { link: from('link', LINK), clone: from('clone', CLONE), terminal: terminal !== false }
  } catch {
    return { link: LINK, clone: CLONE, terminal: true }
  }
}

/**
 * Gives the desktop app's Terminal panel a tab whose shell starts in the worktree,
 * so what the user types there runs on the session's branch, not the main worktree's.
 * The panel cannot move a shell that is already running, so this is a new tab; a
 * worktree that already has one is left alone.
 *
 * Unless `show` is set it acts only where the panel already has a tab, which is how
 * a session that uses the terminal is told from one that never does, and it adds the
 * tab without bringing the panel up. Answers `opened`, `present`, `unused` where the
 * panel has no tab, `none` where the session has no Terminal panel, or `failed`.
 */
async function followTerminal($: EngineInterface, worktree: string, title: string, show = false) {
  let tabs: string
  try {
    const listed = await $.tool.call({ tool: LIST_TABS })
    if (listed.deny !== undefined || listed.isError === true) return 'failed' as const
    tabs = listed.text ?? ''
  } catch {
    // No such tool: a session in a plain terminal, where the user's shell is their own.
    return 'none' as const
  }
  // Each tab is listed with the directory its shell started in, as a JSON string.
  if (tabs.includes(JSON.stringify(worktree))) return 'present' as const
  if (!show && !tabs.includes('"tab_id"')) return 'unused' as const

  try {
    // Opening a tab shows the panel; running a command adds one behind it. The
    // command is a harmless one that says which branch the new shell is on.
    const opened = show
      ? await $.tool.call({ tool: OPEN_TAB, cwd: worktree, title })
      : await $.tool.call({ tool: RUN_IN_TAB, command: 'git status -sb', cwd: worktree, title })
    return opened.deny !== undefined || opened.isError === true ? ('failed' as const) : ('opened' as const)
  } catch {
    return 'failed' as const
  }
}

/**
 * Gives a fresh worktree what git does not copy: the ignored files a build needs.
 * Small files are symlinked so they stay in step with the main worktree; heavy
 * directories are APFS clones, which share their blocks until something writes.
 * Nothing already in the worktree is touched.
 */
async function furnish($: EngineInterface, worktree: string, main: string) {
  const setup = await readSetup($, main)
  const linked: string[] = []
  const cloned: string[] = []
  const failed: string[] = []

  for (const name of setup.link) {
    const source = `${main}/${name}`
    const target = `${worktree}/${name}`
    if (!(await exists($, source)) || (await exists($, target))) continue
    const ran = await $.process.run(['ln', '-s', source, target])
    if (ran.exitCode === 0) linked.push(name)
    else failed.push(name)
  }

  for (const name of setup.clone) {
    const source = `${main}/${name}`
    const target = `${worktree}/${name}`
    if (!(await exists($, source)) || (await exists($, target))) continue
    $.ui.status(`worktree-first: cloning ${name}…`)
    // -c asks for a copy-on-write clone; it needs APFS and one volume.
    const ran = await $.process.run(['cp', '-Rc', source, target], { timeoutMs: 300_000 })
    if (ran.exitCode === 0) cloned.push(name)
    else failed.push(name)
  }

  $.ui.status(undefined)
  return { linked, cloned, failed }
}

/** Re-read at most every few seconds: a burst of edits should not re-run git each time. */
let cached: { at: number; state: RepoState } | null = null

async function current($: EngineInterface, force = false) {
  const now = await $.clock.now()
  if (!force && cached !== null && now - cached.at < 3_000) return cached.state
  const state = await look($)
  cached = { at: now, state }
  await update($, repoState, () => state)
  return state
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'worktree-guard',
      description: 'worktree-first: allow or block code changes in the main worktree',
    })
    await $.command.register({
      name: 'worktree-terminal',
      description: 'worktree-first: open a terminal tab in the worktree this session works in',
    })
    await current($, true)
    return next(e)
  })

  on('command.run', { command: 'worktree-guard' }, async ($, e, next) => {
    const off = await read($, guardOff)
    await update($, guardOff, () => !off)
    return {
      text: off
        ? 'worktree-first: guard on again. Code changes in the main worktree are blocked.'
        : 'worktree-first: guard off for this session. Code changes in the main worktree are allowed.',
    }
  }).catch(() => ({ text: 'worktree-first: could not change the guard.' }))

  // The terminal on request: for a session that had none in use when it entered the
  // worktree, and wants one now.
  on('command.run', { command: 'worktree-terminal' }, async $ => {
    const state = await current($, true)
    if (state === null || !state.isWorktree) {
      return { text: 'worktree-first: this session is not in a linked worktree, so the terminal is already where it works.' }
    }
    const terminal = await followTerminal($, state.path, short(state.branch ?? basename(state.path), 28), true)
    return {
      text:
        terminal === 'opened'
          ? `worktree-first: opened a terminal tab in ${state.path}.`
          : terminal === 'present'
            ? 'worktree-first: the Terminal panel already has a tab in this worktree.'
            : terminal === 'none'
              ? 'worktree-first: this session has no Terminal panel.'
              : 'worktree-first: could not open a terminal tab.',
    }
  }).catch(() => ({ text: 'worktree-first: could not open a terminal tab.' }))

  // The guard. It blocks a write only when the session sits in a repository's main
  // checkout and the file being written belongs to that repository and is not
  // gitignored, so a scratch file, notes in an ignored folder, another project or a
  // plugin folder is never in its way.
  on('tool.call', { tool: WRITE_TOOLS }, async ($, e, next) => {
    const state = await current($)
    if (state === null || state.isWorktree || (await read($, guardOff))) return next(e)

    const input = e as { file_path?: unknown; notebook_path?: unknown }
    const target = typeof input.file_path === 'string' ? input.file_path : input.notebook_path
    if (typeof target !== 'string' || !within(target, state.root)) return next(e)
    if (await isIgnored($, state.root, target)) return next(e)

    return {
      deny:
        `worktree-first: ${target} is in the repository's main worktree (${state.root}` +
        `${state.branch === null ? '' : `, branch ${state.branch}`}), which stays on ` +
        `${state.defaultBranch ?? 'its default branch'}. Code changes belong in a worktree. ` +
        `Call EnterWorktree (a short, descriptive name is welcome), then make this change there. ` +
        `Gitignored files, such as notes in an ignored folder, can be written here directly. ` +
        `If the user wants to edit the main worktree anyway, they can run /worktree-guard.`,
    }
    // A guard that cannot tell where it is lets the work through: this steers a
    // workflow, it is not a security boundary.
  }).catch(($, e, next) => (next.called ? next(e) : next(e)))

  // Committing from the main worktree is the failure this exists to prevent. Any git
  // command can also move the branch or the counts, so the row is re-read after it.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const commit = /\bgit\s+(?:-C\s+("[^"]*"|'[^']*'|\S+)\s+)?commit\b/.exec(e.command)
    if (commit) {
      // `git -C <dir> commit` commits in <dir>, which may be another repository.
      const state = commit[1] === undefined ? await current($) : await commitTarget($, commit[1].replace(/^["']|["']$/g, ''))
      const isProtected =
        state !== null &&
        !state.isWorktree &&
        state.branch !== null &&
        state.branch === state.defaultBranch &&
        !(await read($, guardOff))

      if (isProtected) {
        return {
          deny:
            `worktree-first: that would commit to ${state.branch} in the main worktree. ` +
            `Make the change in a worktree (EnterWorktree) and commit there, ` +
            `or run /worktree-guard to allow it.`,
        }
      }
    }

    const ran = await next(e)
    if (/\bgit\b/.test(e.command)) await current($, true)
    return ran
  }).catch(($, e, next) => (next.called ? next(e) : next(e)))

  // Edits, installs and the user's own terminal change things too: a fresh look at
  // the end of each turn keeps the row from going stale.
  on('turn.complete', async ($, e, next) => {
    try {
      const state = await current($, true)
      // A terminal the user opened after the session entered its worktree starts in
      // the main one: by the end of the turn it has a tab in the worktree too.
      if (state !== null && state.isWorktree && (await readSetup($, state.root)).terminal) {
        await followTerminal($, state.path, short(state.branch ?? basename(state.path), 28))
      }
    } catch {
      // A failed look leaves the last state showing; the turn must still complete.
    }
    return next(e)
  })

  // EnterWorktree moves the session; this furnishes what it leaves behind.
  on('tool.call', { tool: 'EnterWorktree' }, async ($, e, next) => {
    const main = (await $.session.repo())?.root ?? null
    const entered = await next(e)
    if (entered.deny !== undefined || entered.isError === true || main === null) return entered

    const worktree = (entered.result as { worktreePath?: string } | undefined)?.worktreePath
    if (typeof worktree !== 'string' || worktree === main) return entered

    const { linked, cloned, failed } = await furnish($, worktree, main)
    const state = await current($, true)

    // The Terminal panel's shells stay where they started, in the main worktree. A
    // session that has the terminal in use gets a tab in the worktree; one that
    // does not is left without.
    const terminal = (await readSetup($, main)).terminal
      ? await followTerminal($, worktree, short(state?.branch ?? basename(worktree), 28))
      : 'none'

    const parts = [
      cloned.length > 0 ? `cloned ${cloned.join(', ')}` : null,
      linked.length > 0 ? `linked ${linked.join(', ')}` : null,
      failed.length > 0 ? `could not set up ${failed.join(', ')}` : null,
      terminal === 'opened' ? 'added a terminal tab in the worktree' : null,
      // Claude can still open it, with the user asked as for any tool call.
      terminal === 'failed'
        ? `could not add a terminal tab in the worktree: if the user asks for a terminal, open it with cwd ${worktree}`
        : null,
    ].filter((part): part is string => part !== null)

    if (parts.length === 0) return entered
    $.ui.toast(`worktree-first: ${parts.filter(part => !part.startsWith('could not add')).join(', ') || 'worktree ready'}`)
    return { ...entered, result: { ...(entered.result as object), worktreeFirst: parts.join('; ') } }
    // Setting the worktree up is a convenience; entering it must still succeed.
  }).catch(($, e, next) => (next.called ? next(e) : next(e)))

  // Names the project first: with several sessions side by side and the sidebar
  // hidden, this row is the only thing saying which repository a session is in.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, repoState)
    if (state === null) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const off = await read($, guardOff)
    const branch = state.branch ?? 'detached HEAD'
    const columns = e.viewport?.columns ?? 80
    const isWide = columns >= 72
    const isMedium = columns >= 48

    // Changed tracked files, untracked files, then commits to push and to pull (as
    // of the last fetch), each group after its own dot: `· 3 changed · 2 untracked · ↑2 ↓1`.
    const sync = [
      state.hasUpstream && state.ahead > 0 ? `↑${state.ahead}` : null,
      state.hasUpstream && state.behind > 0 ? `↓${state.behind}` : null,
    ]
      .filter((part): part is string => part !== null)
      .join(' ')
    const changedText = state.changes > 0 ? ` · ${state.changes} changed` : ''
    const untrackedText = state.untracked > 0 ? ` · ${state.untracked} untracked` : ''
    const syncText = sync === '' ? '' : ` · ${sync}`
    // The untracked count is the least urgent of the three: it goes where even the
    // barest row, project and branch alone, would leave the branch no room.
    const hasRoomForUntracked =
      columns - state.name.length - ' · '.length - (changedText + untrackedText + syncText).length >= 14
    const countsText = changedText + (hasRoomForUntracked ? untrackedText : '') + syncText

    // Sheds as the column narrows: the hint, then the worktree label, then the
    // untracked count; the project, branch and the other counts always stay.
    const fits = (label: string, hint: string) =>
      columns - state.name.length - label.length - countsText.length - hint.length >= 14
    const room = (label: string, hint: string) =>
      Math.max(10, columns - state.name.length - label.length - countsText.length - hint.length)

    // git's own pair of terms: a repository has one main worktree and zero or more
    // linked ones. Naming both keeps the row consistent with what git says.
    if (state.isWorktree) {
      const label = isWide && fits(' · linked worktree · ', '') ? ' · linked worktree · ' : isMedium ? ' · worktree · ' : ' · '
      return (
        <Box>
          <Text bold>{state.name}</Text>
          <Text dimColor>
            {label}
            {short(branch, room(label, ''))}
            {countsText}
          </Text>
        </Box>
      )
    }

    const isStray = state.defaultBranch !== null && state.branch !== null && state.branch !== state.defaultBranch
    const label = isMedium ? ' · main worktree · ' : ' · '
    const wanted = isStray
      ? ` · expected ${state.defaultBranch}`
      : off
        ? ' · guard off'
        : ' · changes go to a linked worktree'
    // The drift warning and "guard off" always show; the plain hint only where it fits.
    const hint = isStray || off || (isWide && fits(label, wanted)) ? wanted : ''

    return (
      <Box>
        <Text bold>{state.name}</Text>
        <Text color={isStray ? 'red' : 'yellow'}>
          {label}
          {short(branch, room(label, hint))}
          {countsText}
        </Text>
        <Text dimColor>{hint}</Text>
      </Box>
    )
  })
}
