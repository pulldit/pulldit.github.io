/**
 * Pulldit Bridge — content script (runs inside the Pulldit page, isolated world).
 *
 * It is the courier between the page and the privileged background worker. It performs NO
 * network requests itself (a content script's fetch is CORS-bound like the page); it only
 * relays validated requests to the background and posts results back to the page.
 *
 * Protocol (window.postMessage, same-window only):
 *   page -> bridge : { __pulldit:'page', id, op:'ping'|'fetchJson'|'fetchBytes', url?, maxBytes? }
 *   bridge -> page : { __pulldit:'ext',  id, op:'pong', version }                    (ping reply)
 *                    { __pulldit:'ext',  id, ok:true, body, bytes, status, httpOk }  (fetchJson)
 *                    { __pulldit:'ext',  id, ok:true, b64, contentType, bytes, ... } (fetchBytes)
 *                    { __pulldit:'ext',  id, ok:false, error, status }               (any failure)
 *                    { __pulldit:'ext',  op:'ready', version }                       (announced once)
 */
(function () {
  const TAG = '__pulldit';
  const VERSION = '1.0.1';

  function post(obj) {
    try {
      window.postMessage({ [TAG]: 'ext', ...obj }, window.location.origin);
    } catch {
      /* page gone — ignore */
    }
  }

  window.addEventListener('message', (event) => {
    // Only messages from THIS window's page context, addressed to us.
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d[TAG] !== 'page') return;

    const { id, op, url, maxBytes } = d;

    if (op === 'ping') {
      post({ id, op: 'pong', version: VERSION });
      return;
    }
    if (op !== 'fetchJson' && op !== 'fetchBytes') return;

    try {
      chrome.runtime.sendMessage({ op, url, maxBytes }, (resp) => {
        if (chrome.runtime.lastError) {
          post({ id, ok: false, error: chrome.runtime.lastError.message || 'extension error' });
          return;
        }
        if (!resp) {
          post({ id, ok: false, error: 'no response from extension' });
          return;
        }
        post({ id, ...resp });
      });
    } catch (err) {
      post({ id, ok: false, error: (err && err.message) || 'bridge error' });
    }
  });

  // Announce presence so a page that loads after us can detect the bridge without polling.
  post({ op: 'ready', version: VERSION });
})();
