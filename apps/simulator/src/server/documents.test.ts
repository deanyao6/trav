import { describe, expect, it } from 'vitest';
import { DEMO_DOCUMENTS, buildIntake, documentsFor } from './documents.js';
import { BARCELONA } from './groups.js';

describe('demo documents', () => {
  it("Sam's 2:14am Uber charge becomes a card intake with typed amounts (VOICE §4.5 A)", async () => {
    const doc = DEMO_DOCUMENTS.find((d) => d.docId === 'doc_bcn_sam_card_1')!;
    const intake = await buildIntake(doc);
    expect(intake).toMatchObject({
      groupId: 'grp_barcelona',
      ownerMemberId: 'mem_sam',
      source: 'card_descriptor',
      itemId: 'txn_sam_uber_0315',
      extracted: {
        amountMinor: 2340,
        currency: 'EUR',
        merchantDisplay: 'Uber',
        occurredAt: '2026-03-15T02:14:00+01:00',
        category: 'transport',
      },
    });
    expect(Number.isInteger(intake.extracted!.amountMinor)).toBe(true);
  });

  it("Priya's Uber email is parsed by the offline receipt parser (VOICE §4.5 C)", async () => {
    const doc = DEMO_DOCUMENTS.find((d) => d.docId === 'doc_bcn_priya_email_1')!;
    const intake = await buildIntake(doc);
    expect(intake.source).toBe('email_receipt');
    expect(intake.extracted).toMatchObject({ amountMinor: 1860, currency: 'EUR', merchantDisplay: 'Uber' });
  });

  it("Maya's injected email still extracts only the real total; the text goes in as untrusted", async () => {
    const doc = DEMO_DOCUMENTS.find((d) => d.docId === 'doc_bcn_maya_email_1')!;
    const intake = await buildIntake(doc);
    expect(intake.extracted?.amountMinor).toBe(2110);
    expect(intake.source).toBe('email_receipt');
  });

  it('every document is owned by a member of its group and builds', async () => {
    for (const d of DEMO_DOCUMENTS) {
      const group = d.groupId === BARCELONA.groupId ? BARCELONA : undefined;
      expect(group?.members.some((m) => m.memberId === d.ownerMemberId)).toBe(true);
      const intake = await buildIntake(d);
      expect(intake.ownerMemberId).toBe(d.ownerMemberId);
      expect(intake.extracted!.amountMinor).toBeGreaterThan(0);
    }
  });

  it('consent: only members who turned the import on in the script have documents', () => {
    const owners = new Set(documentsFor(BARCELONA.groupId).map((d) => `${d.ownerMemberId}:${d.consent}`));
    expect(owners).toEqual(
      new Set([
        'mem_sam:cardImport',
        'mem_dean:cardImport',
        'mem_priya:emailImport',
        'mem_maya:emailImport',
      ]),
    );
    // Jordan and Henry never opted in (fixtures/chats/barcelona.jsonl sys_bcn_0191).
    for (const d of DEMO_DOCUMENTS) {
      expect(['mem_jordan', 'mem_henry']).not.toContain(d.ownerMemberId);
      expect(d.kind === 'card' ? d.consent === 'cardImport' : d.consent === 'emailImport').toBe(true);
    }
  });
});
