import { describe, expect, it } from 'vitest';
import { feeFrequency, scopeBlock, scopeLines } from '../toLetter';
import type { ServiceScope } from '../api';

const scope: ServiceScope = {
  code: 'JNS_GST_RETURNS', name: 'GST Return Filing & Compliance', category: 'GST', billing_frequency: 'Monthly', service_code: 'GST_FILING',
  items: [
    { kind: 'scope', content: 'Prepare and file GSTR-1.' },
    { kind: 'scope', content: 'Reconcile purchases with GSTR-2B & flag <differences>.' },
    { kind: 'exclusion', content: 'GST notices.' },
    { kind: 'note', content: 'Advice depends on facts shared.' },
  ],
};

describe('scope → letter text', () => {
  it('writes headed, bulleted sections in document order with client extras', () => {
    const lines = scopeLines(scope, { timeline: 'GSTR-1 by the 11th', information: 'Sales register', deliverables: '', exclusions: 'Refunds' });
    expect(lines.map((l) => [l.kind, l.html])).toEqual([
      ['p', '<b>Scope of services</b>'],
      ['bullet', 'Prepare and file GSTR-1.'],
      ['bullet', 'Reconcile purchases with GSTR-2B &amp; flag &lt;differences&gt;.'],
      ['p', '<b>Client responsibilities</b>'],
      ['bullet', 'Provide: Sales register'],
      ['p', '<b>Exclusions / separately chargeable services</b>'],
      ['bullet', 'GST notices.'],
      ['bullet', 'Refunds'],
      ['p', '<b>Timeline</b>'],
      ['p', 'GSTR-1 by the 11th'],
      ['p', '<i>Important note: Advice depends on facts shared.</i>'],
    ]);
  });

  it('is an ordinary titled section block', () => {
    const b = scopeBlock('b1', scope, { timeline: '', information: '', deliverables: '', exclusions: '' });
    expect(b).toMatchObject({ id: 'b1', key: 'section', enabled: true, title: 'GST Return Filing & Compliance' });
  });

  it('words the fee frequency as the fee table does', () => {
    expect(feeFrequency('Monthly')).toBe('per month');
    expect(feeFrequency('One-time')).toBe('one-time');
    expect(feeFrequency('Every 2 months')).toBe('Every 2 months');
  });
});
