import './settings-layout.css';

function moveInto(cell, label, control) {
  if (label && label.parentNode !== cell) cell.append(label);
  if (control && control.parentNode !== cell) cell.append(control);
}

export function initSettingsLayout() {
  const scroll = document.querySelector('.settings-scroll');
  if (!scroll) return null;
  if (scroll.dataset.cfLayout !== '1') {
    scroll.dataset.cfLayout = '1';
    const playback = document.getElementById('resourcePlaybackModeSelect');
    const proxyMode = document.getElementById('playbackProxySelect');
    const playbackLabel = scroll.querySelector('label[for="resourcePlaybackModeSelect"]');
    const proxyLabel = scroll.querySelector('label[for="playbackProxySelect"]');
    if (playback && proxyMode && playbackLabel && proxyLabel && !scroll.querySelector('.cf-settings-pair')) {
      const pair = document.createElement('div');
      pair.className = 'cf-settings-pair';
      const cellA = document.createElement('div');
      cellA.className = 'cf-settings-cell';
      const cellB = document.createElement('div');
      cellB.className = 'cf-settings-cell';
      pair.append(cellA, cellB);
      const anchor = proxyLabel.parentNode === scroll ? proxyLabel : (playbackLabel.parentNode === scroll ? playbackLabel : null);
      if (anchor) scroll.insertBefore(pair, anchor);
      else scroll.append(pair);
      moveInto(cellA, playbackLabel, playback);
      moveInto(cellB, proxyLabel, proxyMode);
    }
  }
  const proxyInput = document.getElementById('proxyInput');
  const panel = scroll.querySelector('.cf-remote');
  if (proxyInput && panel && panel.previousElementSibling !== proxyInput) {
    proxyInput.after(panel);
  }
  return true;
}
