'use strict';

const historyEl = document.getElementById('history');
const clearHistoryButton = document.getElementById('clearHistory');
const copyButton = document.getElementById('copyExtensionsUrl');

loadHistory();

if (copyButton) {
  copyButton.addEventListener('click', () => {
    copyButton.textContent = '주소창에 직접 입력하세요';
    setTimeout(() => { copyButton.textContent = 'chrome://extensions 복사'; }, 1400);
  });
}

clearHistoryButton.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'EDD_CLEAR_HISTORY' });
  loadHistory();
});

async function loadHistory() {
  const response = await chrome.runtime.sendMessage({ type: 'EDD_GET_HISTORY' });
  const history = response && response.ok && Array.isArray(response.history) ? response.history : [];
  renderHistory(history);
}

function renderHistory(history) {
  historyEl.innerHTML = '';
  if (!history.length) {
    historyEl.className = 'history empty';
    historyEl.textContent = '아직 다운로드 기록이 없습니다.';
    return;
  }

  historyEl.className = 'history';
  for (const item of history) {
    const el = document.createElement('article');
    el.className = 'item';

    const title = document.createElement('div');
    title.className = 'item-title';
    title.textContent = item.title || 'Extension source';

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = `${formatTime(item.time)} · ${item.filename || ''}`;

    const origin = document.createElement('div');
    origin.className = 'item-meta';
    origin.textContent = item.originalUrl || '';

    const badge = document.createElement('span');
    badge.className = item.verified ? 'badge' : 'badge warn';
    badge.textContent = item.verified ? 'manifest 확인됨' : '직접 확인 필요';

    el.append(title, meta, origin, badge);
    historyEl.append(el);
  }
}

function formatTime(time) {
  if (!time) return '';
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(time));
}
