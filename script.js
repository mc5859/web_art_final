const promptArea     = document.getElementById('prompt-area');
const wordInput      = document.getElementById('word-input');
const apiKeyInput    = document.getElementById('api-key-input');
const submitBtn      = document.getElementById('submit-btn');
const container      = document.getElementById('chart-container');
const svg            = document.getElementById('lines-svg');
const dialogOverlay  = document.getElementById('dialog-overlay');
const errorDialog    = document.getElementById('error-dialog');
const dialogMsg      = document.getElementById('dialog-message');
const dialogOkBtn    = document.getElementById('dialog-ok-btn');
const dialogCloseBtn = document.getElementById('dialog-close-btn');

// ── Layout constants ──────────────────────────────────────────────────────────

const NODE_W   = 100;  // node element width (px)
const NODE_H   = 28;   // node element height (px)
const V_GAP    = 55;   // vertical distance between parent top and child top
const H_SPREAD = 80;   // horizontal offset from parent center to each child center

// ── State ─────────────────────────────────────────────────────────────────────

const nodes = new Map();   // id → node object
let nextId  = 0;
let apiKey  = '';
let canvasW = 0;
let canvasH = 0;

// ── Collision detection ───────────────────────────────────────────────────────

function hasOverlap(cx, cy) {
  const padX = NODE_W + 6;
  const padY = NODE_H + 6;
  for (const n of nodes.values()) {
    if (Math.abs(cx - n.cx) < padX && Math.abs(cy - n.cy) < padY) return true;
  }
  return false;
}

function clampToCanvas(cx, cy) {
  return {
    cx: Math.max(NODE_W / 2 + 4, Math.min(canvasW - NODE_W / 2 - 4, cx)),
    cy: Math.max(4,               Math.min(canvasH - NODE_H - 4,     cy)),
  };
}

function findFreePosition(idealCx, idealCy) {
  const start = clampToCanvas(idealCx, idealCy);
  if (!hasOverlap(start.cx, start.cy)) return start;

  // Spiral outward from ideal position until a free spot is found
  for (let r = 18; r <= 500; r += 18) {
    for (let deg = 0; deg < 360; deg += 12) {
      const rad = deg * Math.PI / 180;
      const { cx, cy } = clampToCanvas(
        idealCx + r * Math.cos(rad),
        idealCy + r * Math.sin(rad)
      );
      if (!hasOverlap(cx, cy)) return { cx, cy };
    }
  }

  return start; // canvas is full — place anyway
}

// ── SVG connector ─────────────────────────────────────────────────────────────

function drawConnector(parent, child) {
  const x1 = parent.cx,  y1 = parent.cy + NODE_H;
  const x2 = child.cx,   y2 = child.cy;
  const my = (y1 + y2) / 2;

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`);
  path.setAttribute('class', 'connector-line');
  svg.appendChild(path);
}

// ── Node creation ─────────────────────────────────────────────────────────────

function createNode(word, parentId, idealCx, idealCy) {
  const isRoot   = parentId === null;
  const { cx, cy } = isRoot
    ? clampToCanvas(idealCx, idealCy)
    : findFreePosition(idealCx, idealCy);

  const id = nextId++;
  const el = document.createElement(isRoot ? 'div' : 'button');
  el.className   = isRoot ? 'word-node root-node' : 'word-node';
  el.textContent = word;
  el.style.left  = (cx - NODE_W / 2) + 'px';
  el.style.top   = cy + 'px';
  el.style.width = NODE_W + 'px';

  container.appendChild(el);

  const node = { id, word, parentId, cx, cy, el, expanded: false };
  nodes.set(id, node);

  if (!isRoot) {
    drawConnector(nodes.get(parentId), node);
    el.addEventListener('click', () => expandNode(id));
  }

  return node;
}

// ── Claude API ────────────────────────────────────────────────────────────────

async function fetchBranches(word) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 40,
      messages: [{
        role: 'user',
        content:
          `The word is "${word}". ` +
          `Give me exactly 2 words that are specific sub-types or varieties of it — ` +
          `as if answering "What kind of ${word}?" or "What type of ${word}?". ` +
          `Single English words only. Evocative and specific. Not antonyms. ` +
          `Reply with ONLY a JSON array, e.g. ["word1","word2"]`,
      }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${res.status}`);
  }

  const data  = await res.json();
  const text  = data.content[0].text.trim();
  const match = text.match(/\[.*?\]/s);
  if (!match) throw new Error('Unexpected response from API.');

  const words = JSON.parse(match[0]);
  return words.filter(w => typeof w === 'string' && /^[a-zA-Z]+$/.test(w)).slice(0, 2);
}

// ── Expand node ───────────────────────────────────────────────────────────────

async function expandNode(id) {
  const node = nodes.get(id);
  if (node.expanded) return;
  node.expanded = true;

  // Show loading without changing button appearance
  const orig = node.word;
  node.el.textContent = orig + '…';

  try {
    const words = await fetchBranches(node.word);
    node.el.textContent = orig;

    if (words.length < 2) {
      node.expanded = false;
      showError('Couldn\'t generate branches — please try again.');
      return;
    }

    createNode(words[0], id, node.cx - H_SPREAD, node.cy + V_GAP);
    createNode(words[1], id, node.cx + H_SPREAD, node.cy + V_GAP);

  } catch (err) {
    node.el.textContent = orig;
    node.expanded = false;
    showError('API error: ' + err.message);
  }
}

// ── Start chart ───────────────────────────────────────────────────────────────

function startChart(word) {
  // Lock canvas to current viewport dimensions
  canvasW = window.innerWidth;
  canvasH = window.innerHeight;

  // Fade out and hide the prompt screen
  promptArea.style.opacity = '0';
  setTimeout(() => { promptArea.style.display = 'none'; }, 400);

  // Reveal chart container at exact viewport size
  container.style.display  = 'block';
  container.style.width    = canvasW + 'px';
  container.style.height   = canvasH + 'px';

  svg.setAttribute('width',  canvasW);
  svg.setAttribute('height', canvasH);
  svg.style.width  = canvasW + 'px';
  svg.style.height = canvasH + 'px';

  // Root at top-center, auto-expand immediately
  const root = createNode(word, null, canvasW / 2, 50);
  expandNode(root.id);
}

// ── Input handling ────────────────────────────────────────────────────────────

function handleSubmit() {
  const word = wordInput.value.trim();
  const key  = apiKeyInput.value.trim();

  if (!/^[a-zA-Z]+$/.test(word)) {
    showError(word.length === 0
      ? 'Please enter a word before clicking OK.'
      : 'Only letters allowed — no spaces, numbers, or symbols.');
    return;
  }

  if (!key) {
    showError('Please enter your Anthropic API key.');
    return;
  }

  apiKey = key;
  startChart(word);
}

submitBtn.addEventListener('click', handleSubmit);
wordInput.addEventListener('keydown',   e => { if (e.key === 'Enter') handleSubmit(); });
apiKeyInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleSubmit(); });

// ── Error dialog ──────────────────────────────────────────────────────────────

function showError(msg) {
  dialogMsg.textContent = msg;
  errorDialog.classList.remove('hidden');
  dialogOverlay.classList.remove('hidden');
  dialogOkBtn.focus();
}

function closeError() {
  errorDialog.classList.add('hidden');
  dialogOverlay.classList.add('hidden');
}

dialogOkBtn.addEventListener('click', closeError);
dialogCloseBtn.addEventListener('click', closeError);
dialogOverlay.addEventListener('click', closeError);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !errorDialog.classList.contains('hidden')) closeError();
});
