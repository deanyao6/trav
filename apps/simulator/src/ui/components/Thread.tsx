/**
 * The phone-width group thread (VOICE §9.2): iMessage-style bubbles, Trav as
 * a gray bubble with the teal "t" avatar, 15-minute timestamp separators with
 * the day counter, tapback pills, the typing indicator and "Delivered".
 */
import { useState } from 'react';
import type { Action } from '@trav/core';
import type { SimGroup, SimMember, ThreadEntry, ThreadMessage } from '../../shared/types.js';
import {
  TAPBACKS,
  TRAV_TEAL,
  avatarColor,
  initials,
  layoutThread,
  splitMentions,
} from '../logic.js';
import { Card } from './Cards.js';

export interface ThreadHandlers {
  readonly onAction: (msg: ThreadMessage, action: Action, value?: string) => void;
  readonly onReact: (msg: ThreadMessage, reaction: string) => void;
  readonly onShowDms?: (memberIds: readonly string[]) => void;
}

export function Avatar({
  group,
  handle,
  name,
  isTrav,
}: {
  group: SimGroup;
  handle: string;
  name: string;
  isTrav: boolean;
}) {
  if (isTrav) {
    return (
      <span className="avatar trav-avatar" style={{ background: TRAV_TEAL }} aria-label="Trav">
        t
      </span>
    );
  }
  return (
    <span className="avatar" style={{ background: avatarColor(group, handle) }} aria-label={name}>
      {initials(name)}
    </span>
  );
}

function Text({ text, outgoing }: { text: string; outgoing: boolean }) {
  return (
    <>
      {text.split('\n').map((line, i) => (
        <span key={i} className="line">
          {splitMentions(line).map((p, j) =>
            p.mention ? (
              <span key={j} className={outgoing ? 'mention out' : 'mention'}>
                {p.text}
              </span>
            ) : (
              <span key={j}>{p.text}</span>
            ),
          )}
        </span>
      ))}
    </>
  );
}

function Reactions({ msg }: { msg: ThreadMessage }) {
  if (msg.reactions.length === 0) return null;
  return (
    <span className="tapbacks">
      {msg.reactions.map((r) => (
        <span key={r.reaction} className="tapback-pill">
          {r.reaction}
          {r.count > 1 ? <span className="count">{r.count}</span> : null}
        </span>
      ))}
    </span>
  );
}

/**
 * The tapback picker (VOICE §9.2: ❤️ 👍 👎 😂 ‼️ ❓), opened by clicking a
 * bubble. A pick goes to `ThreadHandlers.onReact`, i.e. `POST /api/reactions`
 * → `InboundReaction`: on a proposal, 👍 is the same approval event as the
 * Approve button.
 */
export function TapbackPicker({ onPick }: { onPick: (tapback: string) => void }) {
  return (
    <div className="tapback-picker" role="menu" data-testid="tapback-picker">
      {TAPBACKS.map((t) => (
        <button
          key={t}
          type="button"
          role="menuitem"
          data-testid={`tapback-${t}`}
          aria-label={`react ${t}`}
          onClick={() => onPick(t)}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

function MessageRow(props: {
  msg: ThreadMessage;
  group: SimGroup;
  me: SimMember;
  first: boolean;
  last: boolean;
  delivered: boolean;
  handlers: ThreadHandlers;
  readOnly: boolean;
}) {
  const { msg, group, me, first, last, delivered, handlers, readOnly } = props;
  const [picker, setPicker] = useState(false);
  const outgoing = !msg.isTrav && msg.from === me.handle;
  const side = outgoing ? 'out' : 'in';
  const content = msg.card ? (
    <Card
      msg={msg}
      group={group}
      me={me}
      readOnly={readOnly}
      onAction={(a, v) => handlers.onAction(msg, a, v)}
      {...(handlers.onShowDms ? { onShowDms: handlers.onShowDms } : {})}
    />
  ) : (
    <div
      className={`bubble ${side}${last ? ' tail' : ''}${msg.renderedAsCard ? ' as-card' : ''}`}
      data-testid={msg.isTrav ? 'bubble-trav' : 'bubble'}
    >
      <Text text={msg.text} outgoing={outgoing} />
    </div>
  );
  return (
    <div className={`msg-row ${side}`} data-message-id={msg.messageId}>
      {!outgoing ? (
        <div className="avatar-slot">
          {last ? (
            <Avatar group={group} handle={msg.from} name={msg.fromName} isTrav={msg.isTrav} />
          ) : null}
        </div>
      ) : null}
      <div className="msg-col">
        {first && !outgoing ? (
          <div className="sender-name">{msg.isTrav ? 'Trav' : msg.fromName}</div>
        ) : null}
        <div
          className="bubble-wrap"
          data-tapbacks={readOnly ? 'off' : 'on'}
          onClick={(e) => {
            if (readOnly) return;
            if ((e.target as HTMLElement).closest('button')) return;
            setPicker((p) => !p);
          }}
        >
          {content}
          <Reactions msg={msg} />
          {picker && !readOnly ? (
            <TapbackPicker
              onPick={(t) => {
                setPicker(false);
                handlers.onReact(msg, t);
              }}
            />
          ) : null}
        </div>
        {delivered ? <div className="delivered">Delivered</div> : null}
      </div>
    </div>
  );
}

export function TypingIndicator({ group }: { group: SimGroup }) {
  return (
    <div className="msg-row in" data-testid="typing">
      <div className="avatar-slot">
        <Avatar group={group} handle="trav" name="Trav" isTrav />
      </div>
      <div className="msg-col">
        <div className="bubble in tail typing">
          <span className="dot" />
          <span className="dot" />
          <span className="dot" />
        </div>
      </div>
    </div>
  );
}

export function Thread(props: {
  entries: readonly ThreadEntry[];
  group: SimGroup;
  me: SimMember;
  typing: boolean;
  handlers: ThreadHandlers;
  /** Show cards and tapbacks without buttons or the tapback picker (someone else's DM). */
  readOnly?: boolean;
  testId?: string;
  empty?: string;
}) {
  const { entries, group, me, typing, handlers } = props;
  const layout = layoutThread(entries, group);
  let lastOutgoing = -1;
  entries.forEach((e, i) => {
    if (e.kind === 'message' && !e.isTrav && e.from === me.handle) lastOutgoing = i;
  });
  return (
    <div className="thread" data-testid={props.testId ?? 'thread'}>
      {entries.length === 0 && props.empty ? <div className="empty">{props.empty}</div> : null}
      {entries.map((e, i) => {
        const info = layout[i]!;
        return (
          <div key={`${e.kind}-${e.seq}`}>
            {info.separator ? <div className="separator">{info.separator}</div> : null}
            {e.kind === 'membership' ? (
              <div className="system-line">
                {e.name} {e.type === 'member_joined' ? 'joined' : 'left'} the conversation
              </div>
            ) : (
              <MessageRow
                msg={e}
                group={group}
                me={me}
                first={info.first}
                last={info.last}
                delivered={i === lastOutgoing && i === entries.length - 1}
                handlers={handlers}
                readOnly={props.readOnly ?? false}
              />
            )}
          </div>
        );
      })}
      {typing ? <TypingIndicator group={group} /> : null}
    </div>
  );
}
