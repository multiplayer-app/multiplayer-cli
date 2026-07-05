import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useKeyboard } from '@opentui/react'
import { tuiAttrs } from '../../lib/tuiAttrs.js'
import { copyToClipboard } from '../../lib/clipboard.js'
import { stringFromInputSubmit } from '../../lib/inputSubmit.js'
import { FocusedOutlineButton, InputField } from '../shared/index.js'

interface Props {
  /** The fallback authorization URL to display and copy. */
  url: string
  /** Called with the pasted authorization code when the user submits it. */
  onSubmitCode: (code: string) => void
}

type FocusTarget = 'copy' | 'input'

/**
 * The "browser didn't open" fallback for OAuth: shows the authorization URL,
 * a keyboard-focusable "Copy URL" button, and a field to paste the code back.
 *
 * Fully keyboard-navigable so it works in terminals where mouse clicks aren't
 * delivered: ↑/↓ (or Tab) move focus between the Copy button and the paste
 * field; Enter copies when the button is focused, or submits the code when the
 * field is focused. The input only captures keystrokes while it holds focus, so
 * the arrow/Tab/Enter keys reach this handler when the Copy button is focused.
 */
export function OAuthFallback({ url, onSubmitCode }: Props): ReactElement {
  // Default focus to the input so the common flow (paste the code) needs no
  // extra keypress; the Copy button is one ↑/Tab away.
  const [focus, setFocus] = useState<FocusTarget>('input')
  const [copied, setCopied] = useState(false)
  const [code, setCode] = useState('')
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    }
  }, [])

  const copyUrl = useCallback(() => {
    copyToClipboard(url)
    setCopied(true)
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = setTimeout(() => setCopied(false), 3000)
  }, [url])

  // Only arrows/Tab switch focus — never letter keys, since the paste field
  // captures typed characters (a code containing 'j'/'k' must not move focus).
  useKeyboard((key) => {
    const { name } = key
    if (name === 'up') setFocus('copy')
    else if (name === 'down') setFocus('input')
    else if (name === 'tab') setFocus((f) => (f === 'copy' ? 'input' : 'copy'))
    else if (name === 'return' && focus === 'copy') {
      copyUrl()
      key.stopPropagation()
    }
  })

  return (
    <box flexDirection='column' gap={1}>
      <box flexDirection='column' gap={0}>
        <text attributes={tuiAttrs({ dim: true })}>
          If the browser did not open, visit this URL and copy the code shown:
        </text>
        <text fg='#22d3ee' attributes={tuiAttrs({ underline: true })}>
          {url}
        </text>
      </box>
      {/* Row wrapper so the bordered button hugs its label instead of
          stretching to full width (column children stretch on the cross axis). */}
      <box flexDirection='row'>
        <FocusedOutlineButton
          label={copied ? '✓ URL copied to clipboard' : 'Copy URL'}
          focused={focus === 'copy'}
          onPress={copyUrl}
        />
      </box>
      <text attributes={tuiAttrs({ dim: true })}>Or paste the code here:</text>
      <InputField
        value={code}
        onInput={setCode}
        onSubmit={(p) => onSubmitCode(stringFromInputSubmit(p, code))}
        placeholder='Paste code here…'
        focused={focus === 'input'}
      />
    </box>
  ) as ReactElement
}
