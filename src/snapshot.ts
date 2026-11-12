export interface SnapshotElement {
  ref: string
  role: string
  label: string
  /** Text of the enclosing block, which carries things like a price or a date. */
  context?: string
  operations: string[]
  value?: string
  checked?: string
  selected?: string
  expanded?: string
  /** A file input a styled upload box hides; its ref still takes an upload. */
  hidden?: boolean
}

export interface SnapshotAction {
  ref: string
  kind: 'click' | 'fill' | 'select' | 'upload'
  label: string
  value: string
  current_value?: string
}

export interface ScrollState {
  y: number
  height: number
}

/** What a single action did to the page, so a caller never has to infer it from a snapshot. */
export interface Outcome {
  kind: 'navigated' | 'changed' | 'none'
  url: string
  /** The network error behind a chrome-error page, such as ERR_NAME_NOT_RESOLVED. */
  error?: string
}

/** A snapshot taken right after an action, with what that action did. */
export interface SnapshotResult extends Snapshot {
  /** Filled in by click, hover, type, select, upload and press; absent from a plain snap. */
  outcome?: Outcome
}

export interface Snapshot {
  url: string
  title: string
  w: number
  h: number
  text: string
  scroll: ScrollState
  elements: SnapshotElement[]
  actions: SnapshotAction[]
  history: number
  /** Frames whose document cannot be read, usually because they are cross origin. */
  hiddenFrames: number
  truncated: number
  dialogs: number
  /** What a coordinate click landed on, when that is how the snapshot was taken. */
  hit?: string
  /** The last native dialog this session accepted, as `type "message"`. */
  dialog?: string
}
