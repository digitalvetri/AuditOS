/**
 * §6.4 template. Reserved screens must look deliberate:
 *   1. Module name + one-line description
 *   2. Capability list at reduced emphasis
 *   3. Phase line
 *   4. No CTA. No badge. No illustration. Flat surface only (see §7).
 */
export interface ReservedScreenProps {
  title: string;
  tagline: string;
  capabilities: string[];
  phase: string;
}

export function ReservedScreen({ title, tagline, capabilities, phase }: ReservedScreenProps) {
  return (
    <div className="max-w-[720px] mx-auto">
      <div className="bg-white border border-neutral-200 rounded p-6">
        <h1 className="text-20 font-semibold text-neutral-900">{title}</h1>
        <p className="text-13 text-neutral-500 mt-2">{tagline}</p>

        <div className="mt-8">
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-3">
            This module will contain
          </div>
          <ul className="space-y-2">
            {capabilities.map((c) => (
              <li key={c} className="text-13 text-neutral-400">
                {c}
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-8 text-13 text-neutral-500">{phase}</div>
      </div>
    </div>
  );
}
