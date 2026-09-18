// Runs at document_start in the inner frame of frames.html only (its manifest entry matches that
// document with all_frames). It gives the probe a scope in the subframe, so the background can
// reach the frame with scripting.executeScript({ target: { frameIds } }), and marks the document
// so the frames stage can tell where it ran.
document.documentElement.setAttribute('data-zen-frame-script', location.pathname)
chrome.runtime.sendMessage({ t: 'frameHello', url: location.href }, function () {
  void chrome.runtime.lastError
})
