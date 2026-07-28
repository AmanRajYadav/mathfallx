import React from 'react';
import { Delete, Keyboard, Mic, MicOff, TriangleAlert } from 'lucide-react';
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
}

/** Human-readable status line for the microphone. */
function voiceLabel(v: VoiceUiState): { label: string; tone: 'ok' | 'warn' | 'dim' } {
  if (!v.supported) return { label: 'Voice not supported here — use the keypad', tone: 'warn' };
  if (!v.enabled) return { label: 'Tap the mic to answer out loud', tone: 'dim' };
  switch (v.state) {
    case 'denied':
      return { label: 'Microphone blocked — allow it in site settings', tone: 'warn' };
    case 'error':
      return { label: 'Mic trouble — retrying', tone: 'warn' };
    case 'speaking':
      return { label: 'Listening…', tone: 'ok' };
    case 'listening':
    case 'starting':
      return { label: 'Say the answer', tone: 'ok' };
    default:
      return { label: 'Starting mic…', tone: 'dim' };
  }
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'go'];

const Controls: React.FC<ControlsProps> = ({
  bottomRef, voice, onToggleVoice, keypadOpen, onToggleKeypad, input, onKey,
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

        <div className="mf-voice-body">
          <div className="mf-voice-label">Voice</div>
          <div
            className={
              'mf-voice-heard' +
              (showMatch ? ' mf-voice-heard--match'
                : voice.miss !== null ? ' mf-voice-heard--miss'
                : voice.heard ? '' : ' mf-voice-heard--dim')
            }
          >
            {showMatch
              ? `✓ ${voice.lastMatch}`
              : voice.miss !== null
                ? `heard ${voice.miss} — not on screen`
                : voice.heard || label}
          </div>
        </div>

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

      {keypadOpen && (
        <>
          {/* Tapping the entry wipes it — the same job as Space on a keyboard.
              Without it the only way to clear a wrong number on a phone is to
              hit backspace once per digit while blocks keep falling. */}
          <button
            type="button"
            className={`mf-input${input ? '' : ' mf-input--empty'}`}
            onPointerDown={(e) => { e.preventDefault(); if (input) onKey('clear'); }}
            aria-label={input ? `Entry ${input}. Tap to clear.` : 'No entry'}
            aria-live="polite"
          >
            {input || '—'}
            {input && <span className="mf-input-clear">clear</span>}
          </button>
          <div className="mf-keypad">
            {KEYS.map((k) => (
              <button
                key={k}
                type="button"
                className={'mf-key' + (k === 'del' ? ' mf-key--del' : k === 'go' ? ' mf-key--go' : '')}
                onPointerDown={(e) => {
                  // pointerdown, not click: it fires ~100ms sooner, and in a
                  // timed game that gap is the difference between a fast
                  // answer and an average one.
                  e.preventDefault();
                  onKey(k);
                }}
                aria-label={k === 'del' ? 'Delete' : k === 'go' ? 'Submit answer' : k}
              >
                {k === 'del' ? <Delete size={19} /> : k === 'go' ? 'FIRE' : k}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

export default Controls;
