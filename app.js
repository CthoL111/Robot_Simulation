
const DIRS   = ['N', 'E', 'S', 'W'];
const ARROWS = { N: '↑', E: '→', S: '↓', W: '←' };
const DX     = { N: 0,  E: 1,  S: 0,  W: -1 };
const DY = { N: 1, E: 0, S: -1, W: 0 };

/* ──────────────────────────────────────────────────────────────
   initState()
   Creates and returns a brand new starting state object for the robot.
   Called once when the page loads, and again every time "Clear" is pressed.
   Sets all values back to default:
     - dfa = 'S0'        → robot hasn't started yet
     - energy = 3        → full battery
     - turns = 0         → no turns made
     - holding = false   → not carrying anything
     - tasks = 0         → no pick-drop tasks done
     - rx,ry = (0,7)     → robot starts at bottom-left of grid
     - dirIdx = 0        → facing North
     - ox,oy = (0,6)     → object starts one cell above robot
     - hasObj = true     → object exists on the grid
     - cwCount = 0       → no clockwise loop progress
     - lastWasMF = false → last command was not MOVE_F
     - dead = false      → sequence not rejected yet
   ────────────────────────────────────────────────────────────── */
/* ── Initial state factory ──────────────────────────────────── */
function initState() {
  return {
    dfa:        'S0',
    energy:     3,
    turns:      0,
    holding:    false,
    tasks:      0,          // completed pick-drop pairs
    rx: 0, ry: 0,          // robot position
    dirIdx: 0,             // facing North
    ox: 0, oy: 1,          // object position
    hasObj:     true,
    cwCount:    0,          // consecutive MF→TR pairs (rule 13)
    lastWasMF:  false,      // was last command MOVE_F?
    dead:       false,
    deadReason: ''
  };
}

function clone(s) {
  const c = Object.assign({}, s);
  return c;
}

/* ── DFA transition function ────────────────────────────────── */
function applyCmd(s, cmd) {
  s = clone(s);
  if (s.dead || s.dfa === 'ACCEPT') return s;

  /* START */
  if (cmd === 'START') {
    if (s.dfa !== 'S0') { s.dead = true; s.deadReason = 'START only allowed at beginning'; return s; }
    s.dfa = 'S1'; s.energy = 3; s.lastWasMF = false; return s;
  }
  if (s.dfa === 'S0') { s.dead = true; s.deadReason = 'Must begin with START'; return s; }

  /* STOP */
  if (cmd === 'STOP') {
    if (s.tasks < 2) {
      s.dead = true;
      s.deadReason = `Must complete at least 2 pick-drop tasks before STOP — done: ${s.tasks}/2 (Rule 8★)`;
      return s;
    }
    s.dfa = 'ACCEPT'; return s;
  }

  /* MOVE_F / MOVE_B */
  if (cmd === 'MOVE_F' || cmd === 'MOVE_B') {
    if (s.energy <= 0) { s.dead = true; s.deadReason = 'Energy is 0 — use RECHARGE first'; return s; }
    const dir = DIRS[s.dirIdx];
    const fwd = cmd === 'MOVE_F';
    const nx  = s.rx + (fwd ? DX[dir] : -DX[dir]);
    const ny  = s.ry + (fwd ? DY[dir] : -DY[dir]);
    if (nx < 0 || nx > 7 || ny < 0 || ny > 7) {
      s.dead = true; s.deadReason = 'Move goes off the grid boundary'; return s;
    }
    s.energy--;
    s.turns = 0;
    s.rx = nx; s.ry = ny;
    s.lastWasMF = (cmd === 'MOVE_F');
    if (cmd === 'MOVE_B') s.cwCount = 0; // only MF→TR matters
    if (s.dfa === 'S1') s.dfa = 'S2';
    return s;
  }

  /* TURN_L / TURN_R */
  if (cmd === 'TURN_L' || cmd === 'TURN_R') {
    if (s.turns >= 2) { s.dead = true; s.deadReason = 'Max 2 consecutive turns exceeded (Rule 5)'; return s; }
    if (cmd === 'TURN_R' && s.lastWasMF) {
      s.cwCount++;
      if (s.cwCount >= 4) {
        s.dead = true; s.deadReason = 'Clockwise loop (MOVE_F → TURN_R) × 4 detected (Rule 13★)'; return s;
      }
    } else if (cmd === 'TURN_L') {
      s.cwCount = 0; // left turn breaks the clockwise chain
    }
    s.lastWasMF = false;
    s.turns++;
    s.dirIdx = (s.dirIdx + (cmd === 'TURN_R' ? 1 : 3)) % 4;
    return s;
  }

/* RECHARGE */
if (cmd === 'RECHARGE') {
  if (s.energy > 0) {
    s.dead = true; s.deadReason = `Can only RECHARGE when energy is exactly 0 — current energy: ${s.energy} (Rule 9★)`;
    return s;
  }
  s.energy = 3; return s;
}

  /* PICK */
  if (cmd === 'PICK') {
    if (s.holding)    { s.dead = true; s.deadReason = 'Already holding an object — DROP it first'; return s; }
    if (s.dfa === 'S1') { s.dead = true; s.deadReason = 'Must MOVE at least once before PICK (Rule 2)'; return s; }
    if (!s.hasObj)    { s.dead = true; s.deadReason = 'No object available to pick up'; return s; }
    if (s.rx !== s.ox || s.ry !== s.oy) {
      s.dead = true;
      s.deadReason = `No object here — object is at (${s.ox}, ${s.oy}). Navigate there first.`;
      return s;
    }
    s.holding = true; s.hasObj = false; s.lastWasMF = false;
    s.dfa = 'S3'; return s;
  }

  /* DROP */
  if (cmd === 'DROP') {
    if (!s.holding) { s.dead = true; s.deadReason = 'Not holding anything — PICK an object first'; return s; }
    s.holding = false;
    s.tasks++;
    s.hasObj = true; s.ox = s.rx; s.oy = s.ry;
    s.lastWasMF = false;
    s.dfa = s.tasks >= 2 ? 'S5' : 'S4';
    return s;
  }

  return s;
}

/* ══════════════════════════════════════════════════════════════
   State & history
   ══════════════════════════════════════════════════════════════ */
let seq   = [];
let snaps = [];
let state = initState();

/* ── Grid renderer ──────────────────────────────────────────── */
function buildGrid(s) {
    const wrap = document.getElementById('grid-wrap');
    wrap.innerHTML = '';
    for (let row = 7; row >= 0; row--) {
        for (let col = 0; col < 8; col++) {
            const cell = document.createElement('div');
            const isR = col === s.rx && row === s.ry;
            const isO = s.hasObj && col === s.ox && row === s.oy;

            if (isR && isO) {
                cell.className = 'cell is-both';
                cell.textContent = ARROWS[DIRS[s.dirIdx]];
                const dot = document.createElement('div');
                dot.className = 'obj-dot';
                cell.appendChild(dot);
            } else if (isR) {
                cell.className = 'cell is-robot';
                cell.textContent = ARROWS[DIRS[s.dirIdx]];
            } else if (isO) {
                cell.className = 'cell is-obj';
                cell.textContent = 'obj';
            } else {
                cell.className = 'cell';
                cell.textContent = col + ',' + row;
            }
            wrap.appendChild(cell);
        }
    }
}

/* ── UI updater ─────────────────────────────────────────────── */
function updateAll() {
  const s = state;
  buildGrid(s);

  /* stat cards */
  setText('st-dfa',    s.dead ? 'DEAD' : s.dfa);
  setText('st-energy', s.dfa === 'S0' ? '—' : s.energy + ' / 3');
  setText('st-turns',  s.dfa === 'S0' ? '—' : s.turns + ' / 2');
  setText('st-tasks',  s.dfa === 'S0' ? '—' : s.tasks + ' / 2');
  setText('st-hold',   s.dfa === 'S0' ? '—' : (s.holding ? 'Yes ●' : 'No'));
  setText('st-cw',     s.dfa === 'S0' ? '—' : s.cwCount + ' / 4');

  setClass('st-energy', s.energy === 0 ? 'stat-val warn' : s.energy === 3 ? 'stat-val good' : 'stat-val');
  setClass('st-tasks',  s.tasks >= 2   ? 'stat-val good' : 'stat-val');
  setClass('st-cw',     s.cwCount >= 3 ? 'stat-val warn' : 'stat-val');
  setClass('st-dfa',    s.dead ? 'stat-val bad' : s.dfa === 'ACCEPT' ? 'stat-val good' : 'stat-val');

  /* direction & position */
  setText('st-dir', s.dfa === 'S0' ? '—' : DIRS[s.dirIdx] + ' ' + ARROWS[DIRS[s.dirIdx]]);
  setText('st-pos', s.dfa === 'S0' ? '—' : s.rx + ', ' + s.ry);
  setText('st-obj', s.dfa === 'S0' ? '—' : s.hasObj ? s.ox + ', ' + s.oy : 'carried');

  /* status box */
  const box    = document.getElementById('status-box');
  const main   = document.getElementById('status-main');
  const detail = document.getElementById('status-detail');

  box.className = 'status-box';
  if (s.dead) {
    box.classList.add('err');
    main.textContent   = 'Rejected ';
    detail.textContent = s.deadReason;
  } else if (s.dfa === 'ACCEPT') {
    box.classList.add('ok');
    main.textContent   = 'Accepted ';
    detail.textContent = `Valid sequence — ${seq.length} commands, ${s.tasks} tasks completed.`;
  } else if (s.dfa === 'S0') {
    main.textContent   = 'Ready';
    detail.textContent = 'Robot at (0,0) facing N ↑. Object at (0,1)';
  } else {
    box.classList.add('active');
    main.textContent = `Running · ${s.dfa}`;
    if (s.hasObj) {
      const onCell = s.rx === s.ox && s.ry === s.oy;
      detail.textContent = onCell
        ? `On object cell (${s.ox},${s.oy}) — can PICK now!`
        : `Object at (${s.ox},${s.oy}) — navigate there to PICK.`;
    } else if (s.holding) {
      detail.textContent = 'Carrying object — MOVE then DROP anywhere.';
    } else {
      detail.textContent = `Task ${s.tasks}/2 done. ` +
        (s.tasks < 2 ? 'PICK the object again for 2nd task.' : 'All tasks done — you can STOP!');
    }
  }

  /* sequence tokens */
  const disp = document.getElementById('seq-display');
  if (seq.length === 0) {
    disp.innerHTML = '<span class="placeholder">Press commands above…</span>';
    return;
  }
  disp.innerHTML = seq.map((cmd, i) => {
    const isLast = i === seq.length - 1;
    const cls    = isLast && s.dead ? 'tok-err' : 'tok-ok';
    return `<span class="token ${cls}">${cmd}</span>`;
  }).join('');
}

/* ── Helpers ────────────────────────────────────────────────── */
function setText(id, val)  { document.getElementById(id).textContent = val; }
function setClass(id, cls) { document.getElementById(id).className    = cls; }

/* ── Commands ───────────────────────────────────────────────── */
function addCmd(cmd) {
  if (state.dead || state.dfa === 'ACCEPT') return;
  snaps.push(clone(state));
  state = applyCmd(state, cmd);
  seq.push(cmd);
  updateAll();
}

function undoLast() {
  if (snaps.length === 0) return;
  state = snaps.pop();
  seq.pop();
  updateAll();
}

function clearAll() {
  seq = []; snaps = []; state = initState(); updateAll();
}

/* ── Demo sequence (satisfies all rules incl. R8★ R9★ R13★) ── */
let demoTimer = null;
function runDemo() {
  clearAll();
  if (demoTimer) clearInterval(demoTimer);

  // Correct demo path:
const correctDemo = [
    'START',
    'MOVE_F',           // (0,1) obj here, E=2
    'PICK',              // hold, S3
    'MOVE_F',            // (0,2) E=1
    'MOVE_F',            // (0,3) E=0
    'RECHARGE',          // E=3 (R9★ valid: E was 0)
    'DROP',               // obj at (0,3), tasks=1, S4
    'MOVE_F',             // (0,4) E=2
    'MOVE_B',             // (0,3) E=1, obj here
    'PICK',                // hold again, S3
    'MOVE_F',              // (0,4) E=0
    'RECHARGE',            // E=3
    'DROP',                 // obj at (0,4), tasks=2, S5
    'STOP'                  // ACCEPT ✓
];

  let i = 0;
  demoTimer = setInterval(() => {
    if (i >= correctDemo.length) { clearInterval(demoTimer); return; }
    addCmd(correctDemo[i++]);
  }, 650);
}

/* ── Event listeners ────────────────────────────────────────── */
document.querySelectorAll('.cmd-btn').forEach(btn => {
  btn.addEventListener('click', () => addCmd(btn.dataset.cmd));
});
document.getElementById('btn-undo').addEventListener('click',  undoLast);
document.getElementById('btn-clear').addEventListener('click', clearAll);
document.getElementById('btn-demo').addEventListener('click',  runDemo);

/* ── Init ───────────────────────────────────────────────────── */
updateAll();

