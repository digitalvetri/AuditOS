// Apply the saved theme before first paint so a dark session never flashes light.
// A file rather than an inline <script>, so the Content-Security-Policy can
// stay `script-src 'self'` with no exceptions (see nginx/security-headers.conf).
try { var t = localStorage.getItem('audit-os:theme'); if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark'); } catch (e) {}
