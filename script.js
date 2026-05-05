const promptArea = document.getElementById('prompt-area');
const wordInput  = document.getElementById('word-input');
const submitBtn  = document.getElementById('submit-btn');
const container  = document.getElementById('chart-container');
const svg        = document.getElementById('lines-svg');

const dialogOverlay = document.getElementById('dialog-overlay');
const errorDialog   = document.getElementById('error-dialog');
const dialogMsg     = document.getElementById('dialog-message');
const dialogOkBtn   = document.getElementById('dialog-ok-btn');
const dialogCloseBtn = document.getElementById('dialog-close-btn');

// ── Layout constants ──────────────────────────────────────────────────────────

const NODE_W   = 120;  // element width (px)
const NODE_H   = 28;   // element height (px)
const V_GAP    = 110;  // vertical distance between level tops
const H_SPREAD = 165;  // horizontal offset from parent center to each child

// ── Node registry ─────────────────────────────────────────────────────────────

const nodes = new Map();  // id → node object
let nextId = 0;

// ── Datamuse API ──────────────────────────────────────────────────────────────

async function fetchRelatedWords(word) {
  const base   = 'https://api.datamuse.com/words';
  const clean  = encodeURIComponent(word.toLowerCase());
  const isWord = w => /^[a-z]+$/i.test(w.word) && w.word.toLowerCase() !== word.toLowerCase();

  // Primary: "triggered by" — thematically associated words
  const r1   = await fetch(`${base}?rel_trg=${clean}&max=20`);
  const d1   = await r1.json();
  let words  = d1.filter(isWord).map(w => w.word.toLowerCase());

  if (words.length < 2) {
    // Fallback: "means like" — semantic synonyms
    const r2  = await fetch(`${base}?ml=${clean}&max=20`);
    const d2  = await r2.json();
    const extra = d2.filter(isWord).map(w => w.word.toLowerCase());
    words = [...new Set([...words, ...extra])];
  }

  // Deduplicate and return two
  const unique = [...new Set(words)];
  return unique.slice(0, 2);
}

// ── SVG connector lines ───────────────────────────────────────────────────────

function drawConnector(parent, child) {
  // Cubic bezier: parent bottom-center → child top-center
  const x1 = parent.cx;
  const y1 = parent.cy + NODE_H;
  const x2 = child.cx;
  const y2 = child.cy;
  const my = (y1 + y2) / 2;

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`);
  path.setAttribute('class', 'connector-line');
  svg.appendChild(path);
}

// ── Container / SVG sizing ────────────────────────────────────────────────────

function updateCanvas() {
  let maxRight = window.innerWidth;
  let maxBottom = 300;

  nodes.forEach(n => {
    maxRight  = Math.max(maxRight,  n.cx + NODE_W / 2 + 60);
    maxBottom = Math.max(maxBottom, n.cy + NODE_H + 80);
  });

  container.style.width  = maxRight + 'px';
  container.style.height = maxBottom + 'px';
  svg.setAttribute('width',  maxRight);
  svg.setAttribute('height', maxBottom);
}

// ── Node creation ─────────────────────────────────────────────────────────────

function createNode(word, parentId, cx, cy) {
  const id   = nextId++;
  const isRoot = parentId === null;

  const el = document.createElement(isRoot ? 'div' : 'button');
  el.className   = isRoot ? 'word-node root-node' : 'word-node';
  el.textContent = word;
  el.style.left  = (cx - NODE_W / 2) + 'px';
  el.style.top   = cy + 'px';
  el.style.width = NODE_W + 'px';

  container.appendChild(el);

  const node = { id, word, parentId, cx, cy, el, expanded: false };
  nodes.set(id, node);

  if (parentId !== null) {
    drawConnector(nodes.get(parentId), node);
    el.addEventListener('click', () => expandNode(id));
  }

  updateCanvas();
  return node;
}

// ── Expand a node (fetch children) ───────────────────────────────────────────

async function expandNode(id) {
  const node = nodes.get(id);
  if (node.expanded) return;
  node.expanded = true;

  node.el.disabled = true;
  node.el.classList.add('expanded');
  node.el.textContent = node.word + '…';  // ellipsis while loading

  try {
    const words = await fetchRelatedWords(node.word);

    node.el.textContent = node.word;

    if (words.length < 2) {
      // API returned too few results — show a soft fail state
      node.el.textContent = node.word + ' (?)';
      return;
    }

    const childCy = node.cy + V_GAP;

    // Prevent left child from going off the left edge
    let leftCx  = node.cx - H_SPREAD;
    let rightCx = node.cx + H_SPREAD;
    const minCx = NODE_W / 2 + 20;
    if (leftCx < minCx) {
      const shift = minCx - leftCx;
      leftCx  += shift;
      rightCx += shift;
    }

    createNode(words[0], id, leftCx,  childCy);
    createNode(words[1], id, rightCx, childCy);

    updateCanvas();
    // Smoothly scroll to reveal new nodes
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });

  } catch (err) {
    // Network error — let the user retry
    node.el.textContent = node.word;
    node.el.disabled  = false;
    node.el.classList.remove('expanded');
    node.expanded = false;
  }
}

// ── Start the chart ───────────────────────────────────────────────────────────

function startChart(word) {
  promptArea.classList.add('submitted');
  wordInput.disabled  = true;
  submitBtn.disabled  = true;

  const rootCx = Math.max(window.innerWidth / 2, NODE_W / 2 + 20);
  const rootCy = 40;

  const root = createNode(word, null, rootCx, rootCy);
  expandNode(root.id);
}

// ── Input handling ────────────────────────────────────────────────────────────

function handleSubmit() {
  const word = wordInput.value.trim();

  if (!/^[a-zA-Z]+$/.test(word)) {
    showError(
      word.length === 0
        ? 'Please enter a word before clicking OK.'
        : 'Only letters are allowed — no spaces, numbers, or symbols.'
    );
    return;
  }

  startChart(word);
}

submitBtn.addEventListener('click', handleSubmit);
wordInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') handleSubmit();
});

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
  wordInput.focus();
}

dialogOkBtn.addEventListener('click', closeError);
dialogCloseBtn.addEventListener('click', closeError);
dialogOverlay.addEventListener('click', closeError);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !errorDialog.classList.contains('hidden')) closeError();
});
