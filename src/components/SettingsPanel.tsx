import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { MouseEvent } from '@opentui/core'
import { MouseButton, ScrollBoxRenderable } from '@opentui/core'
import { useFocusZone, useListNavigation } from '../lib/focus/index.js'
import { tuiAttrs } from '../lib/tuiAttrs.js'
import { useTerminalDimensions } from '@opentui/react'
import type { IAgent } from '../types/index.js'
import type { GitSettings } from '../cli/profile.js'
import {
  GIT_MODE_OPTIONS as SHARED_GIT_MODE_OPTIONS,
  GIT_MODE_PRESETS,
  detectGitMode
} from '../lib/gitMode.js'
import {
  Checkbox,
  CheckboxGroup,
  checkboxGroupKeys,
  selectionFromValues,
  selectionToValues,
  toggleCheckboxSelection,
  type CheckboxItem,
  type CheckboxSelection
} from './shared/CheckboxGroup.js'

import {
  ACCENT,
  BG_MODAL,
  BORDER_MUTED,
  FG_ERROR_SOFT,
  FG_HINT,
  FG_TITLE,
  MODAL_BACKDROP_RGBA
} from './shared/tuiTheme.js'
import { FocusedOutlineButton } from './shared/FocusedOutlineButton.js'

const BACKDROP_BG = MODAL_BACKDROP_RGBA

const ADVANCED_SETTINGS_SCROLL_STYLE = {
  wrapperOptions: { flexGrow: 1 },
  viewportOptions: { flexGrow: 1 },
  scrollbarOptions: {
    showArrows: true,
    trackOptions: {
      foregroundColor: ACCENT,
      backgroundColor: BORDER_MUTED
    }
  }
} as const

const AUTO_RESOLVE_KEY = 'auto-resolve'
const APPLY_KEY = 'apply'
const CANCEL_KEY = 'cancel'

const GIT_FIELDS: { key: keyof GitSettings; rowKey: string; label: string }[] = [
  { key: 'use_worktree', rowKey: 'git-use_worktree', label: 'Use worktree' },
  { key: 'branch_create', rowKey: 'git-branch_create', label: 'Create branch' },
  { key: 'commit', rowKey: 'git-commit', label: 'Commit changes' },
  { key: 'push', rowKey: 'git-push', label: 'Push to remote' },
  { key: 'pr_create', rowKey: 'git-pr_create', label: 'Create pull request' }
]

const GIT_MODE_OPTIONS = SHARED_GIT_MODE_OPTIONS.map((o) => ({ ...o, rowKey: `git-mode-${o.mode}` }))

const GIT_ADVANCED_KEY = 'git-advanced'

function buildIssueSubscription(
  env: CheckboxSelection,
  comp: CheckboxSelection
): NonNullable<IAgent['settings']>['issueSubscription'] {
  const issueSubscription: NonNullable<IAgent['settings']>['issueSubscription'] = {}
  const envValues = selectionToValues(env)
  const compValues = selectionToValues(comp)
  if (envValues) issueSubscription.environmentName = envValues
  if (compValues) issueSubscription.componentName = compValues
  return issueSubscription
}

export interface SettingsPanelProps {
  /** Pre-filled subscription + agent toggles when we have them (optional). */
  initialSettings?: Partial<IAgent['settings']>
  /** Pre-filled git settings (the booleans persisted in <projectDir>/.multiplayer/settings.json under `git`). */
  initialGitSettings?: GitSettings
  components: string[]
  environments: string[]
  loadError?: string | null
  onApply: (settings: Partial<NonNullable<IAgent['settings']>>) => void
  /** Fires alongside onApply when git toggles change. */
  onApplyGitSettings?: (git: GitSettings) => void
  onClose: () => void
}

export function SettingsPanel({
  initialSettings,
  initialGitSettings,
  components,
  environments,
  loadError,
  onApply,
  onApplyGitSettings,
  onClose
}: SettingsPanelProps): ReactElement {
  const { width, height } = useTerminalDimensions()

  const [envDim, setEnvDim] = useState<CheckboxSelection>({ mode: 'all' })
  const [compDim, setCompDim] = useState<CheckboxSelection>({ mode: 'all' })
  const [autoResolve, setAutoResolve] = useState(false)
  const [gitState, setGitState] = useState<GitSettings>(() => initialGitSettings ?? {})
  const [gitAdvanced, setGitAdvanced] = useState<boolean>(() => detectGitMode(initialGitSettings ?? {}) === null)
  const listScrollRef = useRef<ScrollBoxRenderable | null>(null)
  const currentGitMode = useMemo(() => detectGitMode(gitState), [gitState])

  const modalMaxHeight = Math.max(14, height - 4)

  useEffect(() => {
    const sub = initialSettings?.issueSubscription
    setEnvDim(selectionFromValues(sub?.environmentName, environments))
    setCompDim(selectionFromValues(sub?.componentName, components))
    setAutoResolve(Boolean(initialSettings?.autoResolveIssues))
  }, [initialSettings, environments, components])

  useEffect(() => {
    const next = initialGitSettings ?? {}
    setGitState(next)
    setGitAdvanced(detectGitMode(next) === null)
  }, [initialGitSettings])

  const envItems: CheckboxItem[] = useMemo(
    () => environments.map((name) => ({ value: name, label: name })),
    [environments]
  )
  const compItems: CheckboxItem[] = useMemo(
    () => components.map((name) => ({ value: name, label: name })),
    [components]
  )

  const flatKeys = useMemo<string[]>(
    () => [
      AUTO_RESOLVE_KEY,
      ...GIT_MODE_OPTIONS.map((o) => o.rowKey),
      GIT_ADVANCED_KEY,
      ...(gitAdvanced ? GIT_FIELDS.map((f) => f.rowKey) : []),
      ...checkboxGroupKeys('env', envItems),
      ...checkboxGroupKeys('comp', compItems)
    ],
    [envItems, compItems, gitAdvanced]
  )

  const applyMain = useCallback(() => {
    onApply({
      issueSubscription: buildIssueSubscription(envDim, compDim),
      autoResolveIssues: autoResolve
    })
    onApplyGitSettings?.(gitState)
    onClose()
  }, [envDim, compDim, autoResolve, gitState, onApply, onApplyGitSettings, onClose])

  const activateKey = useCallback(
    (key: string) => {
      if (key === AUTO_RESOLVE_KEY) {
        setAutoResolve((v) => !v)
        return
      }
      const modeOption = GIT_MODE_OPTIONS.find((o) => o.rowKey === key)
      if (modeOption) {
        setGitState({ ...GIT_MODE_PRESETS[modeOption.mode] })
        return
      }
      if (key === GIT_ADVANCED_KEY) {
        setGitAdvanced((v) => !v)
        return
      }
      const gitField = GIT_FIELDS.find((f) => f.rowKey === key)
      if (gitField) {
        setGitState((g) => ({ ...g, [gitField.key]: !(g[gitField.key] ?? true) }))
        return
      }
      if (key === 'env-all') {
        setEnvDim({ mode: 'all' })
        return
      }
      if (key === 'comp-all') {
        setCompDim({ mode: 'all' })
        return
      }
      if (key.startsWith('env:')) {
        const value = key.slice('env:'.length)
        setEnvDim((d) => toggleCheckboxSelection(d, value, environments))
        return
      }
      if (key.startsWith('comp:')) {
        const value = key.slice('comp:'.length)
        setCompDim((d) => toggleCheckboxSelection(d, value, components))
      }
    },
    [environments, components]
  )

  // Registers on the 'settings' FocusLayer; Escape falls through to the
  // layer's onDismiss. ↑↓ walk every row plus the Apply/Cancel buttons,
  // Enter activates any of them, PgUp/PgDn/Home/End scroll, and the focused
  // row is kept in view.
  useFocusZone({ id: 'settings-form', order: 0 })

  const navItems = useMemo<string[]>(() => [...flatKeys, APPLY_KEY, CANCEL_KEY], [flatKeys])

  const { index: navIndex, setIndex: setNavIndex } = useListNavigation({
    zoneId: 'settings-form',
    items: navItems,
    // Enter activates anything; Space only toggles a checkbox row (matching the
    // old handler) — Space on Apply/Cancel must not apply or discard settings.
    activateOnEnterOnly: true,
    onActivate: (key) => {
      if (key === APPLY_KEY) applyMain()
      else if (key === CANCEL_KEY) onClose()
      else activateKey(key)
    },
    extraKeys: (key, i) => {
      if (key.name !== 'space') return false
      const item = navItems[i]
      if (!item || item === APPLY_KEY || item === CANCEL_KEY) return false
      activateKey(item)
      return true
    },
    itemId: (key) => (key === APPLY_KEY || key === CANCEL_KEY ? undefined : `cb-${key}`),
    scrollRef: listScrollRef,
    pageScroll: true
  })

  const focusedItem = navItems[navIndex] ?? null
  const focusedKey = focusedItem === APPLY_KEY || focusedItem === CANCEL_KEY ? null : focusedItem

  const setFocusByKey = useCallback(
    (key: string) => {
      const i = navItems.indexOf(key)
      if (i >= 0) setNavIndex(i)
    },
    [navItems, setNavIndex]
  )

  const backdropMouseUp = (e: MouseEvent) => {
    if (e.button !== MouseButton.LEFT) return
    e.stopPropagation()
    onClose()
  }

  const stopMouse = (e: MouseEvent) => {
    e.stopPropagation()
  }

  const dialogWidth = Math.min(76, width - 4)
  const maxLabelWidth = dialogWidth - 12

  const renderActionButton = (area: typeof APPLY_KEY | typeof CANCEL_KEY, label: string, onActivate: () => void): ReactElement =>
    (
      <FocusedOutlineButton
        label={label}
        focused={focusedItem === area}
        onPress={() => {
          setFocusByKey(area)
          onActivate()
        }}
      />
    ) as ReactElement

  return (
    <box
      position='absolute'
      top={0}
      left={0}
      width={width}
      height={height}
      flexDirection='column'
      justifyContent='center'
      alignItems='center'
      backgroundColor={BACKDROP_BG}
      onMouseUp={backdropMouseUp}
    >
      <box
        flexDirection='column'
        flexShrink={1}
        minHeight={0}
        maxHeight={modalMaxHeight}
        overflow='hidden'
        width={dialogWidth}
        maxWidth={dialogWidth}
        backgroundColor={BG_MODAL}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        gap={0}
        onMouseUp={stopMouse}
      >
        <box flexDirection='column' flexShrink={0} gap={0}>
          <text fg={FG_TITLE} attributes={tuiAttrs({ bold: true })}>
            Settings
          </text>
          {loadError && (
            <text marginTop={1} fg={FG_ERROR_SOFT}>
              {loadError}
            </text>
          )}
        </box>
        <scrollbox
          ref={listScrollRef}
          marginTop={1}
          flexGrow={1}
          minHeight={8}
          flexShrink={1}
          scrollY
          focused={false}
          style={ADVANCED_SETTINGS_SCROLL_STYLE}
        >
          <box flexDirection='column' flexShrink={0} width='100%' gap={0}>
            <text marginTop={1} fg={FG_HINT} attributes={tuiAttrs({ bold: true })}>
              Issues
            </text>
            <Checkbox
              rowKey={AUTO_RESOLVE_KEY}
              label='Auto-resolve issues'
              state={autoResolve ? 'on' : 'off'}
              focused={focusedKey === AUTO_RESOLVE_KEY}
              onActivate={() => setAutoResolve((v) => !v)}
              onFocus={() => setFocusByKey(AUTO_RESOLVE_KEY)}
              maxLabelWidth={maxLabelWidth}
            />

            <box marginTop={1} flexDirection='row' gap={1}>
              <text fg={FG_HINT} attributes={tuiAttrs({ bold: true })}>
                Git operations
              </text>
              {currentGitMode === null && (
                <text fg={FG_HINT} attributes={tuiAttrs({ dim: true })}>
                  (custom)
                </text>
              )}
            </box>
            {GIT_MODE_OPTIONS.map((opt) => (
              <Checkbox
                key={opt.rowKey}
                rowKey={opt.rowKey}
                label={opt.label}
                desc={opt.desc}
                state={currentGitMode === opt.mode ? 'on' : 'off'}
                focused={focusedKey === opt.rowKey}
                onActivate={() => setGitState({ ...GIT_MODE_PRESETS[opt.mode] })}
                onFocus={() => setFocusByKey(opt.rowKey)}
                maxLabelWidth={maxLabelWidth}
              />
            ))}
            <box
              id={`cb-${GIT_ADVANCED_KEY}`}
              flexDirection='row'
              gap={1}
              paddingLeft={1}
              border={true}
              borderStyle='rounded'
              borderColor={focusedKey === GIT_ADVANCED_KEY ? ACCENT : 'transparent'}
              onMouseUp={(e: MouseEvent) => {
                if (e.button !== MouseButton.LEFT) return
                e.stopPropagation()
                setFocusByKey(GIT_ADVANCED_KEY)
                setGitAdvanced((v) => !v)
              }}
            >
              <text fg={ACCENT}>{gitAdvanced ? '▾' : '▸'}</text>
              <text fg={FG_HINT} attributes={tuiAttrs({ dim: !gitAdvanced })}>
                Advanced — fine-tune individual steps
              </text>
            </box>
            {gitAdvanced &&
              GIT_FIELDS.map((field) => {
                const on = gitState[field.key] ?? true
                const masterOff = field.key !== 'use_worktree' && (gitState.use_worktree ?? true) === false
                return (
                  <Checkbox
                    key={field.rowKey}
                    rowKey={field.rowKey}
                    label={masterOff ? `${field.label} (no effect — worktree off)` : field.label}
                    state={on ? 'on' : 'off'}
                    focused={focusedKey === field.rowKey}
                    onActivate={() => setGitState((g) => ({ ...g, [field.key]: !(g[field.key] ?? true) }))}
                    onFocus={() => setFocusByKey(field.rowKey)}
                    maxLabelWidth={maxLabelWidth}
                  />
                )
              })}

            <CheckboxGroup
              name='Environments'
              keyPrefix='env'
              items={envItems}
              selection={envDim}
              onChange={setEnvDim}
              focusedKey={focusedKey}
              onFocus={setFocusByKey}
              maxLabelWidth={maxLabelWidth}
              marginTop={1}
            />

            <CheckboxGroup
              name='Components'
              keyPrefix='comp'
              items={compItems}
              selection={compDim}
              onChange={setCompDim}
              focusedKey={focusedKey}
              onFocus={setFocusByKey}
              maxLabelWidth={maxLabelWidth}
              marginTop={1}
            />
          </box>
        </scrollbox>

        <box marginTop={1} flexShrink={0} flexDirection='row' justifyContent='flex-end' gap={2}>
          {renderActionButton('cancel', 'Cancel', onClose)}
          {renderActionButton('apply', 'Apply', applyMain)}
        </box>

        <box marginTop={1} flexShrink={0} flexDirection='row' flexWrap='wrap' gap={0}>
          <text fg={ACCENT} attributes={tuiAttrs({ bold: true })}>
            ↑↓
          </text>
          <text attributes={tuiAttrs({ dim: true })}> move · </text>
          <text fg={ACCENT} attributes={tuiAttrs({ bold: true })}>
            PgUp/PgDn
          </text>
          <text attributes={tuiAttrs({ dim: true })}> scroll · </text>
          <text fg={ACCENT} attributes={tuiAttrs({ bold: true })}>
            Space
          </text>
          <text attributes={tuiAttrs({ dim: true })}> toggle · </text>
          <text fg={ACCENT} attributes={tuiAttrs({ bold: true })}>
            Enter
          </text>
          <text attributes={tuiAttrs({ dim: true })}> activate · Esc close</text>
        </box>
      </box>
    </box>
  ) as ReactElement
}
