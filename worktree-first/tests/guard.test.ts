import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const MAIN = '/repo'
const WORKTREE = '/repo/.claude/worktrees/task'

/**
 * Puts the session in a checkout of the given kind: answers the cwd and the git
 * calls the mod makes, and lets any tool call through at the bottom, so what a
 * test sees is the mod's own decision.
 */
type Sync = { changes?: number; ahead?: number; behind?: number }

/** What `git status --porcelain=v2 --branch` prints for a branch in this state. */
function porcelain(branch: string, sync: Sync) {
  const lines = [
    `# branch.oid 0123456789abcdef`,
    `# branch.head ${branch}`,
    `# branch.upstream origin/${branch}`,
    `# branch.ab +${sync.ahead ?? 0} -${sync.behind ?? 0}`,
  ]
  for (let i = 0; i < (sync.changes ?? 0); i += 1) lines.push(`1 .M N... 100644 100644 100644 a b src/file${i}.ts`)
  return lines.join('\n')
}

/**
 * Puts the session in a checkout of the given kind: answers the cwd and the git
 * calls the mod makes, and lets any tool call through at the bottom, so what a
 * test sees is the mod's own decision. `state.sync` can be changed mid-test to
 * play a git command that moves the counts.
 */
function checkout(on: On, where: 'main' | 'worktree' | 'plain', branch = 'dev', initial: Sync = {}) {
  const path = where === 'worktree' ? WORKTREE : MAIN
  const state = { branch, sync: initial }

  on('session.cwd', () => ({ value: path }))
  on('session.repo', () => ({ value: where === 'plain' ? null : { root: MAIN, remote: null, internal: false, name: null } }))

  on('process.run', ($, e) => {
    const argv = [...e.argv]
    const say = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } })
    const no = { value: { exitCode: 1, stdout: '', stderr: '' } }

    // `git -C <dir>` targets, resolved by the mod through sh: /other is another
    // repository's main worktree on its default branch, /other-task a worktree of it.
    if (argv[0] === '/bin/sh') {
      if (argv[4] === '/other') return say('/other/.git\n/other/.git\nmain\norigin/main')
      if (argv[4] === '/other-task') return say('/other/.git/worktrees/t\n/other/.git\nfix/x\norigin/main')
      return no
    }
    if (argv[0] !== 'git') return say('')
    if (argv.includes('--git-dir')) {
      return where === 'plain' ? no : say(where === 'worktree' ? `${MAIN}/.git/worktrees/task` : `${MAIN}/.git`)
    }
    if (argv.includes('--git-common-dir')) return say(`${MAIN}/.git`)
    if (argv.includes('status')) return say(porcelain(state.branch, state.sync))
    if (argv[1] === 'symbolic-ref') return say('origin/dev')
    return say('')
  })

  on('tool.call', () => ({ result: { ok: true } }))
  return state
}

const band = (columns: number) => ({
  plugin: 'worktree-first',
  surface: 'desktop' as const,
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false },
  viewport: { columns, rows: 40 },
})

test('an edit in the main worktree is refused, and says how to proceed', async ($, on) => {
  mock.clock(on)
  checkout(on, 'main')

  const result = await $.tool.call({ tool: 'Edit', file_path: `${MAIN}/src/a.ts` })

  expect(result.deny).toMatch(/EnterWorktree/)
  expect(result.deny).toMatch(/main worktree/)
})

test('an edit inside a worktree goes through', async ($, on) => {
  mock.clock(on)
  checkout(on, 'worktree', 'fix/login')

  const result = await $.tool.call({ tool: 'Edit', file_path: `${WORKTREE}/src/a.ts` })

  expect(result.deny).toBeUndefined()
})

test('a folder that is not a git repository is never guarded', async ($, on) => {
  mock.clock(on)
  checkout(on, 'plain')

  const result = await $.tool.call({ tool: 'Edit', file_path: '/notes/a.md' })

  expect(result.deny).toBeUndefined()
})

test('committing on the default branch in the main worktree is refused', async ($, on) => {
  mock.clock(on)
  checkout(on, 'main', 'dev')

  const result = await $.tool.call({ tool: 'Bash', command: 'git commit -m "wip"' })

  expect(result.deny).toMatch(/would commit to dev/)
})

test('committing from a worktree goes through', async ($, on) => {
  mock.clock(on)
  checkout(on, 'worktree', 'fix/login')

  const result = await $.tool.call({ tool: 'Bash', command: 'git commit -m "wip"' })

  expect(result.deny).toBeUndefined()
})

test('git -C judges the repository it names, not the session one', async ($, on) => {
  mock.clock(on)
  checkout(on, 'main', 'dev')

  const elsewhere = await $.tool.call({ tool: 'Bash', command: 'git -C /other-task commit -m "wip"' })
  expect(elsewhere.deny).toBeUndefined()

  const otherMain = await $.tool.call({ tool: 'Bash', command: "git -C '/other' commit -m wip" })
  expect(otherMain.deny).toMatch(/would commit to main/)
})

test('an unrelated Bash command is left alone', async ($, on) => {
  mock.clock(on)
  checkout(on, 'main')

  const result = await $.tool.call({ tool: 'Bash', command: 'npm test' })

  expect(result.deny).toBeUndefined()
})

test('the slash command turns the guard off, and an edit then goes through', async ($, on) => {
  mock.clock(on)
  checkout(on, 'main')

  const off = await $.command.run({ command: 'worktree-guard', args: '' })
  expect(off.text).toMatch(/guard off/)

  const result = await $.tool.call({ tool: 'Edit', file_path: `${MAIN}/src/a.ts` })
  expect(result.deny).toBeUndefined()
})

test('a file outside the repository is left alone, even from the main worktree', async ($, on) => {
  mock.clock(on)
  checkout(on, 'main')

  const result = await $.tool.call({
    tool: 'Write',
    file_path: '/Users/someone/.claude/dev-mods/notes/register.tsx',
  })

  expect(result.deny).toBeUndefined()
})

test('the band names the project, and sheds detail as the column narrows', async ($, on) => {
  mock.clock(on)
  checkout(on, 'worktree', 'fix/a-rather-long-branch-name-here')
  // The band draws what the last look stored; a tool call is what takes that look.
  await $.tool.call({ tool: 'Edit', file_path: `${WORKTREE}/a.ts` })

  const wide = await $.ui.mount(band(100))
  expect(await wide.find({ type: 'Text', text: 'repo' })).toBeDefined()
  expect(await wide.find({ type: 'Text', text: /linked worktree/ })).toBeDefined()
  await wide.unmount()

  const narrow = await $.ui.mount(band(36))
  expect(await narrow.find({ type: 'Text', text: 'repo' })).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: /worktree/ })).toBeUndefined()
  await narrow.unmount()
})

test('the band shows changed files and commits to push and pull', async ($, on) => {
  mock.clock(on)
  checkout(on, 'worktree', 'fix/login', { changes: 3, ahead: 2, behind: 1 })
  await $.tool.call({ tool: 'Edit', file_path: `${WORKTREE}/a.ts` })

  const ui = await $.ui.mount(band(100))
  expect(await ui.find({ type: 'Text', text: /3 changed · ↑2 ↓1/ })).toBeDefined()
  await ui.unmount()
})

test('a clean, in-step branch shows no counts', async ($, on) => {
  mock.clock(on)
  checkout(on, 'worktree', 'fix/login', {})
  await $.tool.call({ tool: 'Edit', file_path: `${WORKTREE}/a.ts` })

  const ui = await $.ui.mount(band(100))
  expect(await ui.find({ type: 'Text', text: /changed|↑|↓/ })).toBeUndefined()
  await ui.unmount()
})

test('a git command refreshes the band at once, without waiting for an edit', async ($, on) => {
  mock.clock(on)
  const repo = checkout(on, 'worktree', 'fix/login', {})
  await $.tool.call({ tool: 'Edit', file_path: `${WORKTREE}/a.ts` })

  // The agent switches branch and has work to push; the row must follow straight away.
  repo.branch = 'feat/search'
  repo.sync = { ahead: 4 }
  await $.tool.call({ tool: 'Bash', command: 'git switch feat/search' })

  const ui = await $.ui.mount(band(100))
  expect(await ui.find({ type: 'Text', text: /feat\/search · ↑4/ })).toBeDefined()
  await ui.unmount()
})

test('the main worktree with uncommitted changes shows them in its warning', async ($, on) => {
  mock.clock(on)
  checkout(on, 'main', 'dev', { changes: 2 })
  await $.tool.call({ tool: 'Bash', command: 'git status' })

  const ui = await $.ui.mount(band(100))
  expect(await ui.find({ type: 'Text', text: /main worktree · dev · 2 changed/ })).toBeDefined()
  await ui.unmount()
})
