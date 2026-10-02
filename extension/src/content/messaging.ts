/**
 * chrome.runtime messaging that never throws or logs "Unchecked
 * runtime.lastError". After the extension is reloaded, scripts left in tabs
 * that were already open lose their connection ("Extension context
 * invalidated") — they then stay quiet instead of erroring.
 */
export const extensionAlive = (): boolean => {
  try { return !!chrome.runtime?.id; } catch { return false; }
};

export function send<T>(message: unknown): Promise<T | null> {
  return new Promise((resolve) => {
    if (!extensionAlive()) return resolve(null);
    try {
      chrome.runtime.sendMessage(message, (reply: T) => {
        // Reading lastError marks it as handled, so Chrome does not report it.
        if (chrome.runtime.lastError) return resolve(null);
        resolve(reply ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}
