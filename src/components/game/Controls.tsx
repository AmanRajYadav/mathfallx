import React from 'react';
import { Delete, Home, Keyboard, Mic, MicOff, Pause, TriangleAlert } from 'lucide-react';
import type { RecognizerState } from '../../voice/VoiceInput';

export interface VoiceUiState {
  supported: boolean;
  enabled: boolean;
  state: RecognizerState;
  heard: string;
  lastMatch: number | null;
  lastMatchAt: number;
  /** A number that was understood but is not on screen. Cleared on a timer. */
  miss: number | null;
}

interface ControlsProps {
  bottomRef: React.RefObject<HTMLDivElement>;
  voice: VoiceUiState;
  onToggleVoice: () => void;
  keypadOpen: boolean;
  onToggleKeypad: () => void;
  input: string;
  onKey: (k: string) => void;
  onPause: () => void;
  onMenu: () => void;
}

/** Human-readable status line for the microphone. */
function voiceLabel(v: VoiceUiState): { label: string; tone: 'ok' | 'warn' | 'dim' } {
  if (!v.supported) return { label: 'Voice not supported here — use the keypad', tone: 'warn' };
  if (!v.enabled) return { label: 'Tap the mic to answer out loud', tone: 'dim' };
  switch (v.state) {
    // Kept short: the row is one line on a phone and a longer sentence just
    // ellipsises away the part that tells you what to do.
    case 'denied':
      return { label: 'Mic blocked — allow, then tap to retry', tone: 'warn' };
    case 'error':
      return { label: 'Mic problem — tap to retry', tone: 'warn' };
    case 'speaking':
      return { label: 'Listening…', tone: 'ok' };
    case 'listening':
    case 'starting':
      return { label: 'Say the answer', tone: 'ok' };
    default:
      return { label: 'Starting mic…', tone: 'dim' };
  }
}

/**
 * Two rows, not four.
 *
 * A phone-style 3x4 pad ate roughly a third of the viewport, and in a game
 * where the whole task is reading falling text, vertical space *is* reaction
 * time. Six columns keeps every key a comfortable width on a 360px screen
 * while costing barely 100px of height. Digits are laid out in reading order
 * so they stay findable without looking.
 *
 * No submit key. An entry fires the instant its digits match something on
 * screen, so there was never anything left for FIRE to do — it just sat there
 * taking up a slot and implying a step that does not exist.
 */
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'del'];

const Controls: React.FC<ControlsProps> = ({
  bottomRef, voice, onToggleVoice, keypadOpen, onToggleKeypad, input, onKey,
  onPause, onMenu,
}) => {
  const { label, tone } = voiceLabel(voice);
  const showMatch = voice.lastMatch !== null && Date.now() - voice.lastMatchAt < 1100;

  const micState: string = !voice.supported ? 'unsupported' : !voice.enabled ? 'off' : voice.state;

  return (
    <div className="mf-bottom" ref={bottomRef}>
      <div className="mf-voice">
        <button
          type="button"
          className="mf-mic"
          data-state={micState}
          onClick={onToggleVoice}
          aria-pressed={voice.enabled}
          aria-label={voice.enabled ? 'Turn off voice input' : 'Turn on voice input'}
        >
          {!voice.supported ? <TriangleAlert size={21} /> : voice.enabled ? <Mic size={21} /> : <MicOff size={21} />}
        </button>

        {/* The typed entry lives in this row rather than owning one of its own.
            A separate input bar cost ~50px of board on a phone, and the two are
            never really needed at once — you are either typing or speaking. */}
        {input ? (
          <button
            type="button"
            className="mf-voice-body mf-voice-body--entry"
            onPointerDown={(e) => { e.preventDefault(); onKey('clear'); }}
            aria-label={`Entry ${input}. Tap to clear.`}
          >
            <div className="mf-voice-label">Entry · tap to clear</div>
            <div className="mf-entry">{input}</div>
          </button>
        ) : (
          <div className="mf-voice-body">
            <div className="mf-voice-label">Voice</div>
            <div
              className={
                'mf-voice-heard' +
                (showMatch ? ' mf-voice-heard--match'
                  : voice.miss !== null ? ' mf-voice-heard--miss'
                  : voice.heard ? '' : ' mf-voice-heard--dim')
              }
              aria-live="polite"
            >
              {showMatch
                ? `✓ ${voice.lastMatch}`
                : voice.miss !== null
                  ? `heard ${voice.miss} — not on screen`
                  : voice.heard || label}
            </div>
          </div>
        )}

        <button
          type="button"
          className="mf-kbd-toggle"
          data-on={keypadOpen}
          onClick={onToggleKeypad}
          aria-pressed={keypadOpen}
          aria-label={keypadOpen ? 'Hide keypad' : 'Show keypad'}
        >
          <Keyboard size={20} />
        </button>
      </div>

      {/* Installed to the home screen there is no browser chrome at all, so
          without these there is literally no way out of a run. */}
      <div className="mf-nav">
        <button type="button" className="mf-nav-btn" onPointerDown={(e) => { e.preventDefault(); onPause(); }}>
          <Pause size={14} /> Pause
        </button>
        <button type="button" className="mf-nav-btn" onPointerDown={(e) => { e.preventDefault(); onMenu(); }}>
          <Home size={14} /> Menu
        </button>
      </div>

      {keypadOpen && (
        <>
          <div className="mf-keypad">
            {KEYS.map((k) => (
              <button
                key={k}
                type="button"
                className={'mf-key' + (k === 'del' ? ' mf-key--del' : '')}
                onPointerDown={(e) => {
                  // pointerdown, not click: it fires ~100ms sooner, and in a
                  // timed game that gap is the difference between a fast
                  // answer and an average one.
                  e.preventDefault();
                  onKey(k);
                }}
                aria-label={k === 'del' ? 'Delete' : k}
              >
                {k === 'del' ? <Delete size={19} /> : k}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

export default Controls;
