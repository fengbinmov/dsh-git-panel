/**
 * The Changes panel: the pending and staged sides of the index boundary,
 * multi-select with drag-and-drop staging between them, hand-draggable dividers
 * that size the two independently, the per-row stage-unstage-discard controls,
 * and the commit box. It is a pure props component — every git verb is injected
 * by the view root.
 *
 * Selection follows the file-manager convention: a plain click selects one row,
 * Ctrl/Cmd+click toggles a row, Shift+click extends from the anchor across the
 * flattened row order (which may span groups). Dragging then moves the whole
 * selection in one gesture.
 *
 * There are exactly TWO groups, one per side of the index: everything not staged
 * (untracked files, worktree modifications, unresolved conflicts) and everything
 * the index holds. Splitting the pending side further produced regions that came
 * and went as work was staged, and hid a path whose index side and worktree side
 * had both moved. The row badge ('?', 'M', 'U', …) tells the kinds apart.
 *
 * The groups SPLIT the list between them: each carries a unitless share and the
 * list is a flex column, so the browser divides whatever is left after the
 * dividers and headers. They therefore always fill it exactly — no leftover gap,
 * no overflow — and each group's rows scroll on their own. Dragging a divider
 * trades share between them, and the chosen split is remembered per repository.
 * Both are on screen whether or not they hold files, so the split never jumps
 * about as work is staged and unstaged; a group with no rows shows one line of
 * text and takes a smaller share, because the height its files would have needed
 * belongs to the group that has some.
 *
 * The per-row buttons stay because they are the keyboard-accessible route to
 * the same two verbs, and the group bulk buttons stay for whole-group moves.
 * @module dsh-git-panel/client/git/ChangesPanel
 */

import {
  Fragment, useCallback, useEffect, useMemo, useRef, useState,
  type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent,
} from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { FileChange, StatusFilesView } from '../../core/types.ts'
import type { GitPanelKey } from '../locales.ts'
import {
  acceptsDrop, badgeClassOf, badgeOf, CHANGE_GROUP_ORDER, DEFAULT_GROUP_SHARE, dragShares, dropPaths,
  shareOf, shareScale, sideStatOf,
  type ChangeGroupKey, type DragPayload, type GroupShares,
} from './helpers.ts'
import { commitDraft, clearCommitDraft, rememberCommitDraft } from './commit-draft.ts'
import { FileRowBody } from './FileRow.tsx'
import css from './git.module.css'

/** The selection the detail pane is currently showing, if any. */
export interface FileSelection {
  path: string
  staged: boolean
}

/** Props of the Changes panel. */
export interface ChangesPanelProps {
  status: StatusFilesView
  selected: FileSelection | null
  busy: boolean
  onSelect: (selection: FileSelection) => void
  /**
   * The pointer (or the keyboard focus) has landed on a row, which is the signal
   * that a click on it is coming: the view prefetches that row's diff so the
   * preview opens without a wait. Optional — the panel works without it.
   */
  onPeek?: (selection: FileSelection) => void
  onStage: (paths: string[]) => void
  onUnstage: (paths: string[]) => void
  onDiscard: (paths: string[]) => void
  /** Commit the index; resolves true when git took it, which is what retires the draft. */
  onCommit: (message: string, amend: boolean) => Promise<boolean>
  t: Translate<GitPanelKey>
}

/**
 * Each group's title and empty note, in {@link CHANGE_GROUP_ORDER}. Both groups
 * are on screen whether or not they hold rows.
 */
const GROUP_TITLE: Record<ChangeGroupKey, GitPanelKey> = {
  unstaged: 'git.section.unstaged',
  staged: 'git.section.staged',
}

/** What an empty group says in place of its rows (never a drop cue: that is live). */
const GROUP_EMPTY_NOTE: Record<ChangeGroupKey, GitPanelKey> = {
  unstaged: 'git.section.unstaged.empty',
  staged: 'git.section.staged.empty',
}

/** One rendered group of change rows. */
interface Section {
  key: ChangeGroupKey
  title: string
  rows: FileChange[]
  /** Whether the rows are the staged side (decides the row action set). */
  staged: boolean
  /** The bulk action; absent when the group has no row a stage verb applies to. */
  bulk?: { label: string; paths: string[] }
}

/** One in-flight drag: the selected row keys travelling, and what they carry. */
interface DragState {
  keys: readonly string[]
  payload: DragPayload
}

/** Per-group shares (unitless weights); a missing key means the default share. */
type Shares = GroupShares

/**
 * localStorage key prefix for a repository's remembered split.
 *
 * The version suffix changed with the group set: the previous entries named four
 * groups (conflicted / unstaged / untracked / staged), and validating them one by
 * one against today's two would keep the `staged` weight while dropping the rest
 * — a split that is wildly lopsided rather than absent. A fresh key discards the
 * lot. (The suffix before that marked the move from absolute PIXEL heights, which
 * this model would have read as weights.)
 */
const SHARES_STORAGE_PREFIX = 'dsh.git-panel.group-shares.v2:'

/**
 * The identity of one row. A path can appear in two groups at once (a file both
 * staged and further modified), so the group is part of the identity — the same
 * path in the staged and unstaged lists are two independently selectable rows.
 */
function rowKey(group: ChangeGroupKey, path: string): string {
  return `${group}:${path}`
}

/** Whether a persisted key names a real group. */
function isGroupKey(value: string): value is ChangeGroupKey {
  return (CHANGE_GROUP_ORDER as readonly string[]).includes(value)
}

/**
 * Read a repository's remembered split. Storage is untrusted input (another
 * script may have written it, and it survives schema changes), so every entry
 * is validated rather than cast.
 */
function readShares(root: string): Shares {
  if (root === '') return {}
  try {
    const raw = localStorage.getItem(SHARES_STORAGE_PREFIX + root)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const shares: Shares = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isGroupKey(key)) continue
      // Only the ratio matters, so anything finite and positive is usable.
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
      shares[key] = value
    }
    return shares
  } catch {
    // Storage can be unavailable (private mode) or hold invalid JSON.
    return {}
  }
}

/** Persist a repository's split; a failure is not worth surfacing. */
function writeShares(root: string, shares: Shares): void {
  if (root === '') return
  try {
    if (Object.keys(shares).length === 0) localStorage.removeItem(SHARES_STORAGE_PREFIX + root)
    else localStorage.setItem(SHARES_STORAGE_PREFIX + root, JSON.stringify(shares))
  } catch {
    // Ignore: the layout still works for this mount.
  }
}

/**
 * Build the two change groups, emitted in {@link CHANGE_GROUP_ORDER} so the
 * visual order has exactly one source of truth. Both are emitted even when they
 * hold nothing, so neither can vanish and take its share of the list with it.
 *
 * A path staged AND further modified appears in BOTH groups: git reports one row
 * carrying both sides, and hiding either would strand a change — the worktree
 * half of 'AM' used to be listed nowhere at all.
 */
function buildSections(status: StatusFilesView, t: Translate<GitPanelKey>): Section[] {
  const staged = status.files.filter(file => file.staged && !file.conflicted)
  // Everything the index does not hold. The WORKTREE side decides it, never the
  // index side: a path that is staged AND then modified again ('AM', 'MM') carries
  // two changes at once, and testing `!file.staged` (as this once did) dropped it
  // from the pending group — so its worktree change was listed nowhere and could
  // never be staged or discarded. Conflicts live here too: they cannot be staged,
  // and they are more use as a row of the pending list than as a region of their
  // own that appears and disappears.
  const unstaged = status.files.filter(file =>
    file.conflicted || file.untracked || (file.worktree !== ' ' && file.worktree !== '?'))
  const rowsOf: Record<ChangeGroupKey, FileChange[]> = { unstaged, staged }
  return CHANGE_GROUP_ORDER.map((key) => {
    const rows = rowsOf[key]
    const section: Section = {
      key,
      title: t(GROUP_TITLE[key]),
      rows,
      staged: key === 'staged',
    }
    // A conflicted path has no staging verb — resolving it is not a stage — so the
    // bulk action skips it, and a group left with nothing but conflicts offers no
    // bulk action at all. A bulk verb over no rows is meaningless in any case.
    const actionable = rows.filter(file => !file.conflicted)
    if (actionable.length > 0) {
      section.bulk = {
        label: key === 'staged' ? t('git.unstageAll') : t('git.stageAll'),
        paths: actionable.map(file => file.path),
      }
    }
    return section
  })
}

/**
 * The Changes panel.
 * @param props - see {@link ChangesPanelProps}.
 */
export function ChangesPanel(props: ChangesPanelProps) {
  const { status, selected, busy, t, onSelect, onPeek, onStage, onUnstage, onDiscard, onCommit } = props
  /**
   * The commit box, seeded from this repository's saved draft.
   *
   * The shell renders only the active view, so the panel unmounts whenever the reader
   * looks at their conversation — which used to take a half-written message with it.
   * See `commit-draft`.
   */
  const root = status?.root ?? ''
  const [message, setMessage] = useState(() => commitDraft(root))
  // A different repository is a different draft. The panel can outlive a workspace
  // switch, so the box follows the root rather than keeping the previous one's text.
  useEffect(() => { setMessage(commitDraft(root)) }, [root])
  /** The in-flight row drag, or null. */
  const [drag, setDrag] = useState<DragState | null>(null)
  /** The group the pointer is over during a drag. */
  const [dragOver, setDragOver] = useState<ChangeGroupKey | null>(null)
  /** Selected row keys. */
  const [selection, setSelection] = useState<readonly string[]>([])
  /** The row a Shift+click extends from; null when there is no anchor. */
  const [anchor, setAnchor] = useState<string | null>(null)
  /** Per-group shares; a missing key means the default (an even split). */
  const [shares, setShares] = useState<Shares>({})
  /** The divider currently being dragged, as `upper:lower`. */
  const [resizing, setResizing] = useState<string | null>(null)

  /** Each group's wrapper, for measuring the dragged pair at drag start. */
  const groupRefs = useRef(new Map<ChangeGroupKey, HTMLDivElement>())
  /** The latest shares, readable from the pointerup handler without stale state. */
  const sharesRef = useRef<Shares>(shares)
  sharesRef.current = shares

  // Rebuilt only when the status itself changes: a drag repaints this panel on
  // every group crossing, and re-deriving the groups each time is wasted work.
  const sections = useMemo(() => buildSections(status, t), [status, t])
  /** Each rendered group's weight in the list's flex column, before scaling. */
  const weights = sections.map(section => shareOf(section.key, section.rows.length, shares))
  /** The one multiplier that lets those weights fill the list exactly. */
  const weightScale = shareScale(weights)

  // A different repository brings a different remembered split, and makes every
  // selected key meaningless. (The view component can be reused across
  // sessions, and two repos can hold identically named paths.)
  useEffect(() => {
    setShares(readShares(status.root))
    setSelection([])
    setAnchor(null)
  }, [status.root])

  /** Row key → how the row participates in a drag, for the current render. */
  const rowsByKey = new Map<string, { group: ChangeGroupKey; path: string; conflicted: boolean }>()
  for (const section of sections) {
    for (const file of section.rows) {
      rowsByKey.set(rowKey(section.key, file.path), {
        group: section.key, path: file.path, conflicted: file.conflicted,
      })
    }
  }

  // Selectable rows in render order — the axis a Shift+click range runs along.
  // A conflicted row is left out so a range never silently swallows a row with no
  // staging verb; a plain click can still select one, which is why the payload
  // build below refuses conflicted paths as well.
  const flatKeys = sections.flatMap(section => section.rows
    .filter(file => !file.conflicted)
    .map(file => rowKey(section.key, file.path)))

  const clearSelection = useCallback((): void => {
    setSelection([])
    setAnchor(null)
  }, [])

  /**
   * Begin a divider drag.
   *
   * Every rendered group is re-seeded from what is on screen, and those
   * measurements are immediately re-interpreted as shares — so all groups land
   * on ONE scale. Mixing a pair seeded in pixels with shares left over from an
   * earlier drag would put them on different scales, and one group would swallow
   * the list. The on-screen split is preserved exactly, and from here the drag
   * only trades share between the two neighbours.
   */
  const startResize = useCallback((
    upper: ChangeGroupKey,
    lower: ChangeGroupKey,
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    const seeded: Shares = {}
    for (const [key, element] of groupRefs.current) {
      const height = element.getBoundingClientRect().height
      if (height > 0) seeded[key] = height
    }
    const startUpper = seeded[upper]
    const startLower = seeded[lower]
    if (startUpper === undefined || startLower === undefined || !(startUpper + startLower > 0)) return
    event.preventDefault()
    const startY = event.clientY
    setShares(seeded)
    setResizing(`${upper}:${lower}`)
    // The pointer leaves the 9px divider immediately, so the cursor and the
    // text-selection suppression have to be applied to the document.
    const previousCursor = document.body.style.cursor
    const previousSelect = document.body.style.userSelect
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    const move = (moveEvent: PointerEvent): void => {
      const next = dragShares(startUpper, startLower, startUpper + startLower, moveEvent.clientY - startY)
      setShares({ ...seeded, [upper]: next.upper, [lower]: next.lower })
    }
    const finish = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelect
      setResizing(null)
      writeShares(status.root, sharesRef.current)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }, [status.root])

  /**
   * Forget a divider's two groups' dragged shares, which hands them back to the
   * automatic split (an even one between two groups that hold files, and the
   * smaller empty share for a group that does not) — the "restore automatic"
   * half of the divider's tooltip.
   */
  const clearResize = useCallback((upper: ChangeGroupKey, lower: ChangeGroupKey): void => {
    setShares((current) => {
      const next = { ...current }
      delete next[upper]
      delete next[lower]
      writeShares(status.root, next)
      return next
    })
  }, [status.root])

  const handleRowClick = useCallback((
    event: MouseEvent<HTMLDivElement>,
    key: string,
    file: FileChange,
    section: Section,
  ): void => {
    // The detail pane follows the row the user just acted on, whether or not
    // this gesture also changed the selection.
    onSelect({ path: file.path, staged: section.staged })

    if (event.shiftKey && anchor !== null) {
      const from = flatKeys.indexOf(anchor)
      const to = flatKeys.indexOf(key)
      if (from !== -1 && to !== -1) {
        const [low, high] = from <= to ? [from, to] : [to, from]
        setSelection(flatKeys.slice(low, high + 1))
        // The anchor deliberately stays put, so a further Shift+click re-ranges
        // from the same origin instead of walking the range along.
        return
      }
      // The anchor's row is gone (its path moved groups): fall through to a
      // plain click rather than leaving a stale selection behind.
    }

    if (event.ctrlKey || event.metaKey) {
      setSelection(current => (current.includes(key) ? current.filter(entry => entry !== key) : [...current, key]))
      setAnchor(key)
      return
    }

    setSelection([key])
    setAnchor(key)
  }, [anchor, flatKeys, onSelect])

  /**
   * Commit what is staged.
   *
   * The amend flag is false because the panel has no control for it any more; the
   * host and the injected API still take it, which is what `git commit --amend`
   * needs if a control comes back.
   */
  const submit = useCallback((): void => {
    if (busy || message.trim() === '') return
    // The box is emptied only once git has TAKEN the message. It used to clear
    // unconditionally, which discarded exactly the text the reader would have to type
    // a second time: the commit that failed.
    void onCommit(message, false)
      .then((ok) => {
        if (!ok) return
        setMessage('')
        clearCommitDraft(root)
      })
      .catch(() => {})
  }, [busy, message, onCommit, root])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Ctrl/Cmd+Enter submits; a bare Enter must stay a newline, since commit
    // messages are routinely multi-line.
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      submit()
    }
  }, [submit])

  /** End the drag: clear both the payload and the hover highlight. */
  const endDrag = useCallback((): void => {
    setDrag(null)
    setDragOver(null)
  }, [])

  const handleDragStart = useCallback((event: DragEvent<HTMLDivElement>, key: string): void => {
    // A row that is not already part of the selection becomes the selection, so
    // dragging an unselected row never carries a stale group of files with it.
    const keys = selection.includes(key) ? selection : [key]
    if (!selection.includes(key)) {
      setSelection(keys)
      setAnchor(key)
    }
    const staged: string[] = []
    const unstaged: string[] = []
    for (const entry of keys) {
      const row = rowsByKey.get(entry)
      // Keys whose row vanished (the status refreshed under the drag) simply do
      // not travel.
      if (row === undefined) continue
      // An unresolved path never travels, even when the selection holds it (a
      // plain click selects a conflicted row, and a range can grow to include
      // one): staging it would commit the conflict markers as the resolution.
      if (row.conflicted) continue
      if (row.group === 'staged') staged.push(row.path)
      else unstaged.push(row.path)
    }
    // Firefox refuses to start a drag unless some data is set.
    event.dataTransfer.setData('text/plain', [...staged, ...unstaged].join('\n'))
    event.dataTransfer.effectAllowed = 'move'
    setDrag({ keys, payload: { staged, unstaged } })
  }, [rowsByKey, selection])

  const handleDragOver = useCallback((key: ChangeGroupKey, event: DragEvent<HTMLDivElement>): void => {
    // Refusing here (before preventDefault) is what makes the browser show a
    // "no drop" cursor over a group where the drop would do nothing.
    if (busy || drag === null || !acceptsDrop(drag.payload, key)) return
    // preventDefault is the only thing that marks an element as a valid drop
    // target; without it the drop event never fires.
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDragOver(current => (current === key ? current : key))
  }, [busy, drag])

  const handleDragLeave = useCallback((key: ChangeGroupKey, event: DragEvent<HTMLDivElement>): void => {
    // dragleave also fires when the pointer crosses INTO a child row, so ignore
    // any event whose destination is still inside this group.
    const next = event.relatedTarget as Node | null
    if (next !== null && event.currentTarget.contains(next)) return
    setDragOver(current => (current === key ? null : current))
  }, [])

  const handleDrop = useCallback((key: ChangeGroupKey, event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const source = drag
    endDrag()
    if (busy || source === null) return
    const plan = dropPaths(source.payload, key)
    if (plan === null) return
    // The rows change groups, so every key in the selection is stale now.
    clearSelection()
    if (plan.action === 'stage') onStage(plan.paths)
    else onUnstage(plan.paths)
  }, [busy, drag, endDrag, clearSelection, onStage, onUnstage])

  const tiny = `${css.button ?? ''} ${css.buttonTiny ?? ''}`.trim()

  /**
   * Delete acts on the region a row is in — one key, and the meaning is "take
   * this change out of where it is":
   *
   *   - a row in the PENDING region has its worktree changes discarded;
   *   - a row in the STAGED region is unstaged, which puts it back in the
   *     pending region (what dragging it up does).
   *
   * It applies to the whole selection when the row is part of one, and it is not
   * confirmed: it is a single keystroke, and the panel already shows exactly
   * which rows it will act on. A path selected on BOTH sides is only unstaged —
   * discarding it too would throw away the edits the unstage just handed back.
   */
  const requestDelete = useCallback((key: string): void => {
    if (busy) return
    const keys = selection.includes(key) ? selection : [key]
    const staged: string[] = []
    const pending: string[] = []
    for (const entry of keys) {
      const row = rowsByKey.get(entry)
      if (row === undefined) continue
      if (row.group === 'staged') staged.push(row.path)
      else pending.push(row.path)
    }
    const unstaged = new Set(staged)
    const discard = pending.filter(path => !unstaged.has(path))
    if (staged.length > 0) {
      clearSelection()
      onUnstage(staged)
    }
    if (discard.length > 0) {
      clearSelection()
      onDiscard(discard)
    }
  }, [busy, clearSelection, onDiscard, onUnstage, rowsByKey, selection])

  /** The live cue for a group the in-flight drag may land on. */
  const dropHintText = (plan: { action: 'stage' | 'unstage'; paths: string[] }): string => {
    if (plan.action === 'stage') {
      return plan.paths.length > 1
        ? t('git.dropToStageCount', { count: plan.paths.length })
        : t('git.dropToStage')
    }
    return plan.paths.length > 1
      ? t('git.dropToUnstageCount', { count: plan.paths.length })
      : t('git.dropToUnstage')
  }


  return (
    <div className={css.listPane} data-gitgraph-part="changes">
      <div
        className={css.groups}
        data-gitgraph-selection={selection.length}
        onKeyDown={(event) => {
          // Escape drops the whole selection; the focused row stays focused.
          if (event.key === 'Escape' && selection.length > 0) {
            event.preventDefault()
            clearSelection()
          }
        }}
        onClick={(event) => {
          // A click on the empty area below the groups clears the selection.
          if (event.target === event.currentTarget) clearSelection()
        }}
      >
        {/* No "working tree is clean" banner: every group is always on screen
            and states its own emptiness, which says the same thing more
            precisely and without taking height from the groups. */}
        {sections.map((section, index) => {
          const previous = index === 0 ? undefined : sections[index - 1]
          const plan = drag === null ? null : dropPaths(drag.payload, section.key)
          const armed = plan !== null
          const hovered = dragOver === section.key
          const zoneClass = [
            css.group,
            armed ? css.sectionDropArmed : '',
            hovered ? css.sectionDropHover : '',
          ].filter(Boolean).join(' ')
          const empty = section.rows.length === 0
          const dividerKey = previous === undefined ? '' : `${previous.key}:${section.key}`
          return (
            <Fragment key={section.key}>
              {/* A divider owns the boundary between two adjacent groups; both
                  neighbours are frozen at their measured heights when it is
                  grabbed, and double-clicking gives the space back to content. */}
              {previous !== undefined && (
                <div
                  className={`${css.divider ?? ''} ${resizing === dividerKey ? css.dividerActive ?? '' : ''}`.trim()}
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label={t('git.dividerAria')}
                  title={t('git.resizeHint')}
                  data-gitgraph-divider={dividerKey}
                  onPointerDown={(event) => { startResize(previous.key, section.key, event) }}
                  onDoubleClick={() => { clearResize(previous.key, section.key) }}
                />
              )}
              <div
                ref={(element) => {
                  if (element === null) groupRefs.current.delete(section.key)
                  else groupRefs.current.set(section.key, element)
                }}
                className={zoneClass}
                // The share is this group's weight in the list's flex column. The
                // browser turns it into pixels, so nothing here needs to know how
                // tall the list or the headers are. An empty group starts on a
                // smaller share: it only has to show a header and one line, and
                // the height its files would need belongs to the groups that have
                // some. A dragged share always wins over both defaults.
                style={{ flex: `${(weights[index] ?? DEFAULT_GROUP_SHARE) * weightScale} 1 0` }}
                data-gitgraph-group={section.key}
                onDragOver={(event) => { handleDragOver(section.key, event) }}
                onDragLeave={(event) => { handleDragLeave(section.key, event) }}
                onDrop={(event) => { handleDrop(section.key, event) }}
              >
                <div className={css.sectionHeader}>
                  <span>{section.title}</span>
                  <span className={css.sectionCount}>{section.rows.length}</span>
                  <span className={css.spacer} />
                  {/* The header's single flex row carries both the standing note
                      of an empty group and the live drag cue, so neither can
                      change the header's height and shift the list under the
                      pointer mid-drag — and an empty group needs no rows area at
                      all, which is what keeps its floor at one header. */}
                  {plan === null
                    ? (empty && <span className={css.sectionNote}>{t(GROUP_EMPTY_NOTE[section.key])}</span>)
                    : ((empty || hovered) && <span className={css.dropInline}>{dropHintText(plan)}</span>)}
                  {section.bulk !== undefined && (
                    <button
                      type="button"
                      className={tiny}
                      disabled={busy}
                      onClick={() => {
                        if (section.staged) onUnstage(section.bulk!.paths)
                        else onStage(section.bulk!.paths)
                      }}
                    >
                      {section.bulk.label}
                    </button>
                  )}
                </div>
                {/* An empty group renders no rows area: its note lives in the
                    header, so its floor is one header and there is nothing left
                    to clip however small a share it is dragged to. The blank
                    below it at larger shares is space the user can hand back by
                    dragging the divider. */}
                {!empty && (
                  <div className={css.groupRows}>
                  {section.rows.map(file => {
                    const key = rowKey(section.key, file.path)
                    const active = selected !== null && selected.path === file.path && selected.staged === section.staged
                    const isSelected = selection.includes(key)
                    const dragging = drag !== null && drag.keys.includes(key)
                    // Conflicted rows stay undraggable: that group has no
                    // staging verb, and a drop onto it would have no meaning.
                    const draggable = !file.conflicted && !busy
                    const rowClass = [
                      css.fileRow,
                      isSelected ? css.fileRowSelected : '',
                      active ? css.fileRowActive : '',
                      draggable ? css.fileRowDraggable : '',
                      dragging ? css.fileRowDragging : '',
                    ].filter(Boolean).join(' ')
                    const label = file.origPath === undefined ? file.path : `${file.origPath} → ${file.path}`
                    return (
                      <div
                        key={key}
                        role="button"
                        tabIndex={0}
                        draggable={draggable}
                        // Rows are toggle buttons, so `aria-pressed` (not the
                        // listbox-only `aria-selected`) is the valid way to
                        // publish the selection state.
                        aria-pressed={isSelected}
                        title={draggable
                          ? `${label}\n${section.staged ? t('git.dropToUnstage') : t('git.dropToStage')}`
                            + `\n${section.staged ? t('git.unstageKey') : t('git.discardKey')}`
                          : label}
                        className={rowClass}
                        data-gitgraph-file={file.path}
                        data-gitgraph-file-staged={section.staged ? 'true' : 'false'}
                        data-gitgraph-file-selected={isSelected ? 'true' : undefined}
                        // Landing on the row — by pointer or by Tab — is the signal
                        // that this row is about to be opened, so its diff is asked
                        // for then instead of after the click.
                        onPointerEnter={() => { onPeek?.({ path: file.path, staged: section.staged }) }}
                        onFocus={() => { onPeek?.({ path: file.path, staged: section.staged }) }}
                        onClick={(event) => { handleRowClick(event, key, file, section) }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            // Keyboard selection stays single-row: Ctrl/Shift
                            // are pointer gestures here, and moving a row is a
                            // drag; Delete is the one verb that needs a key.
                            setSelection([key])
                            setAnchor(key)
                            onSelect({ path: file.path, staged: section.staged })
                            return
                          }
                          // Delete takes the change out of the region the row is
                          // in: discard for a pending row, unstage for a staged
                          // one.
                          if (event.key === 'Delete' || event.key === 'Backspace') {
                            event.preventDefault()
                            requestDelete(key)
                          }
                        }}
                        onDragStart={(event) => { handleDragStart(event, key) }}
                        onDragEnd={endDrag}
                      >
                        {/* The badge, path, and counts are the History tab's file
                            row verbatim: one row style, both lists. The counts are
                            the ones THIS side earned: a path staged and then edited
                            again is two rows standing for two different changes. */}
                        <FileRowBody
                          badge={badgeOf(file, section.staged)}
                          tone={badgeClassOf(file, section.staged)}
                          badgeTitle={`${file.index}${file.worktree}`}
                          label={label}
                          additions={sideStatOf(file, section.staged)?.additions}
                          deletions={sideStatOf(file, section.staged)?.deletions}
                        />
                      </div>
                    )
                  })}
                </div>
                )}
              </div>
            </Fragment>
          )
        })}
      </div>
      <div className={css.commitBox}>
        <textarea
          className={css.commitInput}
          value={message}
          placeholder={t('git.commit.placeholder')}
          disabled={busy}
          onChange={(event) => {
            setMessage(event.target.value)
            // Kept as it is typed rather than on unmount: a cleanup would not run
            // when the tab is simply hidden, and the draft has to be there either way.
            rememberCommitDraft(root, event.target.value)
          }}
          onKeyDown={onKeyDown}
          data-gitgraph-commit-message
        />
        <div className={css.commitActions}>
          <button
            type="button"
            className={`${css.button ?? ''} ${css.buttonPrimary ?? ''}`.trim()}
            disabled={busy || message.trim() === ''}
            data-gitgraph-commit
            onClick={submit}
          >
            {t('git.commit.button')}
          </button>
        </div>
      </div>
    </div>
  )
}
