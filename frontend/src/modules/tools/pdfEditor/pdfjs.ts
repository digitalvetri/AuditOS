/**
 * pdf.js, loaded only when the PDF editor opens (it is large), with its
 * worker as a separate file. Also the embedded fonts the server draws
 * with, loaded into the page so what is typed looks the way it will print.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { FACE } from './model';

let lib: Promise<typeof import('pdfjs-dist')> | null = null;
export function pdfjs() {
  lib ??= import('pdfjs-dist').then((m) => {
    m.GlobalWorkerOptions.workerSrc = workerUrl;
    return m;
  });
  return lib;
}

export type OpenResult =
  | { ok: true; doc: PDFDocumentProxy }
  | { ok: false; reason: 'password' | 'invalid'; message: string };

export async function openPdf(file: File): Promise<OpenResult> {
  const m = await pdfjs();
  try {
    const doc = await m.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
    return { ok: true, doc };
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'PasswordException') {
      return { ok: false, reason: 'password', message: 'This PDF is password-protected. Remove the password with Unlock PDF first, then open it here.' };
    }
    return { ok: false, reason: 'invalid', message: 'This PDF could not be opened. It may be damaged.' };
  }
}

let fonts: Promise<void> | null = null;
/** Liberation Sans (Arial-like), Carlito (Calibri-like), Tinos (Times-like): the files the server embeds. */
export function loadEditorFonts() {
  fonts ??= Promise.all([
    [FACE.arial, 'LiberationSans-Regular.ttf', 'normal', 'normal'],
    [FACE.arial, 'LiberationSans-Bold.ttf', 'bold', 'normal'],
    [FACE.arial, 'LiberationSans-Italic.ttf', 'normal', 'italic'],
    [FACE.arial, 'LiberationSans-BoldItalic.ttf', 'bold', 'italic'],
    [FACE.sans, 'Carlito-Regular.ttf', 'normal', 'normal'],
    [FACE.sans, 'Carlito-Bold.ttf', 'bold', 'normal'],
    [FACE.serif, 'Tinos-Regular.ttf', 'normal', 'normal'],
    [FACE.serif, 'Tinos-Bold.ttf', 'bold', 'normal'],
    [FACE.serif, 'Tinos-Italic.ttf', 'normal', 'italic'],
    [FACE.serif, 'Tinos-BoldItalic.ttf', 'bold', 'italic'],
  ].map(async ([family, file, weight, style]) => {
    const face = new FontFace(family, `url(/fonts/${file})`, { weight, style });
    document.fonts.add(await face.load());
  })).then(() => undefined).catch(() => undefined);
  return fonts;
}
