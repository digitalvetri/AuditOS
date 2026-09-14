import type { ToolUI } from './types';
import { pdfToExcelUI, excelToPdfUI, pdfToWordUI, wordToPdfUI, imageToPdfUI, csvToExcelUI } from './conversion';
import { mergePdfUI, splitPdfUI, compressPdfUI, unlockPdfUI, esignPdfUI, ocrScanUI } from './pdf';
import {
  gstJsonExcelUI, bankStatementToExcelUI, form26asToExcelUI,
  excelToTallyXmlUI, tdsFvuGeneratorUI, invoiceToEInvoiceJsonUI,
} from './compliance';

/** Registry id → per-tool UI. A tool absent here renders Coming soon. */
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
  'gst-json-excel': gstJsonExcelUI,
  'bank-statement-to-excel': bankStatementToExcelUI,
  'form-26as-to-excel': form26asToExcelUI,
  'excel-to-tally-xml': excelToTallyXmlUI,
  'tds-fvu-generator': tdsFvuGeneratorUI,
  'invoice-to-einvoice-json': invoiceToEInvoiceJsonUI,
};
