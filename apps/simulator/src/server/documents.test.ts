import { describe, expect, it } from 'vitest';
import { DEMO_DOCUMENTS, buildIntake, documentsFor } from './documents.js';
import { BARCELONA } from './groups.js';

describe('demo documents', () => {
  it("a card document is the owner's real card sync (T-067), never a curated intake; it is offered from the charge's time", async () => {
    const doc = DEMO_DOCUMENTS.find((d) => d.docId === 'doc_bcn_crowley_card_1')!;
    await expect(buildIntake(doc)).rejects.toThrow(/card sync/);
    // Crowley's 2:14am Uber (fixtures/transactions/mem_crowley.json txn_crowley_uber_0315).
    expect(doc).toMatchObject({
      kind: 'card',
      sourceItemId: 'txn_crowley_uber_0315',
      availableAt: '2026-03-15T02:14:00+01:00',
    });
    for (const d of DEMO_DOCUMENTS) expect(d.kind === 'card').toBe(d.availableAt !== undefined);
  });

  it("Arjun's Uber email is parsed by the offline receipt parser (VOICE §4.5 C)", async () => {
    const doc = DEMO_DOCUMENTS.find((d) => d.docId === 'doc_bcn_arjun_email_1')!;
    const intake = await buildIntake(doc);
    expect(intake.source).toBe('email_receipt');
    expect(intake.extracted).toMatchObject({
      amountMinor: 1860,
      currency: 'EUR',
      merchantDisplay: 'Uber',
    });
  });

  it("Chase's injected email still extracts only the real total; the text goes in as untrusted", async () => {
    const doc = DEMO_DOCUMENTS.find((d) => d.docId === 'doc_bcn_chase_email_1')!;
    const intake = await buildIntake(doc);
    expect(intake.extracted?.amountMinor).toBe(2110);
    expect(intake.source).toBe('email_receipt');
  });

  it('every document is owned by a member of its group, and every email builds', async () => {
    for (const d of DEMO_DOCUMENTS) {
      const group = d.groupId === BARCELONA.groupId ? BARCELONA : undefined;
      expect(group?.members.some((m) => m.memberId === d.ownerMemberId)).toBe(true);
      if (d.kind === 'card') continue;
      const intake = await buildIntake(d);
      expect(intake.ownerMemberId).toBe(d.ownerMemberId);
      expect(intake.extracted!.amountMinor).toBeGreaterThan(0);
    }
  });

  it('consent: only members who turned the import on in the script have documents', () => {
    const owners = new Set(
      documentsFor(BARCELONA.groupId).map((d) => `${d.ownerMemberId}:${d.consent}`),
    );
    expect(owners).toEqual(
      new Set([
        'mem_crowley:cardImport',
        'mem_dean:cardImport',
        'mem_arjun:emailImport',
        'mem_chase:emailImport',
      ]),
    );
    // Piotr and Henry never opted in (fixtures/chats/barcelona.jsonl sys_bcn_0191).
    for (const d of DEMO_DOCUMENTS) {
      expect(['mem_piotr', 'mem_henry']).not.toContain(d.ownerMemberId);
      expect(d.kind === 'card' ? d.consent === 'cardImport' : d.consent === 'emailImport').toBe(
        true,
      );
    }
  });
});
