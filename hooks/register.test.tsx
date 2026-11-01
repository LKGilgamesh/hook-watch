import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'hook-watch',
  component: 'Pane',
  requestId: 'hook-watch',
  props: {
    title: 'Hooks',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('Reset clears the counters', async ($, on) => {
  on('telemetry.log', () => ({ value: undefined }))

  // Three firings of the Stop group, the way Claude Code reports them.
  for (let i = 0; i < 3; i++) {
    await $.telemetry.log({ to: 'collector', event: 'hook_execution_complete', attributes: { hook_name: 'Stop', num_hooks: 1 }, loggedAt: new Date().toISOString() })
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /group firings/ }))?.text).toMatch(/^3 group firings/)
  await ui.press({ key: 'reset' })
  expect((await ui.find({ type: 'Text', text: /group firings/ }))?.text).toMatch(/^0 group firings/)
  await ui.unmount()
})

test('the docked pane opens with its title and a divider', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /◆ Hooks/ }))?.text).toBe('◆ Hooks')
  expect((await ui.find({ type: 'Text', text: /^─+$/ }))?.text).toBe('─'.repeat(80))
  await ui.unmount()
})
