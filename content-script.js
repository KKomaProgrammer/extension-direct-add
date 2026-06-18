'use strict';

(() => {
  if (window.__extensionDirectAddLoaded) return;
  window.__extensionDirectAddLoaded = true;

  const MAX_CANDIDATES = 80;
  const SCAN_BATCH_SIZE = 180;
  const FLUSH_DELAY_MS = 180;
  const candidates = new Map();
  const pendingNodes = new Set();
  let flushTimer = 0;
  let ui = null;

  const idle = window.requestIdleCallback || ((callback) => setTimeout(() => callback({ timeRemaining: () => 8 }), 30));

  init();

  function init() {
    inspectUrl(location.href, document.title || '현재 페이지');
    scanAnchorsChunked(Array.from(document.links || []));
    observeLinks();
  }

  function observeLinks() {
    if (!document.documentElement) return;
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node && node.nodeType === Node.ELEMENT_NODE) pendingNodes.add(node);
        }
        if (mutation.type === 'attributes' && mutation.target) pendingNodes.add(mutation.target);
      }
      scheduleFlush();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href']
    });
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = window.setTimeout(() => {
      flushTimer = 0;
      const nodes = Array.from(pendingNodes);
      pendingNodes.clear();
      idle(() => scanNodes(nodes));
    }, FLUSH_DELAY_MS);
  }

  function scanNodes(nodes) {
    const anchors = [];
    for (const node of nodes) {
      if (!node || !node.querySelectorAll) continue;
      if (node.matches && node.matches('a[href]')) anchors.push(node);
      if (anchors.length < SCAN_BATCH_SIZE) anchors.push(...node.querySelectorAll('a[href]'));
      if (anchors.length >= SCAN_BATCH_SIZE) break;
    }
    scanAnchorsChunked(anchors);
  }

  function scanAnchorsChunked(anchors) {
    let index = 0;
    const step = (deadline) => {
      let count = 0;
      while (index < anchors.length && count < SCAN_BATCH_SIZE && deadline.timeRemaining() > 1) {
        inspectAnchor(anchors[index++]);
        count++;
      }
      if (index < anchors.length) idle(step);
    };
    idle(step);
  }

  function inspectAnchor(anchor) {
    if (!anchor || candidates.size >= MAX_CANDIDATES) return;
    const title = cleanText(anchor.textContent) || cleanText(anchor.getAttribute('aria-label')) || '';
    inspectUrl(anchor.href, title);
  }

  function inspectUrl(href, label) {
    if (!href || candidates.size >= MAX_CANDIDATES || !/^https?:\/\//i.test(href)) return;
    const kind = classifyLink(href);
    if (!kind) return;

    const key = `${kind}:${normalizeLinkKey(href)}`;
    if (candidates.has(key)) return;

    const title = cleanText(label) || inferTitle(href, kind);
    const candidate = { key, kind, url: href, title, pageUrl: location.href, status: 'ready' };
    candidates.set(key, candidate);
    updateUi();
  }

  function classifyLink(href) {
    let url;
    try { url = new URL(href); } catch (_) { return ''; }

    const path = url.pathname;
    if (/\.zip(?:$|[?#])/i.test(href) || /\/archive\/refs\/heads\/[^/]+\.zip$/i.test(path)) return 'zip';

    if (/(^|\.)github\.com$/i.test(url.hostname)) {
      const parts = path.split('/').filter(Boolean);
      if (parts.length >= 2 && !['issues', 'pulls', 'marketplace', 'explore', 'topics', 'settings'].includes(parts[0])) {
        if (!parts[2] || ['tree', 'blob', 'releases'].includes(parts[2])) return 'github';
      }
    }

    return '';
  }

  function normalizeLinkKey(href) {
    try {
      const url = new URL(href);
      url.hash = '';
      return url.toString();
    } catch (_) {
      return href;
    }
  }

  function updateUi() {
    const list = Array.from(candidates.values());
    if (!list.length) return;
    if (!ui) ui = createUi();

    ui.count.textContent = String(list.length);
    ui.list.innerHTML = '';

    for (const item of list.slice(0, MAX_CANDIDATES)) {
      const row = document.createElement('div');
      row.className = 'eddh-row';

      const meta = document.createElement('div');
      meta.className = 'eddh-meta';
      const name = document.createElement('div');
      name.className = 'eddh-name';
      name.textContent = item.title;
      const url = document.createElement('div');
      url.className = 'eddh-url';
      url.textContent = item.url;
      meta.append(name, url);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'eddh-download';
      button.textContent = item.status === 'done' ? '완료' : item.status === 'busy' ? '다운로드 중' : '조용히 다운로드';
      button.disabled = item.status === 'busy';
      button.addEventListener('click', () => downloadCandidate(item, button));

      row.append(meta, button);
      ui.list.append(row);
    }
  }

  function createUi() {
    const root = document.createElement('div');
    root.id = 'eddh-root';

    const pill = document.createElement('button');
    pill.type = 'button';
    pill.id = 'eddh-pill';
    pill.innerHTML = '<span>확장 소스</span><b>0</b>';

    const panel = document.createElement('div');
    panel.id = 'eddh-panel';
    panel.hidden = true;

    const header = document.createElement('div');
    header.className = 'eddh-header';
    const title = document.createElement('strong');
    title.textContent = '감지된 ZIP/GitHub 소스';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.className = 'eddh-close';
    close.addEventListener('click', () => { panel.hidden = true; });
    header.append(title, close);

    const hint = document.createElement('div');
    hint.className = 'eddh-hint';
    hint.textContent = '새 탭을 열지 않고 백그라운드로 ZIP을 다운로드합니다. 설치는 압축 해제 후 확장 프로그램 관리 화면에서 직접 로드해야 합니다.';

    const list = document.createElement('div');
    list.className = 'eddh-list';

    panel.append(header, hint, list);
    root.append(pill, panel);
    document.documentElement.append(root);

    pill.addEventListener('click', () => { panel.hidden = !panel.hidden; });

    return { root, pill, panel, list, count: pill.querySelector('b') };
  }

  async function downloadCandidate(item, button) {
    item.status = 'busy';
    button.textContent = '다운로드 중';
    button.disabled = true;

    try {
      const response = await chrome.runtime.sendMessage({ type: 'EDD_DOWNLOAD', candidate: item });
      if (!response || !response.ok) throw new Error(response?.error || 'Download failed');
      item.status = 'done';
      button.textContent = '완료';
      showToast('ZIP 다운로드를 시작했습니다. 설치 안내는 확장 팝업에서 확인하세요.');
    } catch (error) {
      item.status = 'ready';
      button.textContent = '다시 시도';
      button.disabled = false;
      showToast(error.message || '다운로드 실패');
    }
  }

  function showToast(message) {
    let toast = document.getElementById('eddh-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'eddh-toast';
      document.documentElement.append(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function inferTitle(href, kind) {
    if (kind === 'github') {
      try {
        const parts = new URL(href).pathname.split('/').filter(Boolean);
        return `${parts[0]}/${parts[1]}`;
      } catch (_) {}
    }
    return href.split('/').filter(Boolean).pop() || 'extension-source.zip';
  }

  function cleanText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  }
})();
