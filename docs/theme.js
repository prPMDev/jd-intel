/* ==========================================================================
   jd-intel — theme toggle (redesign)
   Pair with the no-flash snippet inlined in each page <head> BEFORE styles.css:
     <script>try{document.documentElement.dataset.theme=localStorage.getItem('jdintel-theme')||'light';}catch(e){}</script>
   Toggle button markup:
     <button type="button" onclick="jdToggleTheme()" aria-label="Toggle theme" data-theme-icon>&#9790;</button>
   Every [data-theme-icon] element is kept in sync (moon in light, sun in dark).
   ========================================================================== */

(function () {
  // Safety net in case the inline <head> snippet was omitted.
  try {
    var saved = localStorage.getItem('jdintel-theme') || 'light';
    if (!document.documentElement.dataset.theme) {
      document.documentElement.dataset.theme = saved;
    }
  } catch (e) {}
  syncIcons();
})();

function jdToggleTheme() {
  var current = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  var next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('jdintel-theme', next); } catch (e) {}
  syncIcons();
}

function syncIcons() {
  var dark = document.documentElement.dataset.theme === 'dark';
  var nodes = document.querySelectorAll('[data-theme-icon]');
  for (var i = 0; i < nodes.length; i++) nodes[i].textContent = dark ? '☀' : '☾';
}
