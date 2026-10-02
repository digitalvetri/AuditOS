/**
 * Phone card layout for hand-built tables.
 *
 * Shared table components (workstation Table, ListTable, Books Table) already
 * give each cell its column name as `data-label`, and their wrapper the
 * `m-cards` class, so below 768px mobile.css stacks every row as a card.
 * Tables written by hand with the CRM look (`table.hr-float`) do not — on a
 * phone they stayed wider than the screen. This fills the gap without
 * touching each page: it copies each header into the cells beneath it and
 * marks the table's wrapper `m-cards`.
 *
 * Presentation only. Desktop (1280px+) tables are never changed. The first cell of a row is left unlabelled — it
 * becomes the card's title.
 */
function labelTable(table: HTMLTableElement) {
  const heads = [...table.querySelectorAll<HTMLTableCellElement>(':scope > thead > tr:last-child > th')];
  if (!heads.length) return;
  // Header text by column index, honouring colspan.
  const names: string[] = [];
  for (const th of heads) for (let k = 0; k < (th.colSpan || 1); k++) names.push((th.textContent ?? '').trim());
  for (const tr of table.querySelectorAll<HTMLTableRowElement>(':scope > tbody > tr')) {
    let col = 0;
    [...tr.cells].forEach((td, i) => {
      if (!td.hasAttribute('data-label')) {
        td.setAttribute('data-label', i === 0 || td.colSpan > 1 ? '' : (names[col] ?? ''));
      }
      col += td.colSpan || 1;
    });
  }
  const wrap = table.parentElement;
  if (wrap && !wrap.classList.contains('m-cards')) wrap.classList.add('m-cards');
}

/**
 * Landscape tablets / small laptops (1024–1279px): the sidebar is open, so
 * the content area can be narrower than a wide table. Only a table that
 * genuinely does not fit gets `m-cards-tab` (the 2-up card grid); one that
 * fits stays a table. Measured with the class off, so it never flip-flops.
 */
function fitTables(remeasure: boolean) {
  const mid = innerWidth >= 1024 && innerWidth < 1280;
  document.querySelectorAll<HTMLElement>('main .m-cards').forEach((wrap) => {
    const table = wrap.querySelector('table');
    if (!table) return;
    if (!mid) { wrap.classList.remove('m-cards-tab'); return; }
    if (wrap.classList.contains('m-cards-tab') && !remeasure) return;
    wrap.classList.remove('m-cards-tab');
    if (table.scrollWidth > wrap.clientWidth + 2) wrap.classList.add('m-cards-tab');
  });
}

let queued = false;
let resized = false;
function scan() {
  queued = false;
  document.querySelectorAll<HTMLTableElement>('main table.hr-float').forEach(labelTable);
  fitTables(resized);
  resized = false;
}

export function installPhoneTables() {
  const run = () => { if (!queued) { queued = true; requestAnimationFrame(scan); } };
  new MutationObserver(run).observe(document.body, { childList: true, subtree: true });
  addEventListener('resize', () => { resized = true; run(); });
  run();
}
