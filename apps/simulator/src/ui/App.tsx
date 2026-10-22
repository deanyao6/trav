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
import type { GroupView, SimInbound, SimMember, SimState, ThreadMessage } from '../shared/types.js';
import { fetchState, inject, resetDemo, subscribeState } from './api.js';
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
  readonly handlers: ThreadHandlers;
}

export function pickGroup(state: SimState, groupId: string): GroupView {
  return state.groups.find((g) => g.group.groupId === groupId) ?? state.groups[0]!;
}

export function pickMe(view: GroupView, handle: string): SimMember {
  return view.group.members.find((m) => m.handle === handle) ?? view.group.members[0]!;
}

function TopBar({
  state,
  view,
  onReset,
}: {
  state: SimState;
  view: GroupView;
  onReset?: () => void;
}) {
  return (
    <header className="topbar">
      <span className="clock" data-testid="clock">
        {clockLabel(state.now, view.group)}
      </span>
      <span className="spacer" />
      {state.offline ? (
        <span className="badge offline" data-testid="offline-badge" title="no live model calls">
          offline
        </span>
      ) : null}
      {state.backend === 'scripted' ? (
        <span
          className="badge scripted"
          data-testid="scripted-badge"
          title="scripted Barcelona demo, not the agent"
        >
          scripted demo
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
              {initials(m.name)}
            </span>
            {m.name}
          </button>
        ))}
      </div>
    </aside>
  );
}

function DmRail(props: AppViewProps & { view: GroupView; me: SimMember }) {
  const { view, me } = props;
  const selected = view.group.members.find((m) => m.memberId === props.dmMemberId) ?? me;
  const entries = view.dms[selected.memberId] ?? [];
  return (
    <aside className="right-rail">
      <div className="rail-title">Trav's DMs</div>
      <div className="dm-tabs">
        {view.group.members.map((m) => {
          const count = (view.dms[m.memberId] ?? []).length;
          const cls = [
            'dm-tab',
            m.memberId === selected.memberId ? 'selected' : '',
            m.memberId === me.memberId ? 'me' : '',
            props.highlightDms.includes(m.memberId) ? 'highlight' : '',
          ].join(' ');
          return (
            <button
              key={m.memberId}
              type="button"
              className={cls}
              data-testid={`dm-tab-${m.memberId}`}
              data-count={count}
              onClick={() => props.onSelectDm(m.memberId)}
            >
              {m.name}
              {count > 0 ? <span className="dm-count">{count}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="dm-header">🔒 only {selected.name} sees this</div>
      <Thread
        entries={entries}
        group={view.group}
        me={selected}
        typing={false}
        handlers={props.handlers}
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
        {...(props.onReset ? { onReset: props.onReset } : {})}
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
                    {initials(m.name)}
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
                {initials(me.name)}
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

  const run = (input: SimInbound): void => {
    setError(undefined);
    inject(input).then(accept, (e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  };

  const handlers = useMemo<ThreadHandlers | undefined>(() => {
    if (!state) return undefined;
    const view = pickGroup(state, groupId);
    const me = pickMe(view, meByGroup[view.group.groupId] ?? '');
    return {
      onAction: (msg: ThreadMessage, action: Action, value?: string) => {
        // A DM card's buttons act as that DM's owner (only they can see it).
        const actor =
          msg.lane === 'dm'
            ? (view.group.members.find((m) => m.memberId === dmMemberId) ?? me)
            : me;
        run({
          type: 'button_tap',
          from: actor.handle,
          cardMessageId: msg.messageId,
          actionId: action.id,
          ...(value !== undefined ? { value } : {}),
        });
      },
      onReact: (msg: ThreadMessage, reaction: string) => {
        const actor =
          msg.lane === 'dm'
            ? (view.group.members.find((m) => m.memberId === dmMemberId) ?? me)
            : me;
        run({ type: 'reaction', from: actor.handle, targetMessageId: msg.messageId, reaction });
      },
      onShowDms: (ids) => setHighlightDms(ids),
    };
  }, [state, groupId, meByGroup, dmMemberId]);

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
      {...(state.backend === 'scripted'
        ? {
            onReset: () => {
              setDraft('');
              setHighlightDms([]);
              resetDemo().then(accept, (e: unknown) => setError(String(e)));
            },
          }
        : {})}
      handlers={handlers}
    />
  );
}
