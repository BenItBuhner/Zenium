// ==UserScript==
// @name         Zenium compat probe
// @namespace    zenium.compat
// @version      1.0.0
// @description  Marks the page when a userscript manager runs it in Zenium
// @author       Zenium compat sweep
// @match        http://10.0.2.2:8765/us-target.html*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==

;(function () {
  'use strict'
  const info = typeof GM_info !== 'undefined' ? GM_info : null
  const handler = (info && info.scriptHandler) || 'unknown'
  const version = (info && info.version) || ''
  let runs = 0
  try {
    runs = Number(GM_getValue('runs', 0)) + 1
    GM_setValue('runs', runs)
  } catch (e) {
    runs = -1
  }
  try {
    GM_addStyle('#zen-userscript-banner b { text-decoration: underline }')
  } catch (e) {
    /* GM_addStyle missing */
  }
  const banner = document.createElement('div')
  banner.id = 'zen-userscript-banner'
  banner.style.cssText =
    'position:fixed;top:0;left:0;right:0;padding:18px 24px;background:#1b7f3b;color:#fff;font:600 22px system-ui,sans-serif;z-index:2147483647;box-shadow:0 2px 8px rgba(0,0,0,.3)'
  banner.innerHTML =
    'Userscript ran via <b>' +
    handler +
    ' ' +
    version +
    '</b> (run ' +
    runs +
    ', GM_getValue/GM_setValue ok)'
  document.body.prepend(banner)
  document.documentElement.dataset.userscript = handler + '|' + version + '|' + runs
  document.title = 'US OK ' + handler
})()
