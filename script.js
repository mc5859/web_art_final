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

const NODE_W   = 100;
const NODE_H   = 28;
const V_GAP    = 55;
const H_SPREAD = 80;

// ── State ─────────────────────────────────────────────────────────────────────

const nodes     = new Map();   // id → node object
const wordLinks = new Map();   // `${minId}-${maxId}` → SVG <line> element

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

  return start; // canvas full — place anyway
}

// ── SVG: tree connectors ──────────────────────────────────────────────────────

function drawConnector(parent, childCx, childCy) {
  const x1 = parent.cx,  y1 = parent.cy + NODE_H;
  const x2 = childCx,    y2 = childCy;
  const my = (y1 + y2) / 2;

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`);
  path.setAttribute('class', 'connector-line');
  svg.appendChild(path);
  return path;
}

// ── SVG: dotted word-match links ──────────────────────────────────────────────

function drawWordLink(nodeA, nodeB) {
  const key = `${Math.min(nodeA.id, nodeB.id)}-${Math.max(nodeA.id, nodeB.id)}`;
  if (wordLinks.has(key)) return;

  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', nodeA.cx);
  line.setAttribute('y1', nodeA.cy + NODE_H / 2);
  line.setAttribute('x2', nodeB.cx);
  line.setAttribute('y2', nodeB.cy + NODE_H / 2);
  line.setAttribute('class', 'word-link-line');
  // Insert behind tree lines
  svg.insertBefore(line, svg.firstChild);
  wordLinks.set(key, line);
}

function removeWordLinksForNode(id) {
  for (const [key, el] of wordLinks) {
    const [a, b] = key.split('-').map(Number);
    if (a === id || b === id) {
      el.remove();
      wordLinks.delete(key);
    }
  }
}

function checkWordLinks(newNode) {
  const word = newNode.word.toLowerCase();
  for (const n of nodes.values()) {
    if (n.id !== newNode.id && n.word.toLowerCase() === word) {
      drawWordLink(n, newNode);
    }
  }
}

// ── Node lifecycle ────────────────────────────────────────────────────────────

function createNode(word, parentId, idealCx, idealCy) {
  const isRoot     = parentId === null;
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

  let connectorPath = null;
  if (!isRoot) {
    connectorPath = drawConnector(nodes.get(parentId), cx, cy);
    el.addEventListener('click', () => handleNodeClick(id));
  }

  const node = {
    id, word, parentId,
    children: [],
    cx, cy, el,
    expanded:     false,
    rescrambling: false,
    connectorPath,
  };
  nodes.set(id, node);

  if (parentId !== null) {
    nodes.get(parentId).children.push(id);
  }

  checkWordLinks(node);
  return node;
}

// Recursively remove all descendants of nodeId (not nodeId itself)
function removeDescendants(nodeId) {
  const node = nodes.get(nodeId);
  if (!node) return;

  for (const childId of [...node.children]) {
    removeDescendants(childId);

    const child = nodes.get(childId);
    if (!child) continue;

    removeWordLinksForNode(childId);
    if (child.connectorPath) child.connectorPath.remove();
    child.el.remove();
    nodes.delete(childId);
  }

  node.children  = [];
  node.expanded  = false;
}

// ── Click handling ────────────────────────────────────────────────────────────

function handleNodeClick(id) {
  const node = nodes.get(id);
  if (!node || node.rescrambling) return;

  if (!node.expanded) {
    expandNode(id);
  } else {
    rescrambleNode(id);
  }
}

// ── Claude API ────────────────────────────────────────────────────────────────

function getUsedWords() {
  return [...nodes.values()].map(n => n.word.toLowerCase());
}

async function fetchBranches(word) {
  const used = getUsedWords();
  const avoidHint = used.length > 2
    ? ` Try to use words not already in the chart: ${used.join(', ')}.`
    : '';

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
          `You are helping build a philosophical flowchart about desire. ` +
          `The concept: someone tries to clarify what they want by asking "What kind of X?" infinitely — ` +
          `never arriving at a clear answer.\n\n` +
          `Word: "${word}"\n\n` +
          `Give exactly 2 words that are intuitive, natural sub-types of "${word}", ` +
          `as if answering "What kind of ${word}?" The words should be:\n` +
          `- Simple, common English words\n` +
          `- Easy to understand as sub-categories\n` +
          `- Slightly intriguing or evocative\n` +
          `- Different from each other\n` +
          avoidHint + `\n\n` +
          `Reply with ONLY a JSON array: ["word1","word2"]`,
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
  return words
    .filter(w => typeof w === 'string' && /^[a-zA-Z]+$/.test(w))
    .slice(0, 2);
}

// ── Expand (first click) ──────────────────────────────────────────────────────

async function expandNode(id) {
  const node = nodes.get(id);
  if (node.expanded || node.rescrambling) return;
  node.expanded = true; // lock immediately to prevent double-click

  const orig = node.word;
  node.el.textContent = orig + '…';

  try {
    const words = await fetchBranches(node.word);
    node.el.textContent = orig;

    if (words.length < 2) {
      node.expanded = false;
      showError('Couldn\'t generate branches — please try clicking again.');
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

// ── Rescramble (re-click an expanded node) ────────────────────────────────────

async function rescrambleNode(id) {
  const node = nodes.get(id);
  if (!node || !node.expanded || node.rescrambling) return;
  node.rescrambling = true;

  const orig = node.word;
  node.el.textContent = orig + '…';

  try {
    const words = await fetchBranches(node.word);
    node.el.textContent = orig;

    if (words.length < 2) {
      node.rescrambling = false;
      showError('Couldn\'t generate new branches — please try again.');
      return;
    }

    // Tear down everything below this node
    removeDescendants(id);

    // Plant fresh children
    createNode(words[0], id, node.cx - H_SPREAD, node.cy + V_GAP);
    createNode(words[1], id, node.cx + H_SPREAD, node.cy + V_GAP);

    node.expanded     = true;
    node.rescrambling = false;

  } catch (err) {
    node.el.textContent = orig;
    node.rescrambling = false;
    showError('API error: ' + err.message);
  }
}

// ── Start chart ───────────────────────────────────────────────────────────────

function startChart(word) {
  canvasW = window.innerWidth;
  canvasH = window.innerHeight;

  promptArea.style.opacity = '0';
  setTimeout(() => { promptArea.style.display = 'none'; }, 400);

  container.style.display = 'block';
  container.style.width   = canvasW + 'px';
  container.style.height  = canvasH + 'px';

  svg.setAttribute('width',  canvasW);
  svg.setAttribute('height', canvasH);
  svg.style.width  = canvasW + 'px';
  svg.style.height = canvasH + 'px';

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
