/**
 * Rich card renderers (VOICE §9.3), one per `RichCard` type from
 * packages/core/src/cards.ts. Cards render in Trav's bubble column as a white
 * panel; every card has an uppercase title row and an 11px footer with the
 * time and status. Unknown/degraded cards fall back to `fallbackText`.
 *
 * Buttons call `onAction`, which posts an `InboundButtonTap` through the
 * simulator channel: the same event path as a 👍 tapback.
 */
import type { ReactNode } from 'react';
import { formatClockTime, formatMoney, formatTime } from '@trav/core';
import type {
  Action,
  BookingProposalCard,
  ExpenseConfirmCard,
  Money,
  OptionsCard,
  ReceiptCard,
  RecapCard,
  RichCard,
  SettleUpCard,
  TicketCard,
  WrappedCard,
} from '@trav/core';
import type { SimGroup, SimMember, ThreadMessage } from '../../shared/types.js';
import { avatarColor, initials, mayAct, planButtons } from '../logic.js';

export interface CardProps {
  readonly msg: ThreadMessage;
  readonly group: SimGroup;
  readonly me: SimMember;
  readonly onAction: (action: Action, value?: string) => void;
  /** Receipt "N tickets sent" link: highlight these members' DM tabs. */
  readonly onShowDms?: (memberIds: readonly string[]) => void;
  /** Look, don't tap: no action buttons anywhere on the card (someone else's DM). */
  readonly readOnly?: boolean;
}

function nameOf(group: SimGroup, memberId: string): string {
  return group.members.find((m) => m.memberId === memberId)?.name ?? memberId;
}

function handleOf(group: SimGroup, memberId: string): string {
  return group.members.find((m) => m.memberId === memberId)?.handle ?? memberId;
}

function Chip({ group, memberId, extra }: { group: SimGroup; memberId: string; extra?: string }) {
  const name = nameOf(group, memberId);
  return (
    <span className="chip" data-testid={`chip-${memberId}`}>
      <span
        className="chip-avatar"
        style={{ background: avatarColor(group, handleOf(group, memberId)) }}
      >
        {initials(name)}
      </span>
      {name}
      {extra ? <span className="chip-extra"> {extra}</span> : null}
    </span>
  );
}

function RefundChip({
  refundable,
  deadline,
  tz,
}: {
  refundable: boolean;
  deadline?: string;
  tz: string;
}) {
  return refundable ? (
    <span className="status-chip green">
      refundable{deadline ? ` until ${formatClockTime(deadline, tz)}` : ''}
    </span>
  ) : (
    <span className="status-chip amber">non-refundable</span>
  );
}

function Row({ label, value, strong }: { label: ReactNode; value: ReactNode; strong?: boolean }) {
  return (
    <div className={`row${strong ? ' strong' : ''}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function Buttons({
  msg,
  group,
  me,
  onAction,
  hide,
  readOnly,
}: CardProps & { hide?: ReadonlySet<string> }) {
  const plan0 = planButtons(msg, me, group);
  const plan = hide ? { ...plan0, buttons: plan0.buttons.filter((a) => !hide.has(a.id)) } : plan0;
  if (msg.cardState && msg.cardState.liveActionIds.length === 0 && msg.cardState.label) {
    const at = msg.cardState.at ? ` · ${formatClockTime(msg.cardState.at, group.timeZone)}` : '';
    return (
      <div className="status-line" data-testid="card-status">
        <span
          className={`status-chip ${msg.cardState.status === 'approved' || msg.cardState.status === 'booked' ? 'green' : 'gray'}`}
        >
          {msg.cardState.label}
          {at}
        </span>
      </div>
    );
  }
  if (readOnly) return null;
  if (plan.buttons.length === 0) {
    return plan.waitingOn ? (
      <div className="waiting" data-testid="card-waiting">
        {plan.waitingOn}
      </div>
    ) : null;
  }
  return (
    <div className="actions">
      {plan.buttons.map((a) => (
        <button
          key={a.id}
          type="button"
          className={`btn ${a.style}`}
          data-testid={`action-${a.id}`}
          onClick={() => onAction(a)}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

function Footer({ msg, group, status }: { msg: ThreadMessage; group: SimGroup; status?: string }) {
  const s = status ?? msg.cardState?.status;
  return (
    <div className="card-footer">
      {formatClockTime(msg.at, group.timeZone)}
      {s ? ` · ${s}` : ''}
    </div>
  );
}

function money(m: Money | undefined): string {
  return m ? formatMoney(m) : '';
}

function ProposalBody({
  card,
  group,
  at,
}: {
  card: BookingProposalCard;
  group: SimGroup;
  at: string;
}) {
  const tz = group.timeZone;
  return (
    <>
      <div className="card-item">{card.item.name}</div>
      <div className="muted">
        {[card.item.venue, card.item.startsAt ? formatTime(card.item.startsAt, tz, at) : undefined]
          .filter(Boolean)
          .join(' · ')}
        {` · ${card.quantity} ${card.quantity === 1 ? 'ticket' : 'tickets'}`}
      </div>
      <div className="chips" data-testid="proposal-charged">
        {card.charged.map((p) => (
          <Chip key={p.memberId} group={group} memberId={p.memberId} />
        ))}
      </div>
      {card.excluded && card.excluded.length > 0 ? (
        <div className="muted">not: {card.excluded.map((e) => e.name).join(', ')}</div>
      ) : null}
      <div className="price">
        {formatMoney(card.pricePerPerson)} each · {formatMoney(card.total)} total
      </div>
      <div className="chips">
        <RefundChip
          refundable={card.refundable}
          {...(card.refundDeadline ? { deadline: card.refundDeadline } : {})}
          tz={tz}
        />
        <span className="status-chip gray">
          {card.paidBy.kind === 'member_card'
            ? `${nameOf(group, card.paidBy.memberId)}'s card`
            : 'each on own card'}
        </span>
      </div>
      {card.policy.overCap || card.policy.reason ? (
        <div className="policy amber-text">{card.policy.reason ?? 'over the cap'}</div>
      ) : null}
      <div className="muted small">held until {formatClockTime(card.holdExpiresAt, tz)}</div>
    </>
  );
}

function ReceiptBody({
  card,
  group,
  onShowDms,
}: {
  card: ReceiptCard;
  group: SimGroup;
  onShowDms?: CardProps['onShowDms'];
}) {
  const tickets = card.tickets ?? [];
  return (
    <>
      <div className="card-item">
        {card.merchant} <span className="muted">· {card.orderRef}</span>
      </div>
      <table className="items">
        <tbody>
          {card.lineItems.map((li, i) => (
            <tr key={i}>
              <td>{li.label}</td>
              <td className="num">{li.qty}</td>
              <td className="num">{formatMoney(li.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Row label="subtotal" value={formatMoney(card.subtotal)} />
      {card.fees ? <Row label="fees" value={money(card.fees)} /> : null}
      {card.tax ? <Row label="tax" value={money(card.tax)} /> : null}
      <Row label="total" value={formatMoney(card.total)} strong />
      <Row
        label="paid by"
        value={
          card.paidBy.kind === 'member_card' ? (
            <Chip group={group} memberId={card.paidBy.memberId} />
          ) : (
            'each on own card'
          )
        }
      />
      <div className="muted small">on the tab</div>
      <div className="chips" data-testid="receipt-split">
        {card.ledger.split.map((p) => (
          <Chip
            key={p.memberId}
            group={group}
            memberId={p.memberId}
            {...(p.share ? { extra: formatMoney(p.share) } : {})}
          />
        ))}
      </div>
      <RefundChip
        refundable={card.refundable}
        {...(card.refundDeadline ? { deadline: card.refundDeadline } : {})}
        tz={group.timeZone}
      />
      {tickets.length > 0 ? (
        <button
          type="button"
          className="link"
          data-testid="receipt-tickets-link"
          onClick={() => onShowDms?.(tickets.map((t) => t.memberId))}
        >
          {tickets.length} {tickets.length === 1 ? 'ticket' : 'tickets'} sent
        </button>
      ) : null}
    </>
  );
}

function TicketBody({ card, group }: { card: TicketCard; group: SimGroup }) {
  const tz = group.timeZone;
  const seat = card.seat
    ? (['gate', 'section', 'row', 'seat'] as const)
        .filter((k) => card.seat?.[k])
        .map((k) => `${k} ${card.seat?.[k]}`)
    : [];
  return (
    <>
      <img
        className="qr"
        src={card.qr.dataUrl}
        alt={`QR ticket for ${card.holderName}`}
        width={160}
        height={160}
      />
      <div className="card-item center">{card.event.name}</div>
      <div className="muted center">
        {card.event.venue}
        {card.event.address ? ` · ${card.event.address}` : ''}
      </div>
      {card.event.doorsAt ? (
        <div className="muted center">doors {formatClockTime(card.event.doorsAt, tz)}</div>
      ) : null}
      {seat.length > 0 ? <div className="seat-grid">{seat.join(' · ')}</div> : null}
      <div className="center">{card.holderName}</div>
      <div className="lock-line">🔒 yours only{card.notes ? ` · ${card.notes}` : ''}</div>
    </>
  );
}

const SOURCE_BADGE: Readonly<Record<string, string>> = {
  chat: 'chat',
  receipt_photo: 'photo',
  email_receipt: 'email',
  card_transaction: 'card',
  booking: 'booking',
};

function ExpenseItem({ card, group }: { card: ExpenseConfirmCard; group: SimGroup }) {
  return (
    <>
      <div className="card-item">
        {card.description} <span className="badge">{SOURCE_BADGE[card.source] ?? card.source}</span>
      </div>
      <div className="amount">{formatMoney(card.amount)}</div>
      <Row label="paid by" value={<Chip group={group} memberId={card.paidBy} />} />
      <div className="chips">
        {card.split.participants.map((p) => (
          <Chip
            key={p.memberId}
            group={group}
            memberId={p.memberId}
            {...(p.share ? { extra: formatMoney(p.share) } : {})}
          />
        ))}
      </div>
      {card.split.excluded && card.split.excluded.length > 0 ? (
        <div className="muted">not: {card.split.excluded.map((e) => e.name).join(', ')}</div>
      ) : null}
      {card.status === 'pending' && card.classifier ? (
        <div className="muted small">
          {card.classifier.looksShared ? 'looks shared' : 'looks personal'} (
          {Math.round(card.classifier.confidence * 100)}%)
        </div>
      ) : null}
      {card.lowConfidence ? <div className="amber-text small">please check the total</div> : null}
    </>
  );
}

function ExpenseBody(props: CardProps & { card: ExpenseConfirmCard }) {
  const { card, group, msg, me, onAction, readOnly } = props;
  const items = card.digestItems ?? [];
  if (items.length === 0) return <ExpenseItem card={card} group={group} />;
  const live = new Set(msg.cardState?.liveActionIds ?? msg.actions.map((a) => a.id));
  const actions = readOnly ? [] : msg.actions.filter((a) => live.has(a.id) && mayAct(a, card, me));
  return (
    <div className="digest">
      {items.map((item) => (
        <div key={item.cardId} className="digest-item">
          <ExpenseItem card={item} group={group} />
          {actions.length > 0 ? (
            <div className="actions">
              {actions.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`btn ${a.style}`}
                  onClick={() => onAction(a, item.expenseId)}
                >
                  {a.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function SettleBody(props: {
  card: SettleUpCard;
  group: SimGroup;
  compact?: boolean;
  paidAction?: Action;
  onAction?: CardProps['onAction'];
}) {
  const { card, group, compact, paidAction, onAction } = props;
  return (
    <div className={compact ? 'settle compact' : 'settle'}>
      {card.balances.map((b) => (
        <Row
          key={b.memberId}
          label={b.name}
          value={
            <span
              className={
                b.net.amountMinor > 0 ? 'green-text' : b.net.amountMinor < 0 ? 'red-text' : 'muted'
              }
            >
              {b.net.amountMinor > 0 ? '+' : ''}
              {formatMoney(b.net)}
            </span>
          }
        />
      ))}
      {card.mode === 'final' || card.transfers.length > 0
        ? card.transfers.map((t, i) => (
            <div key={i} className="row transfer">
              <span>
                {nameOf(group, t.from)} → {nameOf(group, t.to)} {formatMoney(t.amount)}
              </span>
              {t.paid ? (
                <span className="status-chip green">paid</span>
              ) : paidAction && onAction && card.mode === 'final' && !compact ? (
                <button
                  type="button"
                  className="btn secondary small"
                  onClick={() => onAction(paidAction, `${t.from}:${t.to}`)}
                >
                  {paidAction.label}
                </button>
              ) : null}
            </div>
          ))
        : null}
      <div className="muted small">total spent {formatMoney(card.totalSpent)}</div>
    </div>
  );
}

function Photos({ photos, max }: { photos: RecapCard['photos']; max: number }) {
  if (photos.length === 0) return null;
  return (
    <div className="photos">
      {photos.slice(0, max).map((p, i) => (
        <img key={i} src={p.url} alt={p.alt} />
      ))}
    </div>
  );
}

function RecapBody({ card, group }: { card: RecapCard; group: SimGroup }) {
  return (
    <>
      <div className="muted small">last night</div>
      {card.lastNight.events.map((e, i) => (
        <div key={i} className="recap-event">
          <Row label={e.label} value={money(e.amount)} />
          <div className="chips">
            {e.attendees.map((id) => (
              <Chip key={id} group={group} memberId={id} />
            ))}
          </div>
        </div>
      ))}
      <Row label="total" value={formatMoney(card.lastNight.total)} strong />
      {card.roastLines && card.roastLines.length > 0 ? (
        <div className="roast">
          {card.roastLines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      ) : null}
      <SettleBody card={card.settle} group={group} compact />
      {card.today && card.today.length > 0 ? (
        <>
          <div className="muted small">today</div>
          {card.today.map((t, i) => (
            <Row key={i} label={t.label} value={formatClockTime(t.startsAt, group.timeZone)} />
          ))}
        </>
      ) : null}
      <Photos photos={card.photos} max={3} />
    </>
  );
}

function WrappedBody({ card, group }: { card: WrappedCard; group: SimGroup }) {
  const max = Math.max(1, ...card.totals.byCategory.map((c) => c.amount.amountMinor));
  return (
    <>
      <div className="wrapped-header">
        <div className="wrapped-name">{card.trip.name}</div>
        <div>
          {card.trip.days} days · {card.trip.people} people
        </div>
        {card.trip.startDate !== undefined && card.trip.endDate !== undefined ? (
          <div className="muted small" data-testid="wrapped-dates">
            {card.trip.startDate} → {card.trip.endDate}
          </div>
        ) : null}
      </div>
      <div className="stats">
        <div className="stat">
          <div className="big">{formatMoney(card.totals.spent)}</div>
          <div className="muted small">spent</div>
        </div>
        <div className="stat">
          <div className="big">{formatMoney(card.totals.perPerson)}</div>
          <div className="muted small">each</div>
        </div>
        {card.stats.map((s, i) => (
          <div key={i} className="stat">
            <div className="big">{s.value}</div>
            <div className="muted small">{s.label}</div>
          </div>
        ))}
      </div>
      <div className="bars">
        {card.totals.byCategory.map((c) => (
          <div key={c.category} className="bar-row">
            <span>{c.category}</span>
            <span
              className="bar"
              style={{ width: `${Math.round((c.amount.amountMinor / max) * 100)}%` }}
            />
            <span>{formatMoney(c.amount)}</span>
          </div>
        ))}
      </div>
      <div className="awards">
        {card.awards.map((a, i) => (
          <div key={i} className="award">
            <Chip group={group} memberId={a.memberId} />
            <div className="award-title">{a.title}</div>
            <div className="muted small">{a.evidence}</div>
          </div>
        ))}
      </div>
      <Photos photos={card.photos} max={6} />
      <SettleBody card={card.finalSettle} group={group} compact />
      {card.closing !== undefined ? (
        <div className="muted small" data-testid="wrapped-closing">
          {card.closing.text}
        </div>
      ) : null}
    </>
  );
}

function OptionsBody(props: CardProps & { card: OptionsCard }) {
  const { card, msg, me, onAction } = props;
  const live = new Set(msg.cardState?.liveActionIds ?? []);
  const canPick =
    !props.readOnly &&
    card.status === 'pending' &&
    live.has('pick') &&
    mayAct(card.pickAction, card, me);
  return (
    <>
      <div className="muted">{card.context}</div>
      {card.options.map((o) => (
        <div key={o.id} className="option">
          <div className="row">
            <span>
              {o.index}. {o.label}
            </span>
            <span>{formatMoney(o.price)}</span>
          </div>
          <div className="chips">
            <RefundChip refundable={o.refundable} tz={props.group.timeZone} />
            <span className="muted small">{o.tradeoff}</span>
          </div>
        </div>
      ))}
      {canPick ? (
        <div className="actions">
          {card.options.map((o) => (
            <button
              key={o.id}
              type="button"
              className="btn secondary"
              data-testid={`pick-${o.index}`}
              onClick={() => onAction(card.pickAction, o.id)}
            >
              Option {o.index}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

function body(card: RichCard, props: CardProps): ReactNode {
  switch (card.type) {
    case 'booking_proposal':
      return <ProposalBody card={card} group={props.group} at={props.msg.at} />;
    case 'receipt':
      return (
        <ReceiptBody
          card={card}
          group={props.group}
          {...(props.onShowDms ? { onShowDms: props.onShowDms } : {})}
        />
      );
    case 'ticket':
      return <TicketBody card={card} group={props.group} />;
    case 'expense_confirm':
      return <ExpenseBody {...props} card={card} />;
    case 'settle_up': {
      const paid = props.readOnly ? undefined : props.msg.actions.find((a) => a.id === 'paid');
      return (
        <SettleBody
          card={card}
          group={props.group}
          {...(paid ? { paidAction: paid } : {})}
          onAction={props.onAction}
        />
      );
    }
    case 'recap':
      return <RecapBody card={card} group={props.group} />;
    case 'wrapped':
      return <WrappedBody card={card} group={props.group} />;
    case 'options':
      return <OptionsBody {...props} card={card} />;
    default:
      // A card type this UI doesn't know yet: show the text fallback inside the
      // panel rather than an empty box (MessageRow hides `msg.text` for cards).
      return <FallbackBody msg={props.msg} />;
  }
}

function FallbackBody({ msg }: { msg: ThreadMessage }) {
  const card = msg.card as { readonly fallbackText?: unknown } | undefined;
  const text =
    msg.text !== '' ? msg.text : typeof card?.fallbackText === 'string' ? card.fallbackText : '';
  return (
    <div className="card-fallback" data-testid="card-fallback">
      {text.split('\n').map((line, i) => (
        <div key={i}>{line}</div>
      ))}
    </div>
  );
}

/** Actions rendered inside the body (per option / per transfer / per digest item), not in the button row. */
function inlineActionIds(card: RichCard): ReadonlySet<string> {
  if (card.type === 'options') return new Set(['pick']);
  if (card.type === 'settle_up') return new Set(['paid']);
  if (card.type === 'expense_confirm' && (card.digestItems ?? []).length > 0) {
    return new Set(['confirm', 'keep_private', 'undo']);
  }
  return new Set();
}

export function Card(props: CardProps) {
  const card = props.msg.card;
  if (!card) return null;
  const wrapped = card.type === 'wrapped';
  return (
    <div
      className={`card card-${card.type}`}
      data-testid={`card-${card.type}`}
      data-card-id={card.cardId}
    >
      {wrapped ? null : <div className="card-title">{card.title}</div>}
      {body(card, props)}
      <Buttons {...props} hide={inlineActionIds(card)} />
      {wrapped ? (
        <div className="actions">
          <button
            type="button"
            className="btn secondary"
            onClick={() => void navigator.clipboard?.writeText(card.fallbackText)}
          >
            Share
          </button>
        </div>
      ) : null}
      <Footer msg={props.msg} group={props.group} />
    </div>
  );
}
