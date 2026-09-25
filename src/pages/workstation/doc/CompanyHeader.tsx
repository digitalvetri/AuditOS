import { companyHeaderLines, type CompanyHeader } from '@/modules/workstation/docs/model';

/**
 * The optional company header — ONE component for every Doc template. It is
 * rendered as the first unit of page one, in normal document flow (never
 * absolutely positioned), so the page-breaker measures it and the letter
 * starts below it on screen, in print and in the PDF alike.
 */
export function CompanyHeaderBlock({ header }: { header: CompanyHeader }) {
  const { name, lines } = companyHeaderLines(header);
  if (!name && lines.length === 0) return null;
  return (
    <div className="qdoc-company-header">
      {name ? <div className="qdoc-company-header-name">{name}</div> : null}
      {lines.map((l, i) => <div key={i}>{l}</div>)}
    </div>
  );
}
