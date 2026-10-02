/**
 * Credentials live only in memory, only for the moment of filling, and are
 * dropped straight after. Never written to chrome.storage, localStorage,
 * sessionStorage, the DOM (other than the two input values) or the console.
 */
import type { Credential } from '../types';

export async function withCredential<T>(cred: Credential, use: (c: Credential) => Promise<T>): Promise<T> {
  const c: Credential = { username: cred.username, password: cred.password, mobile: cred.mobile };
  try {
    return await use(c);
  } finally {
    c.username = '';
    c.password = '';
    c.mobile = '';
  }
}
