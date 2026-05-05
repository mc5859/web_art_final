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

// ── Constants ─────────────────────────────────────────────────────────────────

const NODE_W          = 100;
const NODE_H          = 28;
const V_GAP           = 55;
const H_SPREAD        = 80;
const DEAD_END_CHANCE = 1 / 20;  // per-word, per expand only

// ── State ─────────────────────────────────────────────────────────────────────

const nodes     = new Map();   // id → node
const wordLinks = new Map();   // `${minId}-${maxId}` → SVG <line>

let nextId            = 0;
let apiKey            = '';
let canvasW           = 0;
let canvasH           = 0;
let firstLinkMade     = false;

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
  for (const n of nodes.values()) {
    if (Math.abs(cx - n.cx) < NODE_W + 6 && Math.abs(cy - n.cy) < NODE_H + 6) return true;
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
      const rad      = deg * Math.PI / 180;
      const { cx, cy } = clampToCanvas(idealCx + r * Math.cos(rad), idealCy + r * Math.sin(rad));
      if (!hasOverlap(cx, cy)) return { cx, cy };
    }
  }
  return start;
}

// ── SVG helpers ───────────────────────────────────────────────────────────────

function drawConnector(parent, childCx, childCy) {
  const x1 = parent.cx, y1 = parent.cy + NODE_H;
  const x2 = childCx,   y2 = childCy;
  const my = (y1 + y2) / 2;
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`);
  path.setAttribute('class', 'connector-line');
  svg.appendChild(path);
  return path;
}

function drawWordLink(nodeA, nodeB) {
  const key = `${Math.min(nodeA.id, nodeB.id)}-${Math.max(nodeA.id, nodeB.id)}`;
  if (wordLinks.has(key)) return;
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', nodeA.cx);
  line.setAttribute('y1', nodeA.cy + NODE_H / 2);
  line.setAttribute('x2', nodeB.cx);
  line.setAttribute('y2', nodeB.cy + NODE_H / 2);
  line.setAttribute('class', 'word-link-line');
  svg.insertBefore(line, svg.firstChild);
  wordLinks.set(key, line);

  if (!firstLinkMade) {
    firstLinkMade = true;
    const btn = document.getElementById('satisfied-btn');
    if (btn) btn.classList.add('visible');
  }
}

function removeWordLinksForNode(id) {
  for (const [key, el] of wordLinks) {
    const [a, b] = key.split('-').map(Number);
    if (a === id || b === id) { el.remove(); wordLinks.delete(key); }
  }
}

function checkWordLinks(node) {
  if (node.isDeadEnd) return;
  const word = node.word.toLowerCase();
  for (const n of nodes.values()) {
    if (n.id !== node.id && !n.isDeadEnd && n.word.toLowerCase() === word) {
      drawWordLink(n, node);
    }
  }
}

// ── Word weight ───────────────────────────────────────────────────────────────

function recomputeAllWeights() {
  const counts = new Map();
  for (const n of nodes.values()) {
    if (n.isDeadEnd) continue;
    const w = n.word.toLowerCase();
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  for (const n of nodes.values()) {
    if (n.isDeadEnd) continue;
    const c = counts.get(n.word.toLowerCase()) || 1;
    if (c >= 4)      { n.el.style.fontWeight = 'bold'; n.el.style.fontSize = '13px'; }
    else if (c >= 3) { n.el.style.fontWeight = 'bold'; n.el.style.fontSize = '12px'; }
    else if (c >= 2) { n.el.style.fontWeight = '600';  n.el.style.fontSize = '';     }
    else             { n.el.style.fontWeight = '';      n.el.style.fontSize = '';     }
  }
}

// ── Ghost traces ──────────────────────────────────────────────────────────────

function createGhost(node, oldWord) {
  if (!oldWord || oldWord === '…' || oldWord === '—') return;
  const ghost = document.createElement('div');
  ghost.className   = 'word-ghost';
  ghost.textContent = oldWord;
  ghost.style.left  = (node.cx - NODE_W / 2) + 'px';
  ghost.style.top   = node.cy + 'px';
  ghost.style.width = NODE_W + 'px';
  container.appendChild(ghost);
  // Double rAF ensures initial opacity renders before transition kicks in
  requestAnimationFrame(() => requestAnimationFrame(() => { ghost.style.opacity = '0'; }));
  setTimeout(() => ghost.remove(), 1600);
}

// ── Node creation ─────────────────────────────────────────────────────────────

function createNode(word, parentId, idealCx, idealCy) {
  const isRoot     = parentId === null;
  const isDeadEnd  = word === '—';
  const { cx, cy } = isRoot ? clampToCanvas(idealCx, idealCy) : findFreePosition(idealCx, idealCy);
  const id         = nextId++;

  const el = document.createElement(isRoot ? 'div' : 'button');
  if (isDeadEnd)  el.className = 'word-node dead-end-node';
  else if (isRoot) el.className = 'word-node root-node';
  else             el.className = 'word-node';

  el.textContent = word;
  el.style.left  = (cx - NODE_W / 2) + 'px';
  el.style.top   = cy + 'px';
  el.style.width = NODE_W + 'px';
  container.appendChild(el);

  let connectorPath = null;
  if (!isRoot) {
    connectorPath = drawConnector(nodes.get(parentId), cx, cy);
    if (!isDeadEnd) el.addEventListener('click', () => handleNodeClick(id));
  }

  const node = { id, word, parentId, children: [], cx, cy, el, expanded: false, rescrambling: false, connectorPath, isDeadEnd };
  nodes.set(id, node);
  if (parentId !== null) nodes.get(parentId).children.push(id);

  if (!isDeadEnd) checkWordLinks(node);
  recomputeAllWeights();
  return node;
}

function getDescendantIds(nodeId) {
  const result = [];
  function collect(id) {
    const n = nodes.get(id);
    if (!n) return;
    for (const cid of n.children) { result.push(cid); collect(cid); }
  }
  collect(nodeId);
  return result;
}

// ── Click handling ────────────────────────────────────────────────────────────

function handleNodeClick(id) {
  const node = nodes.get(id);
  if (!node || node.rescrambling || node.isDeadEnd) return;
  playThump();
  if (!node.expanded) expandNode(id);
  else                rescrambleNode(id);
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
  return JSON.parse(match[0]).filter(w => typeof w === 'string' && /^[a-zA-Z]+$/.test(w)).slice(0, 2);
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

    // Randomly apply dead end to one word (~1 in 20 chance per word)
    const final = words.map(w => Math.random() < DEAD_END_CHANCE ? '—' : w);

    createNode(final[0], id, node.cx - H_SPREAD, node.cy + V_GAP);
    createNode(final[1], id, node.cx + H_SPREAD, node.cy + V_GAP);

  } catch (err) {
    node.el.textContent = orig;
    node.expanded = false;
    showError('API error: ' + err.message);
  }
}

// ── Rescramble ────────────────────────────────────────────────────────────────

// Walk the subtree, replacing every non-dead-end child word via API cascade.
// Positions and connectors are untouched — only text changes.
async function rescrambleSubtreeWords(nodeId) {
  const node = nodes.get(nodeId);
  if (!node || node.children.length === 0) return;

  const words = await fetchBranches(node.word);
  if (words.length < 2) throw new Error('Not enough words returned');

  const [c1, c2] = node.children.map(id => nodes.get(id));

  // c1
  if (!c1.isDeadEnd) {
    c1.word = words[0];
    c1.el.textContent = words[0];
    c1.el.classList.remove('rescrambling');
    checkWordLinks(c1);
  }
  // c2
  if (!c2.isDeadEnd) {
    c2.word = words[1];
    c2.el.textContent = words[1];
    c2.el.classList.remove('rescrambling');
    checkWordLinks(c2);
  }

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

  // Show '…' on every mutable descendant + create ghosts of their current words
  descendants.forEach(nid => {
    const n = nodes.get(nid);
    if (!n || n.isDeadEnd) return;
    createGhost(n, n.word);
    removeWordLinksForNode(nid);
    n.el.textContent = '…';
    n.el.classList.add('rescrambling');
  });

  node.el.textContent = orig + '…';

  try {
    await rescrambleSubtreeWords(id);

    node.el.textContent = orig;
    recomputeAllWeights();
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

function getDuplicateWords() {
  const counts = new Map();
  for (const n of nodes.values()) {
    if (n.isDeadEnd) continue;
    const w = n.word.toLowerCase();
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w);
}

// Dots cascade level by level from root to leaves
function animateScan() {
  return new Promise(resolve => {
    const rootId = [...nodes.keys()][0];
    const levels = [];
    let front = [rootId];
    while (front.length > 0) {
      levels.push([...front]);
      const next = [];
      front.forEach(id => {
        const n = nodes.get(id);
        if (n) n.children.forEach(cid => next.push(cid));
      });
      front = next;
    }

    let i = 0;
    const DELAY = 90;

    function step() {
      if (i >= levels.length) { setTimeout(resolve, 350); return; }
      levels[i].forEach(id => {
        const n = nodes.get(id);
        if (!n) return;
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', n.cx);
        dot.setAttribute('cy', n.cy + NODE_H / 2);
        dot.setAttribute('r', n.isDeadEnd ? 2 : 4);
        dot.setAttribute('fill', '#000080');
        dot.setAttribute('opacity', '0.85');
        svg.appendChild(dot);
        setTimeout(() => {
          dot.style.transition = 'opacity 0.3s';
          dot.style.opacity = '0';
          setTimeout(() => dot.remove(), 300);
        }, DELAY * 1.4);
      });
      i++;
      setTimeout(step, DELAY);
    }
    step();
  });
}

async function buildSentence(dupWords) {
  const leafWords = [...nodes.values()]
    .filter(n => n.children.length === 0 && n.parentId !== null && !n.isDeadEnd)
    .map(n => n.word.toLowerCase());

  const otherWords = [...new Set(leafWords.filter(w => !dupWords.includes(w)))];

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
      max_tokens: 70,
      messages: [{
        role: 'user',
        content:
          `The most recurring words from someone's desire map: ${dupWords.join(', ')}.\n` +
          (otherWords.length ? `Other words at the edges: ${otherWords.join(', ')}.\n` : '') +
          `\nWrite one raw, blunt sentence starting with "I want". ` +
          `Prioritize the recurring words. Make it feel true, crude, and a little shameful. ` +
          `It can be contradictory and doesn't have to be grammatically perfect. Under 25 words.`,
      }],
    }),
  });
  const data = await res.json();
  return data.content[0].text.trim();
}

async function handleSatisfied() {
  const btn = document.getElementById('satisfied-btn');
  btn.textContent = '…';
  btn.disabled    = true;

  const dupWords = getDuplicateWords();

  try {
    let sentence;
    if (wordLinks.size === 1) {
      // Single connection — short, stark sentence
      const firstKey = [...wordLinks.keys()][0];
      const nodeId   = parseInt(firstKey.split('-')[0], 10);
      const word     = nodes.get(nodeId)?.word || dupWords[0] || 'it';
      await animateScan();
      sentence = `I want ${word} love.`;
    } else {
      // Run animation and API fetch in parallel
      const [s] = await Promise.all([buildSentence(dupWords), animateScan()]);
      sentence = s;
    }

    window.alert(sentence);

  } catch (err) {
    showError('API error: ' + err.message);
  } finally {
    btn.textContent = 'I know what I want →';
    btn.disabled    = false;
  }
}

function addSatisfiedButton() {
  const btn       = document.createElement('button');
  btn.id          = 'satisfied-btn';
  btn.className   = 'win98-btn';
  btn.textContent = 'I know what I want →';
  btn.addEventListener('click', handleSatisfied);
  container.appendChild(btn);
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
  if (!key) { showError('Please enter your Anthropic API key.'); return; }

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
