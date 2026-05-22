import { useState, type ReactElement } from 'react'
import type { AgentConfig } from '../../types/index.js'
import { ProjectTypeStep, type FlowChoice } from '../startup/ProjectTypeStep.js'
import { SetupShell } from '../startup/SetupShell.js'
import { DemoSetupFlow } from '../startup/flows/DemoSetupFlow.js'
import { RegularSetupFlow } from '../startup/flows/RegularSetupFlow.js'

/**
 * Top-level router for the setup wizard.
 *
 * Renders ProjectTypeStep first; once the user picks a path, dispatches to
 * either DemoSetupFlow or RegularSetupFlow. Each flow owns its own step list,
 * routing, persistence, and side effects — there is intentionally no shared
 * step-state between them. Esc at the first step of either flow returns here.
 */

type FlowState =
  | { kind: 'choosing' }
  | { kind: 'demo'; initialConfig: Partial<AgentConfig>; account?: string }
  | { kind: 'regular'; initialConfig: Partial<AgentConfig>; account?: string }

interface Props {
  initialConfig: Partial<AgentConfig>
  profileName?: string
  authErrorMessage?: string | null
  onComplete: (config: AgentConfig) => void
}

export function StartupScreen({
  initialConfig,
  profileName,
  authErrorMessage,
  onComplete,
}: Props): ReactElement | null {
  // If the caller already supplied enough config to skip ProjectTypeStep (e.g.
  // via env vars / re-auth after a token expiry), drop the user straight into
  // the matching flow. Otherwise begin at the type selection.
  const [flow, setFlow] = useState<FlowState>(() => {
    if (initialConfig.isDemoProject || initialConfig.demoSetupDone) {
      return { kind: 'demo', initialConfig, account: profileName }
    }
    if (initialConfig.apiKey || initialConfig.dir || initialConfig.workspace) {
      return { kind: 'regular', initialConfig, account: profileName }
    }
    return { kind: 'choosing' }
  })

  const handleTypeSelected = (choice: FlowChoice) => {
    // Merge over the parent's initialConfig so environment-level fields the
    // recent-project profile may not carry (e.g. CLI/env --url) survive into
    // the flow. Filter undefined values from `choice.updates` so a profile
    // that doesn't store `url` doesn't shadow the CLI-provided one.
    const definedUpdates: Partial<AgentConfig> = {}
    for (const [k, v] of Object.entries(choice.updates) as [keyof AgentConfig, unknown][]) {
      if (v !== undefined) (definedUpdates as Record<string, unknown>)[k] = v
    }
    setFlow({
      kind: choice.kind,
      initialConfig: { ...initialConfig, ...definedUpdates },
      account: choice.accountName,
    })
  }

  const handleBackToTypeSelection = () => {
    setFlow({ kind: 'choosing' })
  }

  if (flow.kind === 'demo') {
    return (
      <DemoSetupFlow
        initialConfig={flow.initialConfig}
        profileName={profileName}
        initialAccount={flow.account}
        authErrorMessage={authErrorMessage}
        onComplete={onComplete}
        onBackToTypeSelection={handleBackToTypeSelection}
      />
    ) as ReactElement
  }

  if (flow.kind === 'regular') {
    return (
      <RegularSetupFlow
        initialConfig={flow.initialConfig}
        profileName={profileName}
        initialAccount={flow.account}
        authErrorMessage={authErrorMessage}
        onComplete={onComplete}
        onBackToTypeSelection={handleBackToTypeSelection}
      />
    ) as ReactElement
  }

  return (
    <SetupShell
      title='Setup a project'
      description='Choose how you want to get started with Multiplayer.'
      config={{}}
      account={profileName ?? 'default'}
      sidebar={[]}
      showSummary={false}
    >
      <ProjectTypeStep onComplete={handleTypeSelected} />
    </SetupShell>
  ) as ReactElement
}
