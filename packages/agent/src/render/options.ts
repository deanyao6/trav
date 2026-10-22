/**
 * Options / "nothing in budget, closest options" (VOICE §4.10 C, card `options`).
 * Each option states its price, refundability and the trade-off that makes it
 * not the first choice. Reply with a number (pick aliases "1".."n") or drop it.
 */
import type { Money, OptionsCard, OutboundMessage } from '@trav/core';
import { TravError, formatMoney } from '@trav/core';
import type { RenderContext } from './common.js';
import { GROUP, action, cardMessage, orList } from './common.js';

export interface OptionsRenderInput {
  /** Lowercase context line without trailing punctuation: "nothing for barça under €60 a head this sunday". */
  readonly context: string;
  readonly options: readonly {
    readonly id: string;
    readonly label: string;
    readonly price: Money;
    readonly perPerson?: Money;
    readonly refundable: boolean;
    /** Why it isn't the first choice ("not barça, but it's a match"). */
    readonly tradeoff: string;
  }[];
}

/** 1 context line + 4 options + 1 reply line = the 6-line proposal cap (VOICE §3.1). */
const MAX_OPTIONS = 4;

export function renderOptions(
  input: OptionsRenderInput,
  ctx: RenderContext,
): OutboundMessage & { readonly card: OptionsCard } {
  if (input.options.length === 0) {
    throw new TravError('invalid_argument', 'renderOptions: no options');
  }
  if (input.options.length > MAX_OPTIONS) {
    throw new TravError(
      'invalid_argument',
      `renderOptions: at most ${String(MAX_OPTIONS)} options`,
    );
  }
  const options = input.options.map((o, i) => ({ ...o, index: i + 1 }));
  const lines = [`${input.context}. closest:`];
  for (const o of options) {
    const price =
      o.perPerson !== undefined ? `${formatMoney(o.perPerson)} each` : formatMoney(o.price);
    // VOICE §4.10 C: the trade-off when there is one, else refundability; non-refundable is always said.
    const parts = [price, o.label];
    const tradeoff = o.tradeoff.trim();
    if (tradeoff.length > 0) {
      parts.push(tradeoff);
      if (!o.refundable) parts.push('non-refundable');
    } else {
      parts.push(o.refundable ? 'refundable' : 'non-refundable');
    }
    lines.push(`${String(o.index)}. ${parts.join(' · ')}`);
  }
  const numbers = options.map((o) => String(o.index));
  lines.push(`reply ${orList(numbers)}, or tell me to drop it`);

  const pick = action('pick', { label: 'Pick', textAliases: numbers });
  return cardMessage<OptionsCard>(
    ctx,
    GROUP,
    lines,
    {
      type: 'options',
      title: input.context,
      context: input.context,
      options: options.map((o) => ({
        id: o.id,
        index: o.index,
        label: o.label,
        price: o.price,
        ...(o.perPerson !== undefined ? { perPerson: o.perPerson } : {}),
        refundable: o.refundable,
        tradeoff: o.tradeoff,
      })),
      pickAction: pick,
      status: 'pending',
    },
    { actions: [action('decline', { label: 'Drop it', textAliases: ['drop it', 'nah', 'no'] })] },
  );
}
