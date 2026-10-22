import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSimulatedClock, formatIso, parseIso } from '@trav/core';
import {
  CLASSIFIER_MIN_SCORE,
  REPLY_WINDOW_MS,
  detectMention,
  detectMentionRules,
  inReplyWindow,
  type MentionContext,
} from './mention.js';
import type { ClassifyRequest, ClassifyResponse, ModelClient } from './model/client.js';
import { repoRoot } from './model/paths.js';
import { offlineModel, spyModel } from './runtime.testkit.js';

const NOW = '2026-03-14T21:40:00+01:00';

interface LabeledLine {
  readonly id: string;
  readonly lane: 'group' | 'direct';
  readonly text: string;
  readonly expected: {
    readonly addressed: boolean;
    readonly kind: string;
    readonly response?: string;
  };
  readonly via: 'rules' | 'classifier';
  readonly context?: {
    readonly replyToTravMessage?: boolean;
    readonly secondsSinceTravQuestion?: number | null;
  };
}

function loadLabeled(): LabeledLine[] {
  const raw = JSON.parse(
    readFileSync(join(repoRoot(), 'fixtures', 'mentions', 'labeled.json'), 'utf8'),
  ) as {
    lines: LabeledLine[];
  };
  return raw.lines;
}

function ctxFor(line: LabeledLine, now = NOW): MentionContext {
  const seconds = line.context?.secondsSinceTravQuestion;
  return {
    lane: line.lane === 'direct' ? 'dm' : 'group',
    repliesToTrav: line.context?.replyToTravMessage === true,
    platformMention: false,
    ...(typeof seconds === 'number'
      ? { lastTravQuestionAt: formatIso(parseIso(now) - seconds * 1000, 60) }
      : {}),
    now,
  };
}

function base(): MentionContext {
  return { lane: 'group', repliesToTrav: false, platformMention: false, now: NOW };
}

describe('mention detection against fixtures/mentions/labeled.json', () => {
  const lines = loadLabeled();

  it('has at least 30 labeled lines with both classes', () => {
    expect(lines.length).toBeGreaterThanOrEqual(30);
    expect(lines.some((l) => l.expected.addressed)).toBe(true);
    expect(lines.some((l) => !l.expected.addressed)).toBe(true);
  });

  it('100% precision on negatives and ≥95% recall on positives (offline classifier for ambiguous lines)', async () => {
    const clock = createSimulatedClock(NOW);
    const model = spyModel(offlineModel(clock));
    const falsePositives: string[] = [];
    const missed: string[] = [];
    let positives = 0;
    let hits = 0;
    for (const line of lines) {
      const res = await detectMention(line.text, ctxFor(line), model.client);
      if (line.expected.addressed) {
        positives += 1;
        if (res.addressed) hits += 1;
        else missed.push(`${line.id} "${line.text}" (${res.reason})`);
      } else if (res.addressed) {
        falsePositives.push(`${line.id} "${line.text}" (${res.reason})`);
      }
    }
    expect(falsePositives, 'false replies cost trust (VOICE §2)').toEqual([]);
    expect(hits / positives, `missed: ${missed.join('; ')}`).toBeGreaterThanOrEqual(0.95);
    // Ambiguous lines really went to the fast classifier, which never gets tools.
    expect(model.classifies.length).toBeGreaterThan(0);
    expect(model.classifies.every((c) => c.classifierId === 'mention_v1')).toBe(true);
  });

  it('every "thanks" line is addressed with reason thanks (❤️ tapback, no text)', async () => {
    const clock = createSimulatedClock(NOW);
    const model = offlineModel(clock);
    const thanks = lines.filter((l) => l.expected.kind === 'thanks');
    expect(thanks.length).toBeGreaterThanOrEqual(2);
    for (const line of thanks) {
      const res = await detectMention(line.text, ctxFor(line), model);
      expect(res, line.id).toMatchObject({ addressed: true, reason: 'thanks' });
    }
  });
});

describe('mention rules', () => {
  it('@trav anywhere counts, as a whole token only', () => {
    expect(detectMentionRules('@trav who owes who', base())).toMatchObject({
      addressed: true,
      reason: 'at_mention',
    });
    expect(detectMentionRules('ok @trav log €30', base())).toMatchObject({ addressed: true });
    expect(detectMentionRules('@travis grab the keys', base())).toMatchObject({ addressed: false });
    expect(detectMentionRules('mail approvals@trav-bookings.test', base())).toMatchObject({
      addressed: false,
    });
  });

  it('"hey trav" / "trav," / "trav can you" at the start count', () => {
    for (const t of [
      'hey trav what time is the match',
      'trav, split the taxi',
      'trav can you add the kebab',
      'TRAV: settle now',
    ]) {
      expect(detectMentionRules(t, base()), t).toMatchObject({
        addressed: true,
        reason: 'leading_name',
      });
    }
  });

  it('"trav booked it already" mid-sentence third person is not a mention; a leading statement is ambiguous', () => {
    expect(detectMentionRules('did trav get the tickets?', base())).toMatchObject({
      addressed: false,
      reason: 'third_person',
    });
    expect(detectMentionRules('ask trav', base())).toMatchObject({
      addressed: false,
      reason: 'third_person',
    });
    expect(detectMentionRules('trav booked it already', base())).toBe('ambiguous');
  });

  it('ambiguous ⇒ classify(mention_v1); a low score or not_mention stays silent (bias to silence)', async () => {
    const calls: ClassifyRequest<string>[] = [];
    const answer = { label: 'mention', score: 0.4 };
    const model: ModelClient = {
      mode: 'offline',
      complete: () => Promise.reject(new Error('complete must not be called by the mention gate')),
      classify<L extends string>(req: ClassifyRequest<L>): Promise<ClassifyResponse<L>> {
        calls.push(req);
        return Promise.resolve({
          label: answer.label as L,
          score: answer.score,
          usage: { inputTokens: 0, outputTokens: 0 },
          source: 'script',
          scriptKey: 'k',
        });
      },
    };
    expect(await detectMention('trav booked it already', base(), model)).toMatchObject({
      addressed: false,
    });
    expect(calls[0]?.classifierId).toBe('mention_v1');
    answer.score = CLASSIFIER_MIN_SCORE;
    expect(await detectMention('trav booked it already', base(), model)).toMatchObject({
      addressed: true,
      reason: 'classifier',
    });
    answer.label = 'not_mention';
    answer.score = 0.99;
    expect(await detectMention('trav will figure it out', base(), model)).toMatchObject({
      addressed: false,
    });
    // Rule hits never consult the model.
    const before = calls.length;
    await detectMention('@trav hi', base(), model);
    expect(calls.length).toBe(before);
  });

  it('DM lane, quote-reply and platform flag are always addressed', () => {
    expect(detectMentionRules('how much do i owe', { ...base(), lane: 'dm' })).toMatchObject({
      addressed: true,
      reason: 'dm_lane',
    });
    expect(detectMentionRules('yes', { ...base(), repliesToTrav: true })).toMatchObject({
      addressed: true,
      reason: 'reply_to_trav',
    });
    expect(detectMentionRules('yes', { ...base(), platformMention: true })).toMatchObject({
      addressed: true,
      reason: 'at_mention',
    });
  });

  it('a short answer inside the 2-minute window after a Trav question counts; outside it does not', () => {
    const asked = formatIso(parseIso(NOW) - 45_000, 60);
    const ctx: MentionContext = { ...base(), lastTravQuestionAt: asked };
    expect(inReplyWindow(ctx)).toBe(true);
    expect(detectMentionRules('actually 4 of us', ctx)).toMatchObject({
      addressed: true,
      reason: 'reply_window',
    });
    const stale: MentionContext = {
      ...base(),
      lastTravQuestionAt: formatIso(parseIso(NOW) - REPLY_WINDOW_MS - 1000, 60),
    };
    expect(inReplyWindow(stale)).toBe(false);
    expect(detectMentionRules('actually 4 of us', stale)).toMatchObject({
      addressed: false,
      reason: 'none',
    });
    // A long message is a conversation, not an answer.
    const essay =
      'actually i think we should all just go to the beach tomorrow and skip the club because everyone is tired';
    expect(detectMentionRules(essay, ctx)).toMatchObject({ addressed: false });
  });

  it('empty text and "travel"/"Travessera" substrings are silence', () => {
    expect(detectMentionRules('', base())).toMatchObject({ addressed: false });
    expect(detectMentionRules('the travel day is brutal', base())).toMatchObject({
      addressed: false,
      reason: 'none',
    });
    expect(detectMentionRules('Travessera de Gràcia is the street', base())).toMatchObject({
      addressed: false,
    });
  });
});
