/* Install as an app: the service worker makes TheraChart launch from a phone's
   home screen like a native app (only when served over http/https).

   This lived as an inline <script> in index.html until 2026-08-21. It is a
   file now for one reason: the Content-Security-Policy the server sends sets
   `script-src 'self'`, and a single inline block would have forced either
   'unsafe-inline' — which gives up most of what the policy is for — or a hash
   that silently stops matching the first time someone edits the block. */
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
