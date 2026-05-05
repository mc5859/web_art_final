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
const resultDialog   = document.getElementById('result-dialog');
const resultText     = document.getElementById('result-text');
const resultOkBtn    = document.getElementById('result-ok-btn');
const resultCloseBtn = document.getElementById('result-close-btn');

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

// ── Audio ─────────────────────────────────────────────────────────────────────

let audioCtx = null;

function playThump() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = audioCtx;
    const now = ctx.currentTime;

    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    const lpf  = ctx.createBiquadFilter();

    lpf.type            = 'lowpass';
    lpf.frequency.value = 160;
    lpf.Q.value         = 0.7;

    osc.connect(lpf);
    lpf.connect(gain);
    gain.connect(ctx.destination);

    osc.type = 'sine';
    osc.frequency.setValueAtTime(85, now);
    osc.frequency.exponentialRampToValueAtTime(32, now + 0.14);

    gain.gain.setValueAtTime(0.42, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);

    osc.start(now);
    osc.stop(now + 0.24);
  } catch (_) {}
}

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

  return start;
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
  svg.insertBefore(line, svg.firstChild); // behind everything
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

function checkWordLinks(node) {
  const word = node.word.toLowerCase();
  for (const n of nodes.values()) {
    if (n.id !== node.id && n.word.toLowerCase() === word) {
      drawWordLink(n, node);
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

  if (parentId !== null) nodes.get(parentId).children.push(id);
  checkWordLinks(node);
  return node;
}

// Collect all descendant IDs (not including nodeId itself)
function getDescendantIds(nodeId) {
  const result = [];
  function collect(id) {
    const n = nodes.get(id);
    if (!n) return;
    for (const cid of n.children) {
      result.push(cid);
      collect(cid);
    }
  }
  collect(nodeId);
  return result;
}

// ── Click handling ────────────────────────────────────────────────────────────

function handleNodeClick(id) {
  const node = nodes.get(id);
  if (!node || node.rescrambling) return;
  playThump();

  if (!node.expanded) {
    expandNode(id);
  } else {
    rescrambleNode(id);
  }
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
          `You are helping build a philosophical flowchart about desire. ` +
          `The concept: someone tries to clarify what they want by asking "What kind of X?" ` +
          `infinitely — never arriving at a clear answer.\n\n` +
          `Word: "${word}"\n\n` +
          `Give exactly 2 words that are intuitive, natural sub-types of "${word}", ` +
          `as if answering "What kind of ${word}?" The words should be:\n` +
          `- Simple, common English words\n` +
          `- Easy to understand as sub-categories\n` +
          `- Slightly intriguing or evocative\n` +
          `- Different from each other\n\n` +
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
  return words.filter(w => typeof w === 'string' && /^[a-zA-Z]+$/.test(w)).slice(0, 2);
}

// ── Expand (first click) ──────────────────────────────────────────────────────

async function expandNode(id) {
  const node = nodes.get(id);
  if (node.expanded || node.rescrambling) return;
  node.expanded = true;

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

// ── Rescramble: preserve structure, replace all words below ──────────────────

// Recursively fetch new words for every non-leaf node and update its children.
// Structure (positions, connectors) is preserved — only text changes.
async function rescrambleSubtreeWords(nodeId) {
  const node = nodes.get(nodeId);
  if (!node || node.children.length === 0) return; // leaf — nothing to update

  const words = await fetchBranches(node.word);
  if (words.length < 2) throw new Error('Not enough words returned');

  const [c1, c2] = node.children.map(id => nodes.get(id));

  c1.word = words[0];
  c1.el.textContent = words[0];
  c2.word = words[1];
  c2.el.textContent = words[1];

  // Descend both branches in parallel
  await Promise.all([
    rescrambleSubtreeWords(c1.id),
    rescrambleSubtreeWords(c2.id),
  ]);
}

async function rescrambleNode(id) {
  const node = nodes.get(id);
  if (!node || !node.expanded || node.rescrambling) return;
  node.rescrambling = true;

  const orig        = node.word;
  const descendants = getDescendantIds(id);

  // Dim the subtree and show loading on the clicked node
  node.el.textContent = orig + '…';
  descendants.forEach(nid => {
    const n = nodes.get(nid);
    if (n) n.el.classList.add('rescrambling');
  });

  try {
    // Strip existing word-links for all descendants
    descendants.forEach(nid => removeWordLinksForNode(nid));

    // Recursively replace all words while keeping positions/connectors
    await rescrambleSubtreeWords(id);

    node.el.textContent = orig;

    // Re-check word-links for all updated descendants
    descendants.forEach(nid => {
      const n = nodes.get(nid);
      if (n) {
        n.el.classList.remove('rescrambling');
        checkWordLinks(n);
      }
    });

    node.rescrambling = false;

  } catch (err) {
    node.el.textContent = orig;
    descendants.forEach(nid => {
      const n = nodes.get(nid);
      if (n) n.el.classList.remove('rescrambling');
    });
    node.rescrambling = false;
    showError('API error: ' + err.message);
  }
}

// ── "I know what I want" ──────────────────────────────────────────────────────

function addSatisfiedButton() {
  const btn = document.createElement('button');
  btn.id          = 'satisfied-btn';
  btn.className   = 'win98-btn';
  btn.textContent = 'I know what I want →';
  btn.addEventListener('click', handleSatisfied);
  container.appendChild(btn);
}

async function handleSatisfied() {
  const leaves = [...nodes.values()].filter(n => n.children.length === 0 && n.parentId !== null);
  if (leaves.length < 2) return;

  const btn = document.getElementById('satisfied-btn');
  btn.textContent = 'thinking…';
  btn.disabled    = true;

  try {
    const leafWords = leaves.map(n => n.word);
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
        max_tokens: 80,
        messages: [{
          role: 'user',
          content:
            `Someone spent a long time trying to clarify what they want. ` +
            `After infinite questions, the words they are left holding are: ${leafWords.join(', ')}.\n\n` +
            `Write a single sentence starting with "I want" that contains all of these desires at once. ` +
            `It should be contradictory, impossible, and quietly devastating — ` +
            `revealing that they still don't truly know what they want. Under 40 words.`,
        }],
      }),
    });

    const data     = await res.json();
    const sentence = data.content[0].text.trim();

    resultText.textContent = sentence;
    resultDialog.classList.remove('hidden');

  } catch (err) {
    showError('API error: ' + err.message);
  } finally {
    btn.textContent = 'I know what I want →';
    btn.disabled    = false;
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

  addSatisfiedButton();

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

// ── Result dialog ─────────────────────────────────────────────────────────────

function closeResult() {
  resultDialog.classList.add('hidden');
}

resultOkBtn.addEventListener('click', closeResult);
resultCloseBtn.addEventListener('click', closeResult);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!errorDialog.classList.contains('hidden'))  closeError();
    if (!resultDialog.classList.contains('hidden')) closeResult();
  }
});
