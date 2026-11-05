/**
 * T-019-b UI controls without a browser: the top-bar clock buttons, the
 * replay button, the DM rail (lock line, "send as" highlight, intake button,
 * Henry's empty tab) and the tapback picker.
 *
 * Markup is checked with `renderToStaticMarkup` against real backend states.
 * Clicks are checked by walking the element tree: hook-free components
 * (TopBar, DmRail, TapbackPicker) are called as functions and their
 * buttons' `onClick` invoked, so the wiring (which step / mode / doc / emoji
 * each button sends) is what the browser would run.
 */
import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ClockStep, SimState, ThreadMessage } from '../shared/types.js';
import { BARCELONA, RAZZMATAZZ_ASK } from '../server/groups.js';
import { handleApi } from '../server/routes.js';
import { loadBarcelonaScript, withReplay } from '../server/replay.js';
import { createScriptedBackend } from '../server/scripted.js';
import { AppView } from './App.js';
import type { AppViewProps } from './App.js';
import { TapbackPicker } from './components/Thread.js';
import { TAPBACKS } from './logic.js';

const noop = () => {};

function props(state: SimState, meHandle: string, over: Partial<AppViewProps> = {}): AppViewProps {
  const me = BARCELONA.members.find((m) => m.handle === meHandle)!;
  return {
    state,
    groupId: BARCELONA.groupId,
    meHandle,
    dmMemberId: me.memberId,
    highlightDms: [],
    draft: '',
    onSelectGroup: noop,
    onSelectMe: noop,
    onSelectDm: noop,
    onDraft: noop,
    onSend: noop,
    handlers: { onAction: noop, onReact: noop },
    ...over,
  };
}

function html(p: AppViewProps): string {
  return renderToStaticMarkup(<AppView {...p} />);
}

type AnyProps = Record<string, unknown> & { children?: ReactNode };

/**
 * Every host element in the tree, expanding function components that use no
 * hooks (a component that calls a hook outside a render throws; its subtree,
 * e.g. a thread bubble, is skipped).
 */
function hostElements(node: ReactNode, out: ReactElement<AnyProps>[] = []): ReactElement<AnyProps>[] {
  if (Array.isArray(node)) {
    for (const n of node) hostElements(n as ReactNode, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const el = node as ReactElement<AnyProps>;
  if (typeof el.type === 'function') {
    let rendered: ReactNode;
    try {
      rendered = (el.type as (p: AnyProps) => ReactNode)(el.props);
    } catch {
      return out;
    }
    return hostElements(rendered, out);
  }
  if (typeof el.type === 'string') out.push(el);
  return hostElements(el.props.children, out);
}

function byTestId(root: ReactNode, id: string): ReactElement<AnyProps> {
  const found = hostElements(root).find((e) => e.props['data-testid'] === id);
  if (!found) throw new Error(`no element ${id}`);
  return found;
}

function click(root: ReactNode, id: string): void {
  const el = byTestId(root, id);
  expect(el.props['disabled'], `${id} is disabled`).not.toBe(true);
  (el.props['onClick'] as () => void)();
}

async function state3() {
  const b = await createScriptedBackend();
  await b.inject({ type: 'message', from: 'h_dean', text: RAZZMATAZZ_ASK, groupId: BARCELONA.groupId });
  const proposal = b
    .state()
    .groups[0]!.thread.find(
      (e): e is ThreadMessage => e.kind === 'message' && e.card?.type === 'booking_proposal',
    )!;
  await b.inject({ type: 'button_tap', from: 'h_dean', cardMessageId: proposal.messageId, actionId: 'approve' });
  return b;
}

describe('top bar: clock and replay', () => {
  it('renders the clock label and the three clock buttons; each sends its step', async () => {
    const b = await state3();
    const s = b.state();
    const steps: ClockStep[] = [];
    const p = props(s, 'h_dean', { onClock: (step) => steps.push(step) });
    const markup = html(p);
    expect(markup).toContain('data-testid="clock">sat mar 14 · 9:4');
    expect(markup).toContain('· day 3<');
    for (const [id, label] of [
      ['clock-hour', '+1 hour'],
      ['clock-morning', 'next morning'],
      ['clock-end_of_trip', 'end of trip'],
    ] as const) {
      expect(markup).toContain(`data-testid="${id}"`);
      expect(markup).toContain(`>${label}<`);
    }
    const root = <AppView {...p} />;
    click(root, 'clock-hour');
    click(root, 'clock-morning');
    click(root, 'clock-end_of_trip');
    expect(steps).toEqual(['hour', 'morning', 'end_of_trip']);
  });

  it('clock buttons are disabled while a control request is in flight, and hidden without a clock', async () => {
    const b = await state3();
    const s = b.state();
    const busy = <AppView {...props(s, 'h_dean', { onClock: noop, busy: true })} />;
    expect(byTestId(busy, 'clock-morning').props['disabled']).toBe(true);
    const noClock: SimState = { ...s, controls: { ...s.controls, clock: false } };
    expect(html(props(noClock, 'h_dean', { onClock: noop }))).not.toContain('clock-buttons');
  });

  it('replay: shows progress and the next line; step and play all send their mode', async () => {
    const b = withReplay(await createScriptedBackend(), loadBarcelonaScript());
    const s = b.state();
    const modes: string[] = [];
    const p = props(s, 'h_dean', { onReplay: (m) => modes.push(m) });
    const markup = html(p);
    expect(markup).toContain('replay ▸ 0/199');
    expect(markup).toContain('next: Dean: ok its official. BARCELONA mar 12-17 🇪🇸…');
    const root = <AppView {...p} />;
    click(root, 'replay-step');
    click(root, 'replay-all');
    expect(modes).toEqual(['step', 'all']);

    // After the last line: both buttons disabled.
    await b.replay.all();
    const done = <AppView {...props(b.state(), 'h_dean', { onReplay: noop })} />;
    expect(byTestId(done, 'replay-step').props['disabled']).toBe(true);
    expect(byTestId(done, 'replay-all').props['disabled']).toBe(true);
  });

  it('after a quiet next morning the muted status line says so under the thread, not as a Trav bubble', async () => {
    const b = await state3();
    const before = html(props(b.state(), 'h_dean'));
    const res = await handleApi(b, {
      method: 'POST',
      path: '/api/clock',
      body: { step: 'morning', groupId: BARCELONA.groupId },
    });
    const s = (res.body as { state: SimState }).state;
    const markup = html(props(s, 'h_dean'));
    expect(markup).toContain('data-testid="sim-status"');
    // Nothing reached the embedded runtime's tab overnight: the Morning After (T-015) stays silent.
    expect(markup).toContain('trav stayed quiet (scheduled:morning_after:silent)');
    expect(markup).not.toContain('T-015');
    expect(markup).toContain('sun mar 15 · 10am · day 4');
    const bubbles = (h: string) => h.split('data-testid="bubble-trav"').length;
    expect(bubbles(markup)).toBe(bubbles(before));
    // Another trip never shows Barcelona's line.
    expect(html(props(s, 'h_dean', { groupId: 'grp_lisbon' }))).not.toContain('sim-status');

    const end = await handleApi(b, {
      method: 'POST',
      path: '/api/clock',
      body: { step: 'end_of_trip', groupId: BARCELONA.groupId },
    });
    const endHtml = html(props((end.body as { state: SimState }).state, 'h_dean'));
    // T-016: the Wrapped card posts as a Trav bubble, so no status line under the thread.
    expect(endHtml).not.toContain('no Wrapped yet');
    expect(endHtml).toContain('data-testid="card-wrapped"');
    expect(endHtml).toContain('2026-03-12 → 2026-03-17');
    expect(endHtml).toContain('data-testid="wrapped-closing"');
    expect(endHtml).toContain('wed mar 18 · 10am · trip over');
  });
});

describe('DM rail', () => {
  it('one tab per member, the "send as" tab marked, lock line names whose DM it is', async () => {
    const b = await state3();
    const s = b.state();
    const markup = html(props(s, 'h_priya'));
    expect(markup).toContain("Trav&#x27;s DMs");
    for (const m of BARCELONA.members) expect(markup).toContain(`data-testid="dm-tab-${m.memberId}"`);
    expect(markup).toContain('data-testid="dm-header">🔒 only Priya sees this');
    const root = <AppView {...props(s, 'h_priya')} />;
    const tabs = hostElements(root).filter((e) => String(e.props['data-testid']).startsWith('dm-tab-'));
    expect(tabs.filter((t) => t.props['data-me'] === 'true').map((t) => t.props['data-testid'])).toEqual([
      'dm-tab-mem_priya',
    ]);
    expect(String(byTestId(root, 'dm-tab-mem_priya').props['className'])).toContain('me');
  });

  it('collapses to a narrow strip and back (VOICE §9.1); collapsed shows no DM content', async () => {
    const b = await state3();
    const s = b.state();
    let toggles = 0;
    const open = props(s, 'h_dean', { onToggleDms: () => (toggles += 1) });
    expect(html(open)).toContain('data-testid="dm-thread"');
    click(<AppView {...open} />, 'dm-toggle');
    const closed = html({ ...open, dmsCollapsed: true });
    expect(closed).toContain('data-testid="dm-rail-collapsed"');
    expect(closed).not.toContain('data-testid="dm-thread"');
    expect(closed).not.toContain('card-ticket');
    click(<AppView {...open} dmsCollapsed />, 'dm-toggle');
    expect(toggles).toBe(2);
    // Without a toggle handler the rail is always open.
    expect(html(props(s, 'h_dean', { dmsCollapsed: true }))).toContain('data-testid="dm-thread"');
  });

  it("Henry's tab is empty after the booking, and his rail shows no ticket", async () => {
    const b = await state3();
    const s = b.state();
    expect(s.groups[0]!.dms['mem_henry']).toEqual([]);
    const henry = html(props(s, 'h_henry'));
    const rail = henry.slice(henry.indexOf('class="right-rail"'));
    expect(rail).toContain('only Henry sees this');
    expect(rail).toContain('nothing here yet');
    expect(rail).not.toContain('card-ticket');
  });

  it("Sam's tab offers his own card charge only while sending as Sam; the button feeds that doc", async () => {
    const b = await state3();
    const s = b.state();
    const fed: string[] = [];
    const asSam = props(s, 'h_sam', { onIntake: (id) => fed.push(id) });
    expect(html(asSam)).toContain('>simulate a card charge<');
    click(<AppView {...asSam} />, 'intake-doc_bcn_sam_card_1');
    expect(fed).toEqual(['doc_bcn_sam_card_1']);
    // Dean looking at Sam's tab: view only, no intake button.
    const deanOnSam = html(props(s, 'h_dean', { dmMemberId: 'mem_sam', onIntake: noop }));
    expect(deanOnSam).not.toContain('intake-doc_bcn_sam_card_1');
    expect(deanOnSam).toContain('data-testid="dm-readonly"');
  });

  it("the uber prompt renders in Sam's DM with Share it, never in the group thread markup", async () => {
    const b = await state3();
    const res = await handleApi(b, { method: 'POST', path: '/api/intake', body: { docId: 'doc_bcn_sam_card_1' } });
    const s = (res.body as { state: SimState }).state;
    const markup = html(props(s, 'h_sam'));
    const thread = markup.slice(markup.indexOf('data-testid="thread"'), markup.indexOf('class="right-rail"'));
    const rail = markup.slice(markup.indexOf('class="right-rail"'));
    // The card renders in place of the bubble (VOICE §9.3); its text is the payload's.
    const prompt = s.groups[0]!.dms['mem_sam']!.find(
      (e): e is ThreadMessage => e.kind === 'message' && e.card?.type === 'expense_confirm',
    )!;
    expect(prompt.text).toMatch(/^saw €23\.40 from Uber at 2:14am/);
    expect(rail).toContain('data-testid="card-expense_confirm"');
    expect(rail).toContain('€23.40');
    expect(rail).toContain('>Share it<');
    expect(rail).toContain('>Keep private<');
    expect(thread).not.toContain('23.40');
    expect(thread).not.toContain('card-expense_confirm');
    // Everyone else's view of the group thread is just as clean.
    for (const m of BARCELONA.members) {
      const h = html(props(s, m.handle));
      expect(h.slice(h.indexOf('data-testid="thread"'), h.indexOf('class="right-rail"'))).not.toContain('23.40');
    }
  });
});

describe('tapback picker', () => {
  it('offers ❤️ 👍 👎 😂 ‼️ ❓ in that order; a pick reports the emoji', () => {
    expect([...TAPBACKS]).toEqual(['❤️', '👍', '👎', '😂', '‼️', '❓']);
    const picked: string[] = [];
    const picker = <TapbackPicker onPick={(t) => picked.push(t)} />;
    const markup = renderToStaticMarkup(picker);
    expect(markup).toContain('role="menu"');
    for (const t of TAPBACKS) expect(markup).toContain(`data-testid="tapback-${t}"`);
    click(picker, 'tapback-👍');
    click(picker, 'tapback-❤️');
    expect(picked).toEqual(['👍', '❤️']);
  });

  it('a 👍 picked on the proposal goes through /api/reactions and books, exactly like Approve', async () => {
    const b = await createScriptedBackend();
    await b.inject({ type: 'message', from: 'h_dean', text: RAZZMATAZZ_ASK, groupId: BARCELONA.groupId });
    const proposal = b
      .state()
      .groups[0]!.thread.find(
        (e): e is ThreadMessage => e.kind === 'message' && e.card?.type === 'booking_proposal',
      )!;
    // What App's handlers.onReact posts for a pick.
    const res = await handleApi(b, {
      method: 'POST',
      path: '/api/reactions',
      body: { from: 'h_dean', targetMessageId: proposal.messageId, reaction: '👍' },
    });
    expect(res.status).toBe(200);
    const s = (res.body as { state: SimState }).state;
    const thread = s.groups[0]!.thread.filter((e): e is ThreadMessage => e.kind === 'message');
    expect(thread.some((m) => m.card?.type === 'receipt')).toBe(true);
    expect(thread.find((m) => m.messageId === proposal.messageId)?.cardState?.label).toBe('Approved by Dean');
    const markup = html(props(s, 'h_dean'));
    expect(markup).toContain('tapback-pill');
    expect(b.bookingCount()).toBe(1);
  });

  it('bubbles take tapbacks in the group thread; another member’s DM is view-only', async () => {
    const b = await state3();
    const s = b.state();
    const markup = html(props(s, 'h_dean'));
    const thread = markup.slice(markup.indexOf('data-testid="thread"'), markup.indexOf('class="right-rail"'));
    expect(thread).toContain('data-tapbacks="on"');
    const deanOnPriya = html(props(s, 'h_dean', { dmMemberId: 'mem_priya' }));
    const rail = deanOnPriya.slice(deanOnPriya.indexOf('class="right-rail"'));
    expect(rail).toContain('data-tapbacks="off"');
    expect(rail).not.toContain('data-tapbacks="on"');
  });
});
