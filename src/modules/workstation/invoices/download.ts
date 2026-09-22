/**
 * Hand the browser a file, from a URL fetched asynchronously.
 *
 * NOT `window.open`. The signed PDF link has to be fetched first, so by the
 * time the URL exists the click that asked for it is over — and a popup
 * opened outside a user gesture is blocked, which shows up as a blank white
 * tab rather than an error. An anchor click is not a popup, so it survives
 * the await.
 *
 * `download` also means the file is saved under the invoice's own number
 * instead of landing in a viewer tab called "pdf".
 */
export function downloadFile(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  // Firefox needs the anchor in the document before the click registers.
  document.body.appendChild(a);
  a.click();
  a.remove();
}
