'use strict';

const $app = document.getElementById('app');
const LS = { history: 'ts.history', settings: 'ts.settings' };

const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 불가 환경 */ } };

// STT는 안드로이드에서 마이크를 녹음과 두고 다툴 수 있어 기본 꺼짐.
const settings = Object.assign({ stt: false, beep: true }, load(LS.settings, {}));

const TIMING = {
  read: { prep: 45, speak: [45] },
  respond: { prep: 3, speak: [15, 15, 30] },
  opinion: { prep: 45, speak: [60] },
};
const TITLE = { read: '지문 읽기', respond: '질문에 답하기', opinion: '의견 말하기' };

let bank = null;
let run = null;
let audioCtx = null;
let wakeLock = null;
let lastSession = null;

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el[k] = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function mount(...nodes) {
  $app.replaceChildren(...nodes.flat().filter((n) => n && n.nodeType));
  window.scrollTo(0, 0);
}

const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((p) => p[1]);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// ---------- 문제 구성 ----------

function buildItems(kind) {
  const items = [];
  if (kind === 'read' || kind === 'mock') {
    shuffle(bank.read).slice(0, 2).forEach((q, i) => items.push({
      no: `Q${i + 1}`, kind: 'read', prompt: q.text, prep: TIMING.read.prep, speak: TIMING.read.speak[0],
    }));
  }
  if (kind === 'respond' || kind === 'mock') {
    const set = pick(bank.respond);
    set.questions.forEach((q, i) => items.push({
      no: `Q${i + 5}`, kind: 'respond', context: `주제: ${set.topic}`, prompt: q,
      prep: TIMING.respond.prep, speak: TIMING.respond.speak[i],
    }));
  }
  if (kind === 'opinion' || kind === 'mock') {
    items.push({
      no: 'Q11', kind: 'opinion', prompt: pick(bank.opinion).text,
      prep: TIMING.opinion.prep, speak: TIMING.opinion.speak[0],
    });
  }
  return items;
}

// ---------- 신호음 / 화면 유지 ----------

function beep(freq = 880, ms = 160) {
  if (!settings.beep) return;
  if (navigator.vibrate) navigator.vibrate(100);
  if (!audioCtx) return;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.frequency.value = freq;
  g.gain.value = 0.15;
  o.connect(g);
  g.connect(audioCtx.destination);
  o.start();
  o.stop(audioCtx.currentTime + ms / 1000);
}

async function holdScreen() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
}
function releaseScreen() {
  try { wakeLock?.release(); } catch { /* 이미 해제됨 */ }
  wakeLock = null;
}

// ---------- 홈 ----------

function home() {
  const top = topErrors();
  const menu = (title, sub, kind) => h('button', { class: 'btn', onclick: () => startSession(kind) }, title, h('small', null, sub));
  mount(
    h('h1', null, '토익 스피킹 연습'),
    top.length > 0 && h('div', { class: 'card' },
      h('div', { class: 'meta' }, '내가 자주 틀리는 문법 (최근 10세션)'),
      top.map(([k, v]) => h('div', { class: 'hist' }, h('span', null, k), h('span', null, `${v}회`))),
    ),
    h('h2', null, '연습 시작'),
    menu('모의 세트', '지문 읽기 2 · 질문 3 · 의견 1 (약 8분)', 'mock'),
    menu('지문 읽기 (Q1-2)', '준비 45초 / 답변 45초', 'read'),
    menu('질문에 답하기 (Q5-7)', '준비 3초 / 답변 15·15·30초', 'respond'),
    menu('의견 말하기 (Q11)', '준비 45초 / 답변 60초', 'opinion'),
    h('h2', null, '기타'),
    h('button', { class: 'btn', onclick: historyView }, '기록'),
    h('button', { class: 'btn', onclick: settingsView }, '설정'),
  );
}

// ---------- 세션 실행 ----------

async function startSession(kind) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    alert('마이크 권한이 필요합니다. 브라우저 설정에서 허용해 주세요.');
    return;
  }
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); await audioCtx.resume(); } catch { audioCtx = null; }
  holdScreen();
  run = { kind, items: buildItems(kind), i: 0, stream, results: [], phase: null, deadline: 0, total: 0, timer: null };
  runItem();
}

function runItem() {
  const item = run.items[run.i];
  if (!item) return finishSession();
  run.transcript = '';
  const ui = run.ui = {
    phase: h('div', { class: 'phase', 'aria-live': 'polite' }),
    time: h('div', { class: 'timer', role: 'timer' }),
    bar: h('div', { class: 'bar' }, h('i')),
    live: h('div', { class: 'transcript' }),
    skip: h('button', { class: 'btn primary', onclick: () => advance(true) }),
  };
  mount(
    h('div', { class: 'meta' }, `${item.no} · ${TITLE[item.kind]} (${run.i + 1}/${run.items.length})`),
    ui.phase, ui.time, ui.bar,
    h('div', { class: 'card' }, item.context && h('div', { class: 'meta' }, item.context), h('div', { class: 'q' }, item.prompt)),
    ui.live,
    ui.skip,
    h('button', { class: 'btn ghost', onclick: abortSession }, '중단'),
  );
  setPhase('prep', item.prep);
}

function setPhase(phase, seconds) {
  const ui = run.ui;
  run.phase = phase;
  run.total = seconds * 1000;
  run.deadline = Date.now() + run.total;
  ui.phase.textContent = phase === 'prep' ? '준비' : '● 답변 중';
  ui.phase.className = `phase ${phase}`;
  ui.bar.className = `bar ${phase === 'speak' ? 'speak' : ''}`;
  ui.skip.textContent = phase === 'prep' ? '준비 건너뛰고 바로 답변' : '답변 종료';
  clearInterval(run.timer);
  run.timer = setInterval(tick, 200);
  tick();
}

function tick() {
  const left = Math.max(0, run.deadline - Date.now());
  run.ui.time.textContent = String(Math.ceil(left / 1000));
  run.ui.bar.firstChild.style.width = `${(left / run.total) * 100}%`;
  if (left <= 0) advance(false);
}

let advancing = false;
async function advance(manual) {
  if (advancing || !run) return;
  advancing = true;
  clearInterval(run.timer);
  try {
    if (run.phase === 'prep') {
      beep(988);
      startRecording();
      setPhase('speak', run.items[run.i].speak);
    } else {
      await stopRecording(manual);
      beep(660, 240);
      run.i += 1;
      runItem();
    }
  } finally {
    advancing = false;
  }
}

function pickMime() {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return cands.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

function startRecording() {
  const mime = pickMime();
  run.chunks = [];
  run.startedAt = Date.now();
  run.rec = new MediaRecorder(run.stream, mime ? { mimeType: mime } : undefined);
  run.rec.ondataavailable = (e) => { if (e.data.size) run.chunks.push(e.data); };
  run.rec.start();
  startRecog();
}

function startRecog() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!settings.stt || !SR) return;
  const r = new SR();
  r.lang = 'en-US';
  r.continuous = true;
  r.interimResults = true;
  let finalText = '';
  r.onresult = (e) => {
    let interim = '';
    for (let k = e.resultIndex; k < e.results.length; k++) {
      const t = e.results[k][0].transcript;
      if (e.results[k].isFinal) finalText += `${t} `; else interim += t;
    }
    run.transcript = finalText.trim();
    if (run?.ui) run.ui.live.textContent = `${finalText}${interim}`;
  };
  r.onend = () => {
    if (run && run.recog === r) { try { r.start(); } catch { /* 이미 시작됨 */ } }
  };
  run.recog = r;
  try { r.start(); } catch { run.recog = null; }
}

function stopRecog() {
  const r = run.recog;
  run.recog = null;
  if (!r) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 700);
    r.onend = () => { clearTimeout(t); resolve(); };
    try { r.stop(); } catch { clearTimeout(t); resolve(); }
  });
}

async function stopRecording(manual) {
  const rec = run.rec;
  const item = run.items[run.i];
  const stopped = new Promise((resolve) => { rec.onstop = resolve; });
  if (rec.state !== 'inactive') rec.stop();
  await Promise.all([stopped, stopRecog()]);
  const mime = rec.mimeType || 'audio/webm';
  run.results.push({
    ...item,
    blob: new Blob(run.chunks, { type: mime }),
    mime,
    seconds: Math.round((Date.now() - run.startedAt) / 1000),
    transcript: run.transcript || '',
    stoppedEarly: manual,
  });
}

function cleanupSession() {
  if (!run) return;
  clearInterval(run.timer);
  try { if (run.rec && run.rec.state !== 'inactive') run.rec.stop(); } catch { /* noop */ }
  if (run.recog) { const r = run.recog; run.recog = null; try { r.stop(); } catch { /* noop */ } }
  run.stream.getTracks().forEach((t) => t.stop());
  releaseScreen();
}

function abortSession() {
  if (!confirm('연습을 중단할까요? 지금까지의 녹음은 저장되지 않습니다.')) return;
  cleanupSession();
  run = null;
  home();
}

function finishSession() {
  cleanupSession();
  const results = run.results;
  run = null;
  const id = Date.now();
  lastSession = { id, results };
  const hist = load(LS.history, []);
  hist.unshift({
    id,
    date: new Date(id).toISOString(),
    items: results.map(({ no, kind, context, prompt, transcript, seconds }) => ({ no, kind, context, prompt, transcript, seconds })),
  });
  save(LS.history, hist.slice(0, 100));
  reviewView();
}

// ---------- 결과 검토 ----------

const ERR_TYPES = ['시제', '관사', '수일치', '전치사', '어순', '대명사', '문장연결', '단어형태', '기타'];
const ERR_INSTR = [
  '고칠 점은 가장 반복될 가능성이 높은 문법 오류 유형을 첫째로 설명해줘.',
  `답변 맨 끝에 아래 형식의 집계 블록을 붙여줘. 유형은 이 목록에서만 골라 쓰고(${ERR_TYPES.join(', ')}), 이번 답변들에서 나온 문법 오류 횟수를 세어줘. 오류가 없는 유형은 생략해.`,
  '[오류집계]',
  '시제: 2',
  '관사: 1',
  '[/오류집계]',
];

function buildAudioPrompt(entries) {
  const list = entries.map((e) => [
    `- ${e.no} (${TITLE[e.kind]}, ${e.seconds}초)${e.context ? ` ${e.context}` : ''}`,
    `  문항: ${e.prompt}`,
  ].join('\n')).join('\n');
  return [
    '첨부한 오디오 파일들은 TOEIC Speaking 연습 답변이야. 파일명(q5, q6 ...)이 문항 번호야.',
    '각 답변을 직접 듣고 발음·억양·강세, 유창성, 문법, 어휘, 내용 완결성 기준으로 평가해줘.',
    '문항별 점수(0-3 또는 0-5, 기준을 명시)와 0-200 환산 추정 점수, 잘한 점 1가지, 고칠 점은 최대 3가지, 모범 답안을 줘.',
    '어조는 담담하고 구체적으로, 사람 자체나 목소리를 평가하는 표현은 빼고 다음에 바로 고칠 수 있는 행동 위주로 말해줘.',
    ...ERR_INSTR,
    '',
    '문항 목록:',
    list,
  ].join('\n');
}

function audioFiles(results) {
  return results.map((r) => {
    const ext = r.mime.includes('mp4') ? 'm4a' : r.mime.includes('ogg') ? 'ogg' : 'webm';
    return new File([r.blob], `${r.no.toLowerCase()}.${ext}`, { type: r.mime.split(';')[0] });
  });
}

async function shareToGemini(results, btn) {
  const text = buildAudioPrompt(results);
  const files = audioFiles(results);
  await copyText(text);
  if (navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files, text, title: 'TOEIC Speaking 연습' });
      btn.textContent = '공유 시트에서 Gemini를 선택했다면, 채점 문구는 클립보드에도 복사돼 있어요';
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  btn.textContent = '이 기기는 파일 공유를 지원하지 않아요. 문구는 복사됨 (녹음 파일은 각 플레이어의 ⋮ 메뉴에서 다운로드)';
}

function buildScoringPrompt(entries) {
  const body = entries.map((e) => [
    `[${e.no} ${TITLE[e.kind]}]`,
    e.context || '',
    `문항: ${e.prompt}`,
    `답변(음성 인식 텍스트): ${e.transcript || '(없음)'}`,
    `답변 시간: ${e.seconds}초`,
  ].filter(Boolean).join('\n')).join('\n\n');
  return [
    '아래는 TOEIC Speaking 연습 답변이다. 문항별로 문법, 어휘, 내용 완결성, 구성을 평가하고,',
    '문항별 점수(0-3 또는 0-5, 기준을 명시)와 0-200 환산 추정 점수, 고칠 점 3가지, 모범 답안을 줘.',
    '텍스트만 보고 평가하는 것이므로 발음과 억양은 평가에서 제외해.',
    ...ERR_INSTR,
    '',
    body,
  ].join('\n');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { value: text });
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function parseErrors(text) {
  const m = text.replace(/[*_`]/g, '').match(/\[오류집계\]([\s\S]*?)(\[\/오류집계\]|$)/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const x = line.match(/^\s*[-•]?\s*([^:：\d\s][^:：]*?)\s*[:：]\s*(\d+)/);
    if (x) out[x[1]] = (out[x[1]] || 0) + Number(x[2]);
  }
  return Object.keys(out).length ? out : null;
}

function topErrors(n = 3, sessions = 10) {
  const total = {};
  load(LS.history, []).filter((s) => s.errors).slice(0, sessions).forEach((s) => {
    for (const [k, v] of Object.entries(s.errors)) total[k] = (total[k] || 0) + v;
  });
  return Object.entries(total).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function reviewView() {
  const { id, results } = lastSession;
  const cards = results.map((r) => {
    const url = URL.createObjectURL(r.blob);
    const ta = h('textarea', {
      value: r.transcript,
      placeholder: '받아쓰기가 꺼져 있으면 여기에 직접 입력하거나 수정할 수 있어요.',
      oninput: () => {
        r.transcript = ta.value;
        const hist = load(LS.history, []);
        const entry = hist.find((x) => x.id === id);
        const it = entry?.items.find((x) => x.no === r.no);
        if (it) { it.transcript = ta.value; save(LS.history, hist); }
      },
    });
    return h('div', { class: 'card' },
      h('div', { class: 'meta' }, `${r.no} · ${TITLE[r.kind]} · ${r.seconds}초`),
      r.context && h('div', { class: 'meta' }, r.context),
      h('div', { class: 'q' }, r.prompt),
      h('details', null, h('summary', { class: 'meta' }, '내 녹음 듣기 (선택)'), h('audio', { controls: true, preload: 'none', src: url })),
      h('label', null, '답변 텍스트'),
      ta,
    );
  });
  const copyBtn = h('button', { class: 'btn ghost', onclick: async () => {
    const ok = await copyText(buildScoringPrompt(results));
    copyBtn.textContent = ok ? '복사됨. AI 앱에 붙여넣으세요' : '복사 실패';
  } }, '텍스트만 채점 요청 (문구 복사)');
  const shareBtn = h('button', { class: 'btn primary', onclick: () => shareToGemini(results, shareBtn) }, '녹음을 Gemini 앱으로 보내 채점');
  const paste = h('textarea', { placeholder: 'Gemini 답변 전체를 붙여넣으세요. 끝의 [오류집계] 블록을 읽어 갑니다.' });
  const pasteMsg = h('div', { class: 'meta' });
  const pasteBtn = h('button', { class: 'btn', onclick: () => {
    const errs = parseErrors(paste.value);
    if (!errs) { pasteMsg.textContent = '[오류집계] 블록을 못 찾았어요. 답변 끝까지 붙여넣었는지 확인해 주세요.'; return; }
    const hist = load(LS.history, []);
    const entry = hist.find((x) => x.id === id);
    if (entry) { entry.errors = errs; entry.feedback = paste.value; save(LS.history, hist); }
    pasteMsg.textContent = `반영됨: ${Object.entries(errs).map(([k, v]) => `${k} ${v}`).join(', ')}`;
  } }, '집계에 반영');
  mount(
    h('h1', null, '결과'),
    h('p', { class: 'meta' }, '녹음은 이 화면을 벗어나면 사라집니다. 답변 텍스트는 기록에 남습니다.'),
    cards,
    shareBtn,
    copyBtn,
    h('h2', null, '피드백 집계'),
    paste, pasteMsg, pasteBtn,
    h('button', { class: 'btn ghost', onclick: home }, '홈으로'),
  );
}

// ---------- 기록 / 설정 ----------

function historyView() {
  const hist = load(LS.history, []);
  const list = hist.length
    ? hist.map((s) => h('details', { class: 'card' },
      h('summary', null, new Date(s.date).toLocaleString('ko-KR'), ` · ${s.items.length}문항`),
      s.errors && h('div', { class: 'meta' }, Object.entries(s.errors).map(([k, v]) => `${k} ${v}`).join(' · ')),
      s.items.map((it) => h('div', null,
        h('h2', null, `${it.no} · ${TITLE[it.kind]} · ${it.seconds}초`),
        h('div', { class: 'meta' }, it.prompt),
        h('div', { class: 'transcript' }, it.transcript || '(텍스트 없음)'),
      )),
    ))
    : h('p', { class: 'meta' }, '아직 기록이 없어요.');
  mount(
    h('h1', null, '기록'),
    list,
    hist.length && h('button', { class: 'btn ghost', onclick: () => { if (confirm('기록을 모두 지울까요?')) { save(LS.history, []); historyView(); } } }, '기록 모두 지우기'),
    h('button', { class: 'btn ghost', onclick: home }, '홈으로'),
  );
}

function settingsView() {
  const toggle = (key, label, hint) => h('label', null,
    h('input', { type: 'checkbox', checked: settings[key], onchange: (e) => { settings[key] = e.target.checked; save(LS.settings, settings); } }),
    ` ${label}`,
    hint && h('div', { class: 'meta' }, hint),
  );
  mount(
    h('h1', null, '설정'),
    h('div', { class: 'card' },
      toggle('beep', '신호음 / 진동'),
      toggle('stt', '실시간 받아쓰기 (실험적)', '안드로이드 크롬에서 녹음이 안 되거나 끊기면 끄세요. 아이폰은 지원이 불안정해요.'),
    ),
    h('button', { class: 'btn ghost', onclick: home }, '홈으로'),
  );
}

// ---------- 시작 ----------

async function init() {
  try {
    bank = await (await fetch('questions.json')).json();
  } catch {
    mount(h('p', { class: 'err' }, '문제 파일을 불러오지 못했어요. 네트워크를 확인해 주세요.'));
    return;
  }
  home();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* 오프라인 캐시만 포기 */ });
  }
}

init();
