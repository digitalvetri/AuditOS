import type { ToolUI } from './types';
import { pdfToExcelUI, excelToPdfUI, pdfToWordUI, wordToPdfUI, imageToPdfUI, csvToExcelUI } from './conversion';
import { mergePdfUI, splitPdfUI, compressPdfUI, unlockPdfUI, esignPdfUI, ocrScanUI } from './pdf';

/** Registry id → per-tool UI. A tool absent here (compliance) renders Coming soon. */
export const TOOL_UI: Record<string, ToolUI> = {
  'pdf-to-excel': pdfToExcelUI,
  'excel-to-pdf': excelToPdfUI,
  'pdf-to-word': pdfToWordUI,
  'word-to-pdf': wordToPdfUI,
  'image-to-pdf': imageToPdfUI,
  'csv-to-excel': csvToExcelUI,
  'merge-pdf': mergePdfUI,
  'split-pdf': splitPdfUI,
  'compress-pdf': compressPdfUI,
  'unlock-pdf': unlockPdfUI,
  'esign-pdf': esignPdfUI,
  'ocr-scan': ocrScanUI,
};
