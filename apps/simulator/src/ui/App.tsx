/**
 * Simulator shell (VOICE §9.1): left rail (trip list + "send as" picker),
 * phone-width group thread in the center, Trav's DMs on the right, top bar
 * with the simulated clock and the offline badge.
 *
 * `AppView` is the pure render of a `SimState` (server-rendered in tests);
 * `App` adds the live SSE subscription and the POSTs.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Action } from '@trav/core';
import type {
  ClockStep,
  GroupView,
  IntakeOffer,
  ReplayView,
  SimMember,
  SimState,
  ThreadMessage,
} from '../shared/types.js';
import {
  advanceClock,
  feedDocument,
  fetchState,
  inject,
  replay,
  resetDemo,
  subscribeState,
} from './api.js';
import { avatarColor, clockLabel, initials } from './logic.js';
import { Thread } from './components/Thread.js';
import type { ThreadHandlers } from './components/Thread.js';

export interface AppViewProps {
  readonly state: SimState;
  readonly groupId: string;
  readonly meHandle: string;
  readonly dmMemberId: string;
  readonly highlightDms: readonly string[];
  readonly draft: string;
  readonly error?: string;
  readonly onSelectGroup: (groupId: string) => void;
  readonly onSelectMe: (handle: string) => void;
  readonly onSelectDm: (memberId: string) => void;
  readonly onDraft: (text: string) => void;
  readonly onSend: () => void;
  readonly onReset?: () => void;
  readonly onClock?: (step: ClockStep) => void;
  readonly onReplay?: (mode: 'step' | 'all') => void;
  readonly onIntake?: (docId: string) => void;
  /** A clock step, replay or intake request is in flight (its buttons are disabled). */
  readonly busy?: boolean;
  /** The right rail is collapsed to a narrow strip (VOICE §9.1 "collapsible"). */
  readonly dmsCollapsed?: boolean;
  readonly onToggleDms?: () => void;
  readonly handlers: ThreadHandlers;
}

export function pickGroup(state: SimState, groupId: string): GroupView {
  return state.groups.find((g) => g.group.groupId === groupId) ?? state.groups[0]!;
}

export function pickMe(view: GroupView, handle: string): SimMember {
  return view.group.members.find((m) => m.handle === handle) ?? view.group.members[0]!;
}

const CLOCK_BUTTONS: readonly { step: ClockStep; label: string }[] = [
  { step: 'hour', label: '+1 hour' },
  { step: 'morning', label: 'next morning' },
  { step: 'end_of_trip', label: 'end of trip' },
];

function ReplayControls({
  replay,
  busy,
  onReplay,
}: {
  replay: ReplayView;
  busy: boolean;
  onReplay: (mode: 'step' | 'all') => void;
}) {
  const done = replay.cursor >= replay.total;
  const title =
    replay.cursor === 0
      ? 'restarts the demo, then runs the Barcelona chat one line at a time'
      : (replay.next ?? 'the script is done');
  return (
    <span className="replay" data-testid="replay">
      <button
        type="button"
        className="btn small"
        data-testid="replay-step"
        disabled={busy || done}
        title={title}
        onClick={() => onReplay('step')}
      >
        replay ▸ {replay.cursor}/{replay.total}
      </button>
      <button
        type="button"
        className="btn small"
        data-testid="replay-all"
        disabled={busy || done}
        onClick={() => onReplay('all')}
      >
        play all
      </button>
      {replay.next !== undefined || replay.last !== undefined ? (
        <span className="replay-line muted small" data-testid="replay-line">
          {replay.last !== undefined ? replay.last : `next: ${replay.next ?? ''}`}
        </span>
      ) : null}
    </span>
  );
}

function TopBar({
  state,
  view,
  busy,
  onReset,
  onClock,
  onReplay,
}: {
  state: SimState;
  view: GroupView;
  busy: boolean;
  onReset?: () => void;
  onClock?: (step: ClockStep) => void;
  onReplay?: (mode: 'step' | 'all') => void;
}) {
  return (
    <header className="topbar">
      <span className="clock" data-testid="clock">
        {/* Each chat has its own clock (T-095). */}
        {clockLabel(view.now, view.group)}
      </span>
      {state.controls.clock && onClock ? (
        <span className="clock-buttons" data-testid="clock-buttons">
          {CLOCK_BUTTONS.map((b) => (
            <button
              key={b.step}
              type="button"
              className="btn small"
              data-testid={`clock-${b.step}`}
              disabled={busy}
              onClick={() => onClock(b.step)}
            >
              {b.label}
            </button>
          ))}
        </span>
      ) : null}
      {state.controls.replay && state.replay && onReplay ? (
        <ReplayControls replay={state.replay} busy={busy} onReplay={onReplay} />
      ) : null}
      <span className="spacer" />
      {state.offline ? (
        <span className="badge offline" data-testid="offline-badge" title="no live model calls">
          offline
        </span>
      ) : null}
      {onReset ? (
        <button type="button" className="btn secondary small" data-testid="reset" onClick={onReset}>
          restart demo
        </button>
      ) : null}
    </header>
  );
}

function LeftRail(props: AppViewProps & { view: GroupView; me: SimMember }) {
  const { state, view, me } = props;
  return (
    <aside className="left-rail">
      <div className="rail-title">trips</div>
      <ul className="trip-list">
        {state.groups.map((g) => (
          <li key={g.group.groupId}>
            <button
              type="button"
              className={`trip ${g.group.groupId === view.group.groupId ? 'selected' : ''}`}
              data-testid={`trip-${g.group.groupId}`}
              onClick={() => props.onSelectGroup(g.group.groupId)}
            >
              <span className="trip-name">{g.group.name}</span>
              <span className="trip-preview">
                {g.typing
                  ? 'Trav is typing…'
                  : g.preview
                    ? `${g.preview.fromName}: ${g.preview.text}`
                    : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="rail-title">send as</div>
      <div className="send-as">
        {view.group.members.map((m) => (
          <button
            key={m.handle}
            type="button"
            className={`send-as-chip ${m.handle === me.handle ? 'selected' : ''}`}
            data-testid={`sendas-${m.handle}`}
            aria-pressed={m.handle === me.handle}
            onClick={() => props.onSelectMe(m.handle)}
          >
            <span
              className="avatar small"
              style={{ background: avatarColor(view.group, m.handle) }}
            >
              {initials(
                m.name,
                view.group.members.map((x) => x.name),
              )}
            </span>
            {m.name}
          </button>
        ))}
      </div>
    </aside>
  );
}

const INTAKE_LABEL: Readonly<Record<IntakeOffer['kind'], string>> = {
  card: 'simulate a card charge',
  email: 'simulate an email receipt',
};

function DmRail(props: AppViewProps & { view: GroupView; me: SimMember }) {
  const { view, me } = props;
  const selected = view.group.members.find((m) => m.memberId === props.dmMemberId) ?? me;
  const entries = view.dms[selected.memberId] ?? [];
  // Taps and tapbacks always act as the "send as" member, so another member's
  // DM is look-only: pressing "Share it" there would be a tap by someone else.
  const readOnly = selected.memberId !== me.memberId;
  // A member's own card or email only: offered in their tab, while sending as them.
  const offers = readOnly ? [] : (view.intake[selected.memberId] ?? []);
  if (props.dmsCollapsed === true && props.onToggleDms) {
    const total = view.group.members.reduce((n, m) => n + (view.dms[m.memberId] ?? []).length, 0);
    return (
      <aside className="right-rail collapsed" data-testid="dm-rail-collapsed">
        <button
          type="button"
          className="btn small dm-toggle"
          data-testid="dm-toggle"
          title="show Trav's DMs"
          onClick={props.onToggleDms}
        >
          🔒 DMs{total > 0 ? <span className="dm-count">{total}</span> : null}
        </button>
      </aside>
    );
  }
  return (
    <aside className="right-rail">
      <div className="rail-title rail-title-row">
        Trav's DMs
        {props.onToggleDms ? (
          <button
            type="button"
            className="btn small secondary dm-toggle"
            data-testid="dm-toggle"
            title="hide Trav's DMs"
            onClick={props.onToggleDms}
          >
            hide
          </button>
        ) : null}
      </div>
      <div className="dm-tabs">
        {view.group.members.map((m) => {
          const count = (view.dms[m.memberId] ?? []).length;
          const isMe = m.memberId === me.memberId;
          const cls = [
            'dm-tab',
            m.memberId === selected.memberId ? 'selected' : '',
            isMe ? 'me' : '',
            props.highlightDms.includes(m.memberId) ? 'highlight' : '',
          ].join(' ');
          return (
            <button
              key={m.memberId}
              type="button"
              className={cls}
              data-testid={`dm-tab-${m.memberId}`}
              data-count={count}
              data-me={isMe ? 'true' : undefined}
              aria-current={isMe ? 'true' : undefined}
              title={isMe ? `you are sending as ${m.name}` : undefined}
              onClick={() => props.onSelectDm(m.memberId)}
            >
              {m.name}
              {count > 0 ? <span className="dm-count">{count}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="dm-header" data-testid="dm-header">
        🔒 only {selected.name} sees this
      </div>
      {readOnly ? (
        <div className="dm-readonly muted small" data-testid="dm-readonly">
          view only · send as {selected.name} to tap
        </div>
      ) : null}
      {offers.length > 0 && props.onIntake ? (
        <div className="intake" data-testid="intake">
          {offers.map((o) => (
            <button
              key={o.docId}
              type="button"
              className="btn small"
              data-testid={`intake-${o.docId}`}
              disabled={props.busy === true}
              title="feeds this member's fixture document through Trav's intake (demo only)"
              onClick={() => props.onIntake?.(o.docId)}
            >
              {INTAKE_LABEL[o.kind]}
            </button>
          ))}
        </div>
      ) : null}
      <Thread
        entries={entries}
        group={view.group}
        me={selected}
        typing={false}
        handlers={props.handlers}
        readOnly={readOnly}
        testId="dm-thread"
        empty="nothing here yet"
      />
    </aside>
  );
}

export function AppView(props: AppViewProps) {
  const view = pickGroup(props.state, props.groupId);
  const me = pickMe(view, props.meHandle);
  // The one-tap demo line only until Trav has answered with a card.
  const answered = view.thread.some((e) => e.kind === 'message' && e.isTrav && e.card);
  const hint = answered
    ? undefined
    : view.group.hints.find((h) => h.from === me.handle && h.text !== props.draft);
  const memberCount = view.group.members.length;
  return (
    <div className="app">
      <TopBar
        state={props.state}
        view={view}
        busy={props.busy === true}
        {...(props.onReset ? { onReset: props.onReset } : {})}
        {...(props.onClock ? { onClock: props.onClock } : {})}
        {...(props.onReplay ? { onReplay: props.onReplay } : {})}
      />
      <div className="main">
        <LeftRail {...props} view={view} me={me} />
        <section className="center">
          <div className="phone">
            <div className="thread-header">
              <div className="stack">
                {view.group.members.slice(0, 4).map((m) => (
                  <span
                    key={m.handle}
                    className="avatar small"
                    style={{ background: avatarColor(view.group, m.handle) }}
                  >
                    {initials(
                      m.name,
                      view.group.members.map((x) => x.name),
                    )}
                  </span>
                ))}
              </div>
              <div className="group-name" data-testid="group-name">
                {view.group.name}
              </div>
              <div className="muted small">{memberCount + 1} people</div>
            </div>
            <Thread
              entries={view.thread}
              group={view.group}
              me={me}
              typing={view.typing}
              handlers={props.handlers}
            />
            {props.error || props.state.lastError ? (
              <div className="error-banner" data-testid="error">
                {props.error ?? props.state.lastError}
              </div>
            ) : null}
            {view.status ? (
              <div className="status-banner" data-testid="sim-status" role="status">
                {view.status}
              </div>
            ) : null}
            {hint ? (
              <button
                type="button"
                className="hint"
                data-testid="hint"
                onClick={() => props.onDraft(hint.text)}
              >
                try: {hint.text}
              </button>
            ) : null}
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                props.onSend();
              }}
            >
              <span
                className="avatar small"
                style={{ background: avatarColor(view.group, me.handle) }}
              >
                {initials(
                  me.name,
                  view.group.members.map((x) => x.name),
                )}
              </span>
              <input
                className="composer-input"
                data-testid="composer-input"
                placeholder={`message as ${me.name}`}
                value={props.draft}
                onChange={(e) => props.onDraft(e.target.value)}
              />
              <button
                type="submit"
                className="btn primary"
                data-testid="composer-send"
                disabled={props.draft.trim() === ''}
              >
                Send
              </button>
            </form>
          </div>
        </section>
        <DmRail {...props} view={view} me={me} />
      </div>
    </div>
  );
}

export function App() {
  const [state, setState] = useState<SimState | undefined>();
  const [groupId, setGroupId] = useState<string>('');
  const [meByGroup, setMeByGroup] = useState<Record<string, string>>({});
  const [dmMemberId, setDmMemberId] = useState<string>('');
  const [highlightDms, setHighlightDms] = useState<readonly string[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [dmsCollapsed, setDmsCollapsed] = useState(false);
  const version = useRef(-1);

  const accept = (s: SimState | undefined): void => {
    if (!s || s.version < version.current) return;
    version.current = s.version;
    setState(s);
  };

  useEffect(() => {
    let closed = false;
    fetchState().then(accept, (e: unknown) => setError(String(e)));
    const stop = subscribeState(
      (s) => {
        if (!closed) {
          setError(undefined);
          accept(s);
        }
      },
      () => setError('lost the simulator server, retrying'),
    );
    return () => {
      closed = true;
      stop();
    };
  }, []);

  const fail = (e: unknown): void => setError(e instanceof Error ? e.message : String(e));

  const run = (input: Parameters<typeof inject>[0]): void => {
    setError(undefined);
    inject(input).then(accept, fail);
  };

  /** Clock, replay and intake: one request at a time, buttons disabled meanwhile. */
  const control = (request: () => Promise<SimState | undefined>): void => {
    setError(undefined);
    setBusy(true);
    request()
      .then(accept, fail)
      .finally(() => setBusy(false));
  };

  const handlers = useMemo<ThreadHandlers | undefined>(() => {
    if (!state) return undefined;
    const view = pickGroup(state, groupId);
    const me = pickMe(view, meByGroup[view.group.groupId] ?? '');
    // Every tap and tapback is the "send as" member's. Another member's DM is
    // rendered read-only (DmRail), so a DM card can only be tapped by its owner.
    return {
      onAction: (msg: ThreadMessage, action: Action, value?: string) => {
        run({
          type: 'button_tap',
          from: me.handle,
          cardMessageId: msg.messageId,
          actionId: action.id,
          ...(value !== undefined ? { value } : {}),
        });
      },
      onReact: (msg: ThreadMessage, reaction: string) => {
        run({ type: 'reaction', from: me.handle, targetMessageId: msg.messageId, reaction });
      },
      onShowDms: (ids) => setHighlightDms(ids),
    };
  }, [state, groupId, meByGroup]);

  if (!state || !handlers) {
    return <div className="loading">{error ?? 'connecting to the simulator…'}</div>;
  }
  const view = pickGroup(state, groupId);
  const me = pickMe(view, meByGroup[view.group.groupId] ?? '');
  const dm = view.group.members.some((m) => m.memberId === dmMemberId) ? dmMemberId : me.memberId;

  return (
    <AppView
      state={state}
      groupId={view.group.groupId}
      meHandle={me.handle}
      dmMemberId={dm}
      highlightDms={highlightDms}
      draft={draft}
      {...(error !== undefined ? { error } : {})}
      onSelectGroup={(id) => {
        setGroupId(id);
        setDmMemberId('');
        setHighlightDms([]);
      }}
      onSelectMe={(handle) => {
        setMeByGroup((prev) => ({ ...prev, [view.group.groupId]: handle }));
        const m = view.group.members.find((x) => x.handle === handle);
        if (m) setDmMemberId(m.memberId);
      }}
      onSelectDm={(id) => {
        setDmMemberId(id);
        setHighlightDms((prev) => prev.filter((x) => x !== id));
      }}
      onDraft={setDraft}
      onSend={() => {
        const text = draft.trim();
        if (text === '') return;
        setDraft('');
        run({ type: 'message', from: me.handle, text, groupId: view.group.groupId });
      }}
      {...(state.controls.reset
        ? {
            onReset: () => {
              setDraft('');
              setHighlightDms([]);
              control(resetDemo);
            },
          }
        : {})}
      {...(state.controls.clock
        ? { onClock: (step: ClockStep) => control(() => advanceClock(step, view.group.groupId)) }
        : {})}
      {...(state.controls.replay
        ? {
            onReplay: (mode: 'step' | 'all') => {
              setHighlightDms([]);
              control(() => replay(mode));
            },
          }
        : {})}
      {...(state.controls.intake
        ? { onIntake: (docId: string) => control(() => feedDocument(docId)) }
        : {})}
      busy={busy}
      dmsCollapsed={dmsCollapsed}
      onToggleDms={() => setDmsCollapsed((c) => !c)}
      handlers={handlers}
    />
  );
}
