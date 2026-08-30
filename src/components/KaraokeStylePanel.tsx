import {
  Annotation,
  DEFAULT_EMPHASIS_BASE,
  DEFAULT_EMPHASIS_SUNG,
  KaraokeLine,
  KaraokeStyle,
  KaraokeSyllable,
  LyricProject,
  TextAlign,
} from '../types/karaoke';
import { useState } from 'react';
import type { ColorPreset } from '../services/colorPresetService';
import styles from './KaraokeStylePanel.module.css';

interface KaraokeStylePanelProps {
  project: LyricProject;
  /** 0 edits the main lyrics, 1 the romaji row. */
  selectedTrack: number;
  onSelectTrack: (track: number) => void;
  onResetTrackStyle: () => void;
  /** Move or resize the selected track's panel. */
  onPanelChange: (patch: Partial<LyricProject['panel']>) => void;
  selectedLineIndex: number | null;
  /** Every selected word, in the order they are sung. */
  words: KaraokeSyllable[];
  /** The span the selection covers, or null when none of it is timed. */
  wordSpan: { start: number; end: number } | null;
  selectedNoteId: string | null;
  onStyleChange: (patch: Partial<KaraokeStyle>) => void;
  onProjectChange: (patch: Partial<LyricProject>) => void;
  onLineChange: (index: number, patch: Partial<KaraokeLine>) => void;
  /** Change every selected word at once. */
  onWordsPatch: (patch: Partial<KaraokeSyllable>) => void;
  /** Stretch the selection into a new span, keeping its rhythm. */
  onWordsRetime: (start: number, end: number) => void;
  /** Give every selected word an equal share of the span. */
  onWordsSpread: () => void;
  presets: ColorPreset[];
  defaultPresetId: string | null;
  onApplyPreset: (preset: ColorPreset) => void;
  onApplyPresetToWord: (preset: ColorPreset) => void;
  onCreatePreset: (name: string) => string;
  onUpdatePreset: (id: string, patch: Partial<ColorPreset>) => void;
  onDeletePreset: (id: string) => void;
  onSetDefaultPreset: (id: string | null) => void;
  onNoteChange: (id: string, patch: Partial<Annotation>) => void;
  onNoteDelete: (id: string) => void;
  onSelectNote: (id: string | null) => void;
  hasDefaults: boolean;
  onSaveDefaults: () => void;
  onApplyDefaults: () => void;
  onClearDefaults: () => void;
}

/** Fonts that ship with Windows and cover Hangul, plus whatever the user installed. */
const FONT_SUGGESTIONS = [
  'Malgun Gothic',
  'Noto Sans KR',
  'Pretendard',
  'Apple SD Gothic Neo',
  'Segoe UI',
  'Arial',
];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {children}
    </label>
  );
}

function ColorInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <span className={styles.colorRow}>
      <input
        type="color"
        className={styles.colorSwatch}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <input
        type="text"
        className={styles.colorText}
        value={value.toUpperCase()}
        onChange={(e) => {
          const v = e.target.value.trim();
          if (/^#[0-9a-fA-F]{6}$/.test(v)) onChange(v);
        }}
      />
    </span>
  );
}

export function KaraokeStylePanel({
  project,
  selectedTrack,
  onSelectTrack,
  onResetTrackStyle,
  onPanelChange,
  selectedLineIndex,
  words,
  wordSpan,
  selectedNoteId,
  onStyleChange,
  onProjectChange,
  onLineChange,
  onWordsPatch,
  onWordsRetime,
  onWordsSpread,
  presets,
  defaultPresetId,
  onApplyPreset,
  onApplyPresetToWord,
  onCreatePreset,
  onUpdatePreset,
  onDeletePreset,
  onSetDefaultPreset,
  onNoteChange,
  onNoteDelete,
  onSelectNote,
  hasDefaults,
  onSaveDefaults,
  onApplyDefaults,
  onClearDefaults,
}: KaraokeStylePanelProps) {
  const { background, canvas } = project;
  const romajiOn = !!project.romaji?.enabled;
  // The romaji row declares only overrides; everything else is inherited, so a
  // change to the main style still carries to both rows.
  const style: KaraokeStyle =
    selectedTrack === 1
      ? { ...project.style, ...(project.romaji?.style ?? {}) }
      : project.style;
  // Guarded: a project saved before the romaji row existed has no romaji field,
  // and reading through it during render would take the whole panel down.
  const panel =
    selectedTrack === 1 ? project.romaji?.panel ?? project.panel : project.panel;
  const trackLinesList = selectedTrack === 1 ? project.romaji?.lines ?? [] : project.lines;
  const line = selectedLineIndex !== null ? trackLinesList[selectedLineIndex] : null;
  // One value shared by every selected word, or undefined when they disagree —
  // an input showing one word's colour for a mixed selection would lie about
  // what the next edit is going to do.
  const shared = <T,>(read: (w: KaraokeSyllable) => T): T | undefined => {
    if (words.length === 0) return undefined;
    const first = read(words[0]);
    return words.every((w) => read(w) === first) ? first : undefined;
  };
  const mixed = <T,>(read: (w: KaraokeSyllable) => T): boolean =>
    words.length > 1 && shared(read) === undefined;
  const allStruck = words.length > 0 && words.every((w) => w.strike === true);
  const wordLabel =
    words.length === 1
      ? words[0].text.trim()
      : `${words.length} words`;
  const notes = project.annotations ?? [];
  const note = notes.find((n) => n.id === selectedNoteId) ?? null;
  const loadedFamilies = (project.fonts ?? []).map((f) => f.family);
  const [presetName, setPresetName] = useState('');
  // Which preset's colours are open for editing.
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const editingPreset = presets.find((p) => p.id === editingPresetId) ?? null;

  // Line height is stored in pixels, but people think in multiples of the type
  // size, so the control works in multiples and converts.
  const spacingMultiple = style.fontSize > 0
    ? Math.round((style.lineHeight / style.fontSize) * 100) / 100
    : 1;
  const setSpacing = (multiple: number) =>
    onStyleChange({ lineHeight: Math.max(8, Math.round(style.fontSize * multiple)) });

  // Alignment of this row against the other, for the readout below the panel
  // fields. Only meaningful once both rows are in use.
  const otherPanel = selectedTrack === 1 ? project.panel : project.romaji?.panel;
  const otherInUse =
    romajiOn &&
    ((selectedTrack === 1 ? project.lines.length : project.romaji?.lines.length ?? 0) > 0);
  const alignment = otherInUse && otherPanel
    ? {
        left: Math.abs(panel.x - otherPanel.x) < 1,
        centre:
          Math.abs(panel.x + panel.width / 2 - (otherPanel.x + otherPanel.width / 2)) < 1,
        right: Math.abs(panel.x + panel.width - (otherPanel.x + otherPanel.width)) < 1,
        width: Math.abs(panel.width - otherPanel.width) < 1,
      }
    : null;

  return (
    <div className={styles.panel}>
      {romajiOn && (
        <section className={styles.section}>
          <h4 className={styles.heading}>Editing</h4>
          <div className={styles.buttonRow}>
            <button
              className={selectedTrack === 0 ? styles.smallBtnActive : styles.smallBtn}
              onClick={() => onSelectTrack(0)}
            >
              Lyrics
            </button>
            <button
              className={selectedTrack === 1 ? styles.smallBtnActive : styles.smallBtn}
              onClick={() => onSelectTrack(1)}
            >
              Romaji
            </button>
          </div>
          {selectedTrack === 1 && (
            <>
              <p className={styles.muted}>
                Romaji inherits the lyric style. Anything you change here applies to the romaji
                row only.
              </p>
              <div className={styles.buttonRow}>
                <button className={styles.smallBtn} onClick={onResetTrackStyle}>
                  Match the lyrics again
                </button>
              </div>
            </>
          )}
        </section>
      )}

      <section className={styles.section}>
        <h4 className={styles.heading}>Text</h4>
        <Field label="Font">
          <input
            className={styles.input}
            list="karaoke-fonts"
            value={style.fontFamily}
            onChange={(e) => onStyleChange({ fontFamily: e.target.value })}
          />
        </Field>
        {loadedFamilies.length > 0 && (
          <div className={styles.buttonRow}>
            {loadedFamilies.map((f) => (
              <button
                key={f}
                className={style.fontFamily === f ? styles.smallBtnActive : styles.smallBtn}
                onClick={() => onStyleChange({ fontFamily: f })}
                title={`Use ${f}`}
              >
                {f}
              </button>
            ))}
          </div>
        )}
        <datalist id="karaoke-fonts">
          {[...loadedFamilies, ...FONT_SUGGESTIONS].map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>

        <div className={styles.row}>
          <Field label="Size">
            <input
              type="number"
              className={styles.input}
              value={style.fontSize}
              min={8}
              max={400}
              onChange={(e) => onStyleChange({ fontSize: Number(e.target.value) })}
            />
          </Field>
          <Field label="Line height (px)">
            <input
              type="number"
              className={styles.input}
              value={style.lineHeight}
              min={8}
              max={600}
              onChange={(e) => onStyleChange({ lineHeight: Number(e.target.value) })}
            />
          </Field>
        </div>

        <Field label="Line spacing">
          <span className={styles.colorRow}>
            <input
              type="number"
              className={styles.input}
              value={spacingMultiple}
              min={0.5}
              max={4}
              step={0.05}
              onChange={(e) => setSpacing(Number(e.target.value))}
            />
            <span className={styles.spacingPresets}>
              {[1, 1.15, 1.5, 2].map((m) => (
                <button
                  key={m}
                  className={
                    Math.abs(spacingMultiple - m) < 0.02 ? styles.smallBtnActive : styles.smallBtn
                  }
                  onClick={() => setSpacing(m)}
                  title={`${m}x the type size`}
                >
                  {m.toFixed(m === 1.15 ? 2 : 1)}
                </button>
              ))}
            </span>
          </span>
        </Field>
        <p className={styles.muted}>
          A multiple of the type size, like a word processor. Changing the size keeps the
          spacing proportional.
        </p>

        <div className={styles.row}>
          <Field label="Tracking">
            <input
              type="number"
              className={styles.input}
              value={style.letterSpacing}
              step={0.5}
              onChange={(e) => onStyleChange({ letterSpacing: Number(e.target.value) })}
            />
          </Field>
          <Field label="Align">
            <select
              className={styles.input}
              value={style.align}
              onChange={(e) => onStyleChange({ align: e.target.value as TextAlign })}
            >
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </Field>
        </div>

        <div className={styles.row}>
          <Field label="Width %">
            <input
              type="number"
              className={styles.input}
              value={style.scaleX ?? 100}
              min={10}
              max={400}
              onChange={(e) => onStyleChange({ scaleX: Number(e.target.value) })}
            />
          </Field>
          <Field label="Height %">
            <input
              type="number"
              className={styles.input}
              value={style.scaleY ?? 100}
              min={10}
              max={400}
              onChange={(e) => onStyleChange({ scaleY: Number(e.target.value) })}
            />
          </Field>
        </div>

        <div className={styles.toggles}>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={style.bold}
              onChange={(e) => onStyleChange({ bold: e.target.checked })}
            />
            Bold
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={style.italic}
              onChange={(e) => onStyleChange({ italic: e.target.checked })}
            />
            Italic
          </label>
          <button
            className={styles.smallBtn}
            onClick={() => onStyleChange({ scaleX: 100, scaleY: 100 })}
            title="Reset the squish/stretch back to 100%"
          >
            Reset scale
          </button>
        </div>
      </section>

      <section className={styles.section}>
        <h4 className={styles.heading}>Default look</h4>
        <p className={styles.muted}>
          Fonts, sizes, colours, spacing, panel positions and the show/hide timing — everything
          about how a project looks, and nothing about its words.
        </p>
        <div className={styles.buttonRow}>
          <button className={styles.smallBtn} onClick={onSaveDefaults}>
            Save this as default
          </button>
          <button className={styles.smallBtn} onClick={onApplyDefaults} disabled={!hasDefaults}>
            Apply to this project
          </button>
        </div>
        {hasDefaults && (
          <div className={styles.buttonRow}>
            <button className={styles.smallBtn} onClick={onClearDefaults}>
              Forget saved default
            </button>
          </div>
        )}
      </section>

      <section className={styles.section}>
        <h4 className={styles.heading}>Colour presets</h4>
        {presets.length === 0 ? (
          <p className={styles.muted}>Save the colours below to reuse them in other projects.</p>
        ) : (
          <ul className={styles.presetList}>
            {presets.map((preset) => (
              <li key={preset.id} className={styles.presetItem}>
                <button
                  className={styles.presetSwatch}
                  onClick={() => onApplyPreset(preset)}
                  title={`Apply "${preset.name}" to this row`}
                >
                  <span
                    className={styles.swatchHalf}
                    style={{ background: preset.baseColor, opacity: preset.baseAlpha / 100 }}
                  />
                  <span
                    className={styles.swatchHalf}
                    style={{ background: preset.sungColor, opacity: preset.sungAlpha / 100 }}
                  />
                </button>
                <span className={styles.presetName} title={preset.name}>
                  {preset.name}
                  {preset.id === defaultPresetId && (
                    <span className={styles.presetDefault}> · default</span>
                  )}
                </span>
                <button
                  className={styles.presetAction}
                  onClick={() => onApplyPresetToWord(preset)}
                  disabled={words.length === 0}
                  title="Apply to the selected words only"
                >
                  {words.length > 1 ? 'words' : 'word'}
                </button>
                <button
                  className={styles.presetAction}
                  onClick={() =>
                    onSetDefaultPreset(preset.id === defaultPresetId ? null : preset.id)
                  }
                  title={
                    preset.id === defaultPresetId
                      ? 'Stop using this for new projects'
                      : 'Use this for new projects'
                  }
                >
                  {preset.id === defaultPresetId ? '★' : '☆'}
                </button>
                <button
                  className={styles.presetAction}
                  onClick={() =>
                    setEditingPresetId(editingPresetId === preset.id ? null : preset.id)
                  }
                  title="Edit this preset's colours"
                >
                  ✎
                </button>
                <button
                  className={styles.presetAction}
                  onClick={() => onDeletePreset(preset.id)}
                  title="Delete this preset"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className={styles.buttonRow}>
          <input
            className={styles.input}
            placeholder="Name a new preset…"
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && presetName.trim()) {
                setEditingPresetId(onCreatePreset(presetName));
                setPresetName('');
              }
            }}
          />
          <button
            className={styles.smallBtn}
            disabled={!presetName.trim()}
            onClick={() => {
              setEditingPresetId(onCreatePreset(presetName));
              setPresetName('');
            }}
          >
            Create
          </button>
        </div>

        {editingPreset && (
          <div className={styles.presetEditor}>
            <div className={styles.presetEditorHead}>
              <input
                className={styles.input}
                value={editingPreset.name}
                onChange={(e) => onUpdatePreset(editingPreset.id, { name: e.target.value })}
              />
              <button className={styles.smallBtn} onClick={() => setEditingPresetId(null)}>
                Done
              </button>
            </div>
            <Field label="Before sung">
              <ColorInput
                value={editingPreset.baseColor}
                onChange={(v) => onUpdatePreset(editingPreset.id, { baseColor: v })}
              />
            </Field>
            <Field label="After sung">
              <ColorInput
                value={editingPreset.sungColor}
                onChange={(v) => onUpdatePreset(editingPreset.id, { sungColor: v })}
              />
            </Field>
            <div className={styles.row}>
              <Field label="Opacity before %">
                <input
                  type="number"
                  className={styles.input}
                  value={editingPreset.baseAlpha}
                  min={0}
                  max={100}
                  onChange={(e) =>
                    onUpdatePreset(editingPreset.id, { baseAlpha: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="Opacity after %">
                <input
                  type="number"
                  className={styles.input}
                  value={editingPreset.sungAlpha}
                  min={0}
                  max={100}
                  onChange={(e) =>
                    onUpdatePreset(editingPreset.id, { sungAlpha: Number(e.target.value) })
                  }
                />
              </Field>
            </div>
            <div className={styles.buttonRow}>
              <button
                className={styles.smallBtn}
                onClick={() =>
                  onUpdatePreset(editingPreset.id, {
                    baseColor: style.baseColor,
                    sungColor: style.sungColor,
                    baseAlpha: style.baseAlpha ?? 100,
                    sungAlpha: style.sungAlpha ?? 100,
                  })
                }
                title="Copy the colours this row is using right now"
              >
                Take from current row
              </button>
            </div>
          </div>
        )}
      </section>

      <section className={styles.section}>
        <h4 className={styles.heading}>Colours</h4>
        <Field label="Before sung">
          <ColorInput value={style.baseColor} onChange={(v) => onStyleChange({ baseColor: v })} />
        </Field>
        <Field label="After sung">
          <ColorInput value={style.sungColor} onChange={(v) => onStyleChange({ sungColor: v })} />
        </Field>

        <div className={styles.row}>
          <Field label="Opacity before %">
            <input
              type="number"
              className={styles.input}
              value={style.baseAlpha ?? 100}
              min={0}
              max={100}
              onChange={(e) => onStyleChange({ baseAlpha: Number(e.target.value) })}
            />
          </Field>
          <Field label="Opacity after %">
            <input
              type="number"
              className={styles.input}
              value={style.sungAlpha ?? 100}
              min={0}
              max={100}
              onChange={(e) => onStyleChange({ sungAlpha: Number(e.target.value) })}
            />
          </Field>
        </div>
        <div className={styles.buttonRow}>
          <button
            className={styles.smallBtn}
            onClick={() => onStyleChange({ baseAlpha: 50, sungAlpha: 100 })}
            title="Ghosted until sung, then solid"
          >
            Fade in 50 → 100
          </button>
          <button
            className={styles.smallBtn}
            onClick={() => onStyleChange({ baseAlpha: 100, sungAlpha: 50 })}
            title="Solid until sung, then dimmed"
          >
            Fade out 100 → 50
          </button>
        </div>

        <div className={styles.row}>
          <Field label="Strike thickness">
            <input
              type="number"
              className={styles.input}
              value={Math.round((style.strikeThickness ?? 0.055) * 100)}
              min={1}
              max={30}
              onChange={(e) =>
                onStyleChange({ strikeThickness: Math.max(0.01, Number(e.target.value) / 100) })
              }
            />
          </Field>
          <Field label="Strike height">
            <input
              type="number"
              className={styles.input}
              value={Math.round((style.strikeHeight ?? 0.5) * 100)}
              min={0}
              max={120}
              onChange={(e) => onStyleChange({ strikeHeight: Number(e.target.value) / 100 })}
            />
          </Field>
        </div>
        <p className={styles.muted}>
          Both are percentages of the type size. Height 0 sits at the top of the glyphs, 100 on
          the baseline.
        </p>

        <div className={styles.row}>
          <Field label="Outline">
            <input
              type="number"
              className={styles.input}
              value={style.outlineWidth}
              min={0}
              step={0.5}
              onChange={(e) => onStyleChange({ outlineWidth: Number(e.target.value) })}
            />
          </Field>
          <Field label="Outline colour">
            <ColorInput
              value={style.outlineColor}
              onChange={(v) => onStyleChange({ outlineColor: v })}
            />
          </Field>
        </div>

        <div className={styles.row}>
          <Field label="Shadow">
            <input
              type="number"
              className={styles.input}
              value={style.shadowOffset}
              min={0}
              step={0.5}
              onChange={(e) => onStyleChange({ shadowOffset: Number(e.target.value) })}
            />
          </Field>
          <Field label="Shadow colour">
            <ColorInput
              value={style.shadowColor}
              onChange={(v) => onStyleChange({ shadowColor: v })}
            />
          </Field>
        </div>
      </section>

      <section className={styles.section}>
        <h4 className={styles.heading}>
          {words.length > 1 ? 'Selected words' : 'Selected word'}
          {words.length > 0 ? <span className={styles.badge}>{wordLabel}</span> : null}
        </h4>
        {words.length > 0 ? (
          <>
            <Field label="Before sung">
              <ColorInput
                value={shared((w) => w.baseColor) ?? line?.baseColor ?? style.baseColor}
                onChange={(v) => onWordsPatch({ baseColor: v })}
              />
            </Field>
            <Field label="After sung">
              <ColorInput
                value={shared((w) => w.sungColor) ?? line?.sungColor ?? style.sungColor}
                onChange={(v) => onWordsPatch({ sungColor: v })}
              />
            </Field>
            {(mixed((w) => w.baseColor) || mixed((w) => w.sungColor)) && (
              <p className={styles.muted}>
                These words don’t all share a colour — picking one sets them all.
              </p>
            )}
            <div className={styles.buttonRow}>
              <button
                className={styles.smallBtn}
                onClick={() =>
                  onWordsPatch({
                    baseColor: DEFAULT_EMPHASIS_BASE,
                    sungColor: DEFAULT_EMPHASIS_SUNG,
                  })
                }
              >
                Pink emphasis
              </button>
              <button
                className={styles.smallBtn}
                onClick={() => onWordsPatch({ baseColor: undefined, sungColor: undefined })}
              >
                Clear
              </button>
            </div>
            <div className={styles.row}>
              <Field label="Opacity before %">
                <input
                  type="number"
                  className={styles.input}
                  placeholder={
                    mixed((w) => w.baseAlpha) ? 'mixed' : String(style.baseAlpha ?? 100)
                  }
                  value={shared((w) => w.baseAlpha) ?? ''}
                  min={0}
                  max={100}
                  onChange={(e) =>
                    onWordsPatch({
                      baseAlpha: e.target.value === '' ? undefined : Number(e.target.value),
                    })
                  }
                />
              </Field>
              <Field label="Opacity after %">
                <input
                  type="number"
                  className={styles.input}
                  placeholder={
                    mixed((w) => w.sungAlpha) ? 'mixed' : String(style.sungAlpha ?? 100)
                  }
                  value={shared((w) => w.sungAlpha) ?? ''}
                  min={0}
                  max={100}
                  onChange={(e) =>
                    onWordsPatch({
                      sungAlpha: e.target.value === '' ? undefined : Number(e.target.value),
                    })
                  }
                />
              </Field>
            </div>
            <div className={styles.buttonRow}>
              <button
                className={allStruck ? styles.smallBtnActive : styles.smallBtn}
                onClick={() => onWordsPatch({ strike: !allStruck })}
              >
                <s>Strikethrough</s>
              </button>
            </div>

            {wordSpan && (
              <>
                <div className={styles.row}>
                  <Field label="Starts at (s)">
                    <input
                      type="number"
                      className={styles.input}
                      value={Number(wordSpan.start.toFixed(2))}
                      step={0.05}
                      min={0}
                      onChange={(e) => onWordsRetime(Number(e.target.value), wordSpan.end)}
                    />
                  </Field>
                  <Field label="Ends at (s)">
                    <input
                      type="number"
                      className={styles.input}
                      value={Number(wordSpan.end.toFixed(2))}
                      step={0.05}
                      min={0}
                      onChange={(e) => onWordsRetime(wordSpan.start, Number(e.target.value))}
                    />
                  </Field>
                </div>
                <p className={styles.muted}>
                  Moving these keeps the rhythm inside the selection — every word
                  keeps its share. Arrow keys nudge it without stretching.
                </p>
                {words.length > 1 && (
                  <div className={styles.buttonRow}>
                    <button className={styles.smallBtn} onClick={onWordsSpread}>
                      Even out timings
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          <p className={styles.muted}>
            Click a word on the preview, or drag a box round several on the
            timeline, to recolour or retime just those.
          </p>
        )}
      </section>

      <section className={styles.section}>
        <h4 className={styles.heading}>Text boxes</h4>
        {notes.length === 0 ? (
          <p className={styles.muted}>
            Use “+ Text box” on the Lyrics tab for a shout cue or note above a line.
          </p>
        ) : (
          <ul className={styles.noteList}>
            {notes.map((n) => (
              <li
                key={n.id}
                className={n.id === selectedNoteId ? styles.noteItemActive : styles.noteItem}
                onClick={() => onSelectNote(n.id)}
              >
                {n.text || '(empty)'}
              </li>
            ))}
          </ul>
        )}

        {note && (
          <>
            <Field label="Text">
              <input
                className={styles.input}
                value={note.text}
                onChange={(e) => onNoteChange(note.id, { text: e.target.value })}
              />
            </Field>
            <Field label="Size">
              <input
                type="number"
                className={styles.input}
                value={note.fontSize}
                min={6}
                onChange={(e) => onNoteChange(note.id, { fontSize: Number(e.target.value) })}
              />
            </Field>

            <Field label="Before sung">
              <ColorInput
                value={note.color}
                onChange={(v) => onNoteChange(note.id, { color: v })}
              />
            </Field>
            <Field label="After sung">
              <span className={styles.colorRow}>
                <ColorInput
                  value={note.sungColor ?? note.color}
                  onChange={(v) => onNoteChange(note.id, { sungColor: v })}
                />
              </span>
            </Field>
            <div className={styles.row}>
              <Field label="Opacity before %">
                <input
                  type="number"
                  className={styles.input}
                  value={note.alpha ?? 100}
                  min={0}
                  max={100}
                  onChange={(e) => onNoteChange(note.id, { alpha: Number(e.target.value) })}
                />
              </Field>
              <Field label="Opacity after %">
                <input
                  type="number"
                  className={styles.input}
                  value={note.sungAlpha ?? note.alpha ?? 100}
                  min={0}
                  max={100}
                  onChange={(e) => onNoteChange(note.id, { sungAlpha: Number(e.target.value) })}
                />
              </Field>
            </div>
            <div className={styles.buttonRow}>
              <button
                className={styles.smallBtn}
                onClick={() =>
                  onNoteChange(note.id, {
                    color: style.baseColor,
                    sungColor: style.sungColor,
                    alpha: style.baseAlpha ?? 100,
                    sungAlpha: style.sungAlpha ?? 100,
                  })
                }
                title="Use the same colours as the lyrics"
              >
                Match the lyrics
              </button>
              <button
                className={styles.smallBtn}
                onClick={() => onNoteChange(note.id, { sungColor: undefined })}
                disabled={!note.sungColor}
                title="Keep one colour throughout instead of filling in"
              >
                No fill
              </button>
            </div>
            <p className={styles.muted}>
              With an after colour set, the box fills across its span on the lane — drag its
              block there to set how long it takes.
            </p>
            <div className={styles.row}>
              <Field label="X">
                <input
                  type="number"
                  className={styles.input}
                  value={note.x}
                  onChange={(e) => onNoteChange(note.id, { x: Number(e.target.value) })}
                />
              </Field>
              <Field label="Y">
                <input
                  type="number"
                  className={styles.input}
                  value={note.y}
                  onChange={(e) => onNoteChange(note.id, { y: Number(e.target.value) })}
                />
              </Field>
            </div>
            <div className={styles.row}>
              <Field label="Outline">
                <input
                  type="number"
                  className={styles.input}
                  value={note.outlineWidth}
                  min={0}
                  step={0.5}
                  onChange={(e) =>
                    onNoteChange(note.id, { outlineWidth: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="Align">
                <select
                  className={styles.input}
                  value={note.align}
                  onChange={(e) => onNoteChange(note.id, { align: e.target.value as TextAlign })}
                >
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                  <option value="right">Right</option>
                </select>
              </Field>
            </div>
            <div className={styles.buttonRow}>
              <button className={styles.smallBtn} onClick={() => onNoteDelete(note.id)}>
                Delete text box
              </button>
            </div>
          </>
        )}
      </section>

      {line && selectedLineIndex !== null && (
        <section className={styles.section}>
          <h4 className={styles.heading}>Selected line</h4>
          <div className={styles.row}>
            <Field label="Size override">
              <input
                type="number"
                className={styles.input}
                placeholder={String(style.fontSize)}
                value={line.fontSize ?? ''}
                onChange={(e) =>
                  onLineChange(selectedLineIndex, {
                    fontSize: e.target.value === '' ? undefined : Number(e.target.value),
                  })
                }
              />
            </Field>
            <Field label="Nudge X / Y">
              <span className={styles.colorRow}>
                <input
                  type="number"
                  className={styles.input}
                  value={line.offsetX}
                  onChange={(e) =>
                    onLineChange(selectedLineIndex, { offsetX: Number(e.target.value) })
                  }
                />
                <input
                  type="number"
                  className={styles.input}
                  value={line.offsetY}
                  onChange={(e) =>
                    onLineChange(selectedLineIndex, { offsetY: Number(e.target.value) })
                  }
                />
              </span>
            </Field>
          </div>
        </section>
      )}

      <section className={styles.section}>
        <h4 className={styles.heading}>Sweep</h4>
        <Field label="Behaviour">
          <select
            className={styles.input}
            value={style.sweepMode}
            onChange={(e) =>
              onStyleChange({ sweepMode: e.target.value as KaraokeStyle['sweepMode'] })
            }
          >
            <option value="continuous">Continuous — glide into the next word</option>
            <option value="hold">Hold — finish, then wait</option>
          </select>
        </Field>
      </section>

      <section className={styles.section}>
        <h4 className={styles.heading}>Canvas</h4>
        <div className={styles.buttonRow}>
          {([
            ['1080p', 1920, 1080],
            ['1440p', 2560, 1440],
            ['4K', 3840, 2160],
          ] as const).map(([label, w, h]) => {
            const active = canvas.width === w && canvas.height === h;
            return (
              <button
                key={label}
                className={active ? styles.smallBtnActive : styles.smallBtn}
                title={`Render at ${w}x${h}. Text and layout scale with the canvas.`}
                onClick={() => {
                  // Scale everything expressed in canvas pixels, so the whole
                  // composition survives the change of resolution instead of
                  // shrinking into a corner. Both lyric rows must be scaled:
                  // missing one leaves it stranded at the old size.
                  const factor = w / Math.max(1, canvas.width);
                  if (factor === 1) return;

                  const scaleRect = <T extends { x: number; y: number; width: number; height: number }>(
                    r: T
                  ): T => ({
                    ...r,
                    x: Math.round(r.x * factor),
                    y: Math.round(r.y * factor),
                    width: Math.round(r.width * factor),
                    height: Math.round(r.height * factor),
                  });
                  // Only the fields that are in pixels; colours and modes are
                  // resolution independent and must be left alone.
                  const scaleStyle = <T extends Partial<KaraokeStyle>>(st: T): T => ({
                    ...st,
                    ...(st.fontSize !== undefined
                      ? { fontSize: Math.max(6, Math.round(st.fontSize * factor)) }
                      : {}),
                    ...(st.lineHeight !== undefined
                      ? { lineHeight: Math.max(6, Math.round(st.lineHeight * factor)) }
                      : {}),
                    ...(st.outlineWidth !== undefined
                      ? { outlineWidth: Math.round(st.outlineWidth * factor * 10) / 10 }
                      : {}),
                    ...(st.shadowOffset !== undefined
                      ? { shadowOffset: Math.round(st.shadowOffset * factor * 10) / 10 }
                      : {}),
                  });

                  onProjectChange({
                    canvas: { ...canvas, width: w, height: h },
                    background: scaleRect(background),
                    panel: scaleRect(project.panel),
                    style: scaleStyle(project.style),
                    romaji: {
                      ...project.romaji,
                      panel: scaleRect(project.romaji.panel),
                      style: scaleStyle(project.romaji.style),
                    },
                  });
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div className={styles.row}>
          <Field label="Width">
            <input
              type="number"
              className={styles.input}
              value={canvas.width}
              step={2}
              onChange={(e) =>
                onProjectChange({ canvas: { ...canvas, width: Number(e.target.value) } })
              }
            />
          </Field>
          <Field label="Height">
            <input
              type="number"
              className={styles.input}
              value={canvas.height}
              step={2}
              onChange={(e) =>
                onProjectChange({ canvas: { ...canvas, height: Number(e.target.value) } })
              }
            />
          </Field>
        </div>
        <div className={styles.row}>
          <Field label="FPS">
            <input
              type="number"
              className={styles.input}
              value={canvas.fps}
              min={1}
              max={120}
              onChange={(e) =>
                onProjectChange({ canvas: { ...canvas, fps: Number(e.target.value) } })
              }
            />
          </Field>
          <Field label="Background">
            <ColorInput
              value={background.color}
              onChange={(v) => onProjectChange({ background: { ...background, color: v } })}
            />
          </Field>
        </div>
      </section>

      <section className={styles.section}>
        <h4 className={styles.heading}>Text block</h4>
        <div className={styles.buttonRow}>
          <button
            className={panel.lockX ? styles.smallBtnActive : styles.smallBtn}
            onClick={() => onPanelChange({ lockX: !panel.lockX })}
            title="Pin the horizontal position so dragging cannot change it"
          >
            {panel.lockX ? '🔒 X' : '🔓 X'}
          </button>
          <button
            className={panel.lockY ? styles.smallBtnActive : styles.smallBtn}
            onClick={() => onPanelChange({ lockY: !panel.lockY })}
            title="Pin the vertical position so dragging cannot change it"
          >
            {panel.lockY ? '🔒 Y' : '🔓 Y'}
          </button>
        </div>
        <div className={styles.buttonRow}>
          <button
            className={styles.smallBtn}
            onClick={() => onPanelChange({ x: Math.round((canvas.width - panel.width) / 2) })}
            title="Centre the block horizontally on the canvas"
          >
            Centre ↔
          </button>
          <button
            className={styles.smallBtn}
            onClick={() => onPanelChange({ y: Math.round((canvas.height - panel.height) / 2) })}
            title="Centre the block vertically on the canvas"
          >
            Centre ↕
          </button>
          <button
            className={styles.smallBtn}
            onClick={() =>
              onPanelChange({
                x: Math.round((canvas.width - panel.width) / 2),
                y: Math.round((canvas.height - panel.height) / 2),
              })
            }
            title="Centre both ways"
          >
            Both
          </button>
        </div>
        <div className={styles.row}>
          <Field label="X">
            <input
              type="number"
              className={styles.input}
              value={panel.x}
              onChange={(e) => onPanelChange({ x: Number(e.target.value) })}
            />
          </Field>
          <Field label="Y">
            <input
              type="number"
              className={styles.input}
              value={panel.y}
              onChange={(e) => onPanelChange({ y: Number(e.target.value) })}
            />
          </Field>
        </div>
        {alignment && (
          <div className={styles.alignRow}>
            <span
              className={
                alignment.left || alignment.centre || alignment.right
                  ? styles.alignOk
                  : styles.alignOff
              }
            >
              {alignment.centre
                ? '✓ centred with the other row'
                : alignment.left && alignment.right
                  ? '✓ aligned both edges'
                  : alignment.left
                    ? '✓ left edges aligned'
                    : alignment.right
                      ? '✓ right edges aligned'
                      : '• not aligned with the other row'}
            </span>
            <button
              className={styles.smallBtn}
              onClick={() =>
                onPanelChange({ x: otherPanel!.x, width: otherPanel!.width })
              }
              title="Match the other row's horizontal position and width"
            >
              Align to other row
            </button>
          </div>
        )}

        <div className={styles.row}>
          <Field label="Width">
            <input
              type="number"
              className={styles.input}
              value={panel.width}
              onChange={(e) =>
                onPanelChange({ width: Number(e.target.value) })
              }
            />
          </Field>
          <Field label="Height">
            <input
              type="number"
              className={styles.input}
              value={panel.height}
              onChange={(e) =>
                onPanelChange({ height: Number(e.target.value) })
              }
            />
          </Field>
        </div>
      </section>
    </div>
  );
}
