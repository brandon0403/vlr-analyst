'use strict';

/* ------------------------------------------------------------------ */
/* 상태                                                                */
/* ------------------------------------------------------------------ */

var DB = null;        // index.json
var PLAYERS = null;   // players.json
var MCACHE = {};      // 경기 상세 캐시
var EV_LOGO = {};     // 이벤트명 -> 로고
var TEAM_LOGO = {};   // 팀명 -> 로고
var AGENT_ASSETS = {};// fetch_assets.py 로 받아둔 요원 초상화 파일명
var VODS = null;      // 경기ID -> {v:[[라벨,URL]], s:[[채널,URL]]}. 첫 경기 상세에서 불러온다
var app = document.getElementById('app');

/* index.json 의 matches 는 배열의 배열이다 (build_data.py meta.columns 와 동일 순서) */
var M_ID = 0, M_DATE = 1, M_EVENT = 2, M_SERIES = 3, M_FORMAT = 4,
    M_T1 = 5, M_T2 = 6, M_DETAIL = 7, M_MAPS = 8;
var T_NAME = 0, T_SCORE = 1, T_COUNTRY = 2;

// 등급 정렬 순서 (build_data.py 의 TIERS 와 동일)
var TIER_ORDER = { t1: 0, t1x: 1, t2: 2, gc: 3, etc: 4 };

var MAP_METHOD = {
  elim: ['✕', '제압'],
  boom: ['✹', '스파이크 폭발'],
  defuse: ['◈', '해체'],
  time: ['◷', '시간 종료']
};

/* ------------------------------------------------------------------ */
/* 유틸                                                                */
/* ------------------------------------------------------------------ */

function h(html) { return String(html == null ? '' : html)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function el(html) { var d = document.createElement('div'); d.innerHTML = html; return d; }

/* 국가: 윈도우 크롬은 국기 이모지를 렌더링하지 않으므로 2글자 코드로 표시 */
function flag(code) {
  if (!code || !/^[a-z]{2}$/.test(code)) return '<span class="flag"></span>';
  return '<span class="flag" title="' + h(code.toUpperCase()) + '">' + code.toUpperCase() + '</span>';
}

function img(src, cls) {
  if (!src) return '<span class="' + (cls || '') + '"></span>';
  return '<img class="' + (cls || '') + '" src="' + h(src) + '" loading="lazy" ' +
    'onerror="this.style.visibility=\'hidden\'">';
}

/** "2026-07-31 20:25:00" (UTC) -> Date */
function parseTs(s) {
  if (!s) return null;
  var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

var WD = ['일', '월', '화', '수', '목', '금', '토'];

function fmtDay(d) {
  if (!d) return '날짜 미상';
  return d.getFullYear() + '년 ' + (d.getMonth() + 1) + '월 ' + d.getDate() + '일 (' + WD[d.getDay()] + ')';
}
function fmtTime(d) {
  if (!d) return '';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function dayKey(d) {
  if (!d) return 'x';
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

function signed(v) {
  if (v == null || v === '') return '<span class="zero">-</span>';
  var n = parseFloat(String(v).replace('+', ''));
  var cls = isNaN(n) ? 'zero' : n > 0 ? 'pos' : n < 0 ? 'neg' : 'zero';
  var txt = String(v);
  if (!/^[+-]/.test(txt) && !isNaN(n) && n > 0) txt = '+' + txt;
  return '<span class="' + cls + '">' + h(txt) + '</span>';
}

function dash(v) { return (v == null || v === '') ? '<span class="zero">-</span>' : h(v); }

function getJSON(url) {
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error(url + ' → ' + r.status);
    return r.json();
  });
}

function debounce(fn, ms) {
  var t; return function () { var a = arguments, s = this; clearTimeout(t); t = setTimeout(function () { fn.apply(s, a); }, ms); };
}

/* ------------------------------------------------------------------ */
/* 라우터                                                              */
/* ------------------------------------------------------------------ */

var ROUTES = [
  [/^#\/matches/, viewMatches],
  [/^#\/match\/(\d+)/, viewMatch],
  [/^#\/events/, viewEvents],
  [/^#\/teams/, viewTeams],
  [/^#\/player\/(\d+)/, viewPlayer],
  [/^#\/players/, viewPlayers],
  [/^#\/stats/, viewStats],
  [/^#\/about/, viewAbout]
];

/* players/<pid>.json 의 matches 컬럼 순서 (build_data.py PM_COLS 와 동일) */
var PM_ID = 0, PM_DATE = 1, PM_EVENT = 2, PM_SERIES = 3, PM_TEAM = 4, PM_OPP = 5,
    PM_SCORE = 6, PM_OPPSCORE = 7, PM_WON = 8, PM_MAPS = 9, PM_AGENTS = 10,
    PM_K = 11, PM_D = 12, PM_A = 13, PM_RATING = 14, PM_ACS = 15, PM_ADR = 16,
    PM_KAST = 17, PM_HS = 18, PM_FK = 19, PM_FD = 20;

function route() {
  var hash = location.hash || '#/matches';
  document.querySelectorAll('#nav a').forEach(function (a) {
    a.classList.toggle('on', hash.indexOf(a.getAttribute('href')) === 0);
  });
  for (var i = 0; i < ROUTES.length; i++) {
    var m = ROUTES[i][0].exec(hash);
    if (m) { window.scrollTo(0, 0); ROUTES[i][1](m, new URLSearchParams(hash.split('?')[1] || '')); return; }
  }
  location.hash = '#/matches';
}

window.addEventListener('hashchange', route);

/* ------------------------------------------------------------------ */
/* 경기 목록                                                           */
/* ------------------------------------------------------------------ */

var PAGE_SIZE = 60;
var listState = { q: '', ev: '', team: '', page: 0, onlyDetail: false };

function matchRowHTML(m) {
  var d = parseTs(m[M_DATE]);
  var t0 = m[M_T1], t1 = m[M_T2];
  var s0 = t0[T_SCORE], s1 = t1[T_SCORE];
  var l0 = (s0 != null && s1 != null && s0 < s1), l1 = (s0 != null && s1 != null && s1 < s0);
  function team(t, lost) {
    var logo = TEAM_LOGO[t[T_NAME]];
    return '<div class="mteam' + (lost ? ' lost' : '') + '">' +
      (logo ? img(logo) : flag(t[T_COUNTRY])) +
      '<span class="nm">' + h(t[T_NAME] || '?') + '</span>' +
      '<span class="sc">' + (t[T_SCORE] == null ? '-' : t[T_SCORE]) + '</span></div>';
  }
  var badge = m[M_DETAIL]
    ? '<span class="fmt">' + h(m[M_FORMAT] || 'Bo?') + '</span>'
    : '<span class="fmt dim" title="상세 스탯 스냅샷이 없는 경기입니다">요약</span>';
  return '<div class="mrow" data-id="' + m[M_ID] + '">' +
    '<div class="time">' + h(fmtTime(d)) + '</div>' +
    '<div class="teams">' + team(t0, l0) + team(t1, l1) + '</div>' +
    '<div>' + badge + '</div>' +
    '<div class="ev"><div class="en">' + h(m[M_EVENT] || '이벤트 미상') + '</div>' +
    '<div class="es">' + h(m[M_SERIES] || '') + '</div></div>' +
    '</div>';
}

function filterMatches() {
  var q = listState.q.trim().toLowerCase();
  var terms = q ? q.split(/\s+/) : [];
  return DB.matches.filter(function (m) {
    if (listState.onlyDetail && !m[M_DETAIL]) return false;
    if (listState.ev && m[M_EVENT] !== listState.ev) return false;
    if (listState.team && m[M_T1][T_NAME] !== listState.team && m[M_T2][T_NAME] !== listState.team) return false;
    if (!terms.length) return true;
    var hay = ((m[M_T1][T_NAME] || '') + ' ' + (m[M_T2][T_NAME] || '') + ' ' + (m[M_EVENT] || '') + ' ' +
      (m[M_SERIES] || '') + ' ' + (m[M_MAPS] || []).join(' ')).toLowerCase();
    return terms.every(function (t) { return hay.indexOf(t) >= 0; });
  });
}

function renderMatchList() {
  var res = filterMatches();
  var total = res.length;
  var pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (listState.page >= pages) listState.page = pages - 1;
  var slice = res.slice(listState.page * PAGE_SIZE, (listState.page + 1) * PAGE_SIZE);

  var withDetail = res.reduce(function (n, m) { return n + m[M_DETAIL]; }, 0);
  var out = '<div class="sub">' + total.toLocaleString() + '경기 · 상세 ' +
    withDetail.toLocaleString() + '경기' +
    (total ? ' · ' + (listState.page + 1) + ' / ' + pages + ' 페이지' : '') + '</div>';

  if (!slice.length) {
    out += '<div class="card"><div class="empty">조건에 맞는 경기가 없습니다.</div></div>';
  } else {
    var cur = null, buf = '';
    slice.forEach(function (m) {
      var d = parseTs(m[M_DATE]), k = dayKey(d);
      if (k !== cur) {
        if (cur !== null) buf += '</div></div>';
        cur = k;
        buf += '<div class="daygroup"><div class="daylabel">' + h(fmtDay(d)) + '</div><div class="card">';
      }
      buf += matchRowHTML(m);
    });
    if (cur !== null) buf += '</div></div>';
    out += buf;
    var first = listState.page === 0, last = listState.page >= pages - 1;
    out += '<div class="pager">' +
      '<button class="btn" data-go="0"' + (first ? ' disabled' : '') + ' title="첫 페이지">«</button>' +
      '<button class="btn" data-pg="-1"' + (first ? ' disabled' : '') + '>← 이전</button>' +
      '<span class="pgjump">' +
      '<input type="text" id="pgin" inputmode="numeric" value="' + (listState.page + 1) + '" ' +
      'aria-label="페이지 번호" title="번호를 입력하고 Enter">' +
      ' / ' + pages.toLocaleString() + '</span>' +
      '<button class="btn" data-pg="1"' + (last ? ' disabled' : '') + '>다음 →</button>' +
      '<button class="btn" data-go="' + (pages - 1) + '"' + (last ? ' disabled' : '') +
      ' title="마지막 페이지">»</button>' +
      '</div>';
  }

  var host = document.getElementById('mlist');
  host.innerHTML = out;
  host.querySelectorAll('.mrow').forEach(function (r) {
    r.onclick = function () { location.hash = '#/match/' + r.dataset.id; };
  });
  function goto(page) {
    listState.page = Math.min(Math.max(0, page), pages - 1);
    renderMatchList();
    window.scrollTo(0, 0);
  }
  host.querySelectorAll('[data-pg]').forEach(function (b) {
    b.onclick = function () { goto(listState.page + (+b.dataset.pg)); };
  });
  host.querySelectorAll('[data-go]').forEach(function (b) {
    b.onclick = function () { goto(+b.dataset.go); };
  });

  var pgin = document.getElementById('pgin');
  if (pgin) {
    pgin.onkeydown = function (e) {
      if (e.key !== 'Enter') return;
      var n = parseInt(pgin.value.replace(/\D/g, ''), 10);
      if (!n) { pgin.value = listState.page + 1; return; }
      goto(n - 1);
    };
    pgin.onfocus = function () { pgin.select(); };
    // 입력 중 이탈하면 원래 번호로 되돌린다
    pgin.onblur = function () { pgin.value = listState.page + 1; };
  }
}

function viewMatches(_, params) {
  // 이벤트/팀 카드에서 넘어온 경우: 빈 목록으로 보이지 않게 '상세만' 을 함께 해제한다
  if (params.get('ev')) {
    listState.ev = params.get('ev');
    listState.team = ''; listState.page = 0; listState.onlyDetail = false;
  }
  if (params.get('team')) {
    listState.team = params.get('team');
    listState.ev = ''; listState.page = 0; listState.onlyDetail = false;
  }

  var evOpts = DB.events.map(function (e) {
    return '<option value="' + h(e.name) + '"' + (e.name === listState.ev ? ' selected' : '') + '>' +
      h(e.name) + ' (' + e.count + ')</option>';
  }).join('');
  // teams 는 5,530개(경기수 내림차순)라 600개로 자른다. 그런데 팀 탭에서
  // 클릭해 들어오면 잘린 쪽 팀도 필터로 걸릴 수 있고, 그러면 드롭다운은
  // '모든 팀'을 보여주면서 해제도 안 된다. 걸린 팀은 항상 옵션에 넣는다.
  var teamList = DB.teams.slice(0, 600);
  if (listState.team && !teamList.some(function (t) { return t.name === listState.team; })) {
    var exact = DB.teams.filter(function (t) { return t.name === listState.team; })[0];
    teamList = [exact || { name: listState.team, matches: 0 }].concat(teamList);
  }
  var teamOpts = teamList.map(function (t) {
    return '<option value="' + h(t.name) + '"' + (t.name === listState.team ? ' selected' : '') + '>' +
      h(t.name) + ' (' + t.matches + ')</option>';
  }).join('');

  app.innerHTML =
    '<h1>경기</h1>' +
    '<div class="controls">' +
    '<input type="search" id="q" placeholder="팀 · 이벤트 · 맵 이름으로 검색" value="' + h(listState.q) + '">' +
    '<select id="fev"><option value="">모든 이벤트</option>' + evOpts + '</select>' +
    '<select id="fteam"><option value="">모든 팀</option>' + teamOpts + '</select>' +
    '<button class="btn' + (listState.onlyDetail ? ' on' : '') + '" id="onlyd" ' +
    'title="선수 스탯·라운드 데이터가 있는 경기만 봅니다">상세만</button>' +
    '<button class="btn" id="reset">초기화</button>' +
    '</div><div id="mlist"></div>';

  document.getElementById('q').oninput = debounce(function (e) {
    listState.q = e.target.value; listState.page = 0; renderMatchList();
  }, 180);
  document.getElementById('fev').onchange = function (e) {
    listState.ev = e.target.value; listState.page = 0; renderMatchList();
  };
  document.getElementById('fteam').onchange = function (e) {
    listState.team = e.target.value; listState.page = 0; renderMatchList();
  };
  document.getElementById('onlyd').onclick = function () {
    listState.onlyDetail = !listState.onlyDetail; listState.page = 0;
    this.classList.toggle('on', listState.onlyDetail);
    renderMatchList();
  };
  document.getElementById('reset').onclick = function () {
    listState = { q: '', ev: '', team: '', page: 0, onlyDetail: false };
    viewMatches(null, new URLSearchParams());
  };
  renderMatchList();
}

/* ------------------------------------------------------------------ */
/* 경기 상세                                                           */
/* ------------------------------------------------------------------ */

var detail = { side: 'both', tab: 'all', view: 'overview', matrix: 'normal', round: 0 };

function statCell(st, col, side) {
  var v = (st[col] || {})[side];
  if (v == null && side !== 'both') v = null;
  return v;
}

var SB_COLS = [
  ['rating2', 'R', 'Rating 2.0'],
  ['acs', 'ACS', '라운드당 평균 전투 점수'],
  ['kills', 'K', '킬'],
  ['deaths', 'D', '데스'],
  ['assists', 'A', '어시스트'],
  ['kd-diff', '+/−', '킬 − 데스'],
  ['kast', 'KAST', '킬/어시/트레이드/생존 비율'],
  ['adr', 'ADR', '라운드당 평균 피해량'],
  ['hsp', 'HS%', '헤드샷 비율'],
  ['fb', 'FK', '퍼스트 킬'],
  ['fd', 'FD', '퍼스트 데스'],
  ['fk-diff', '+/−', '퍼스트 킬 − 퍼스트 데스']
];

/** 요원 초상화 + 이름. 로컬 에셋 > vlr.gg 원본 > 이름만 순으로 대체된다. */
function agentHTML(a) {
  var name = a.name || '?';
  var file = a.img ? a.img.replace(/^.*\//, '') : '';
  var src = (file && AGENT_ASSETS[file]) ? 'assets/agents/' + file : a.img;
  var pic = src
    ? '<img src="' + h(src) + '" alt="" onerror="this.closest(\'.agent\').classList.add(\'noimg\')">'
    : '';
  return '<span class="agent' + (src ? '' : ' noimg') + '" title="' + h(name) + '">' +
    pic + '<i>' + h(name) + '</i></span>';
}

function scoreboardHTML(players, side) {
  if (!players || !players.length) return '<div class="empty">선수 스탯이 없습니다.</div>';
  var head = '<tr><th class="l">선수</th><th class="l">요원</th>' + SB_COLS.map(function (c) {
    return '<th title="' + h(c[2]) + '">' + h(c[1]) + '</th>';
  }).join('') + '</tr>';

  var body = players.map(function (p, i) {
    var sep = (i === 5) ? ' class="split"' : '';
    var cells = SB_COLS.map(function (c) {
      var v = statCell(p.stats, c[0], side);
      var isDiff = c[0].indexOf('diff') >= 0;
      return '<td>' + (isDiff ? signed(v) : dash(v)) + '</td>';
    }).join('');
    var ag = (p.agents || []).map(agentHTML).join('');
    var who = p.id
      ? '<a class="pname plink" href="#/player/' + p.id + '">' + flag(p.country) +
        '<span>' + h(p.name) + '</span><span class="tag">' + h(p.team) + '</span></a>'
      : '<div class="pname">' + flag(p.country) + '<span>' + h(p.name) + '</span>' +
        '<span class="tag">' + h(p.team) + '</span></div>';
    return '<tr' + sep + '><td class="l">' + who + '</td>' +
      '<td class="l"><div class="agents">' + ag + '</div></td>' + cells + '</tr>';
  }).join('');

  return '<div class="scroll-x"><table class="tbl"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
}

function roundsHTML(g) {
  if (!g.rounds || !g.rounds.length) return '';
  var t0 = 0, t1 = 0;
  var cells = g.rounds.map(function (r, i) {
    var out = '';
    if (i === 12 || (i > 24 && (i - 24) % 2 === 0)) out += '<div class="gap"></div>';
    var mm = MAP_METHOD[r.method] || ['', r.method || ''];
    var top = r.winner === 0 ? '<div class="sq ' + (r.side || '') + '" title="' + h(mm[1]) + '">' + mm[0] + '</div>' : '<div class="sq"></div>';
    var bot = r.winner === 1 ? '<div class="sq ' + (r.side || '') + '" title="' + h(mm[1]) + '">' + mm[0] + '</div>' : '<div class="sq"></div>';
    out += '<div class="rnd" title="' + h((r.score || '') + ' · ' + mm[1]) + '"><div class="n">' + r.n + '</div>' + top + bot + '</div>';
    return out;
  }).join('');
  return '<div class="rounds">' + cells + '</div>';
}

function halvesHTML(hv) {
  if (!hv) return '';
  var parts = [];
  if (hv.t != null) parts.push('<span class="h-t">T ' + hv.t + '</span>');
  if (hv.ct != null) parts.push('<span class="h-ct">CT ' + hv.ct + '</span>');
  if (hv.ot) parts.push('<span>OT ' + hv.ot + '</span>');
  return parts.join(' · ');
}

function econHTML(econ, gameId, teams) {
  if (!econ) return '';
  var g = econ.filter(function (e) { return String(e.game_id) === String(gameId); })[0];
  if (!g) return '';

  var sum = '';
  if (g.summary && g.summary.length) {
    sum = '<div class="scroll-x"><table class="tbl"><thead><tr><th class="l">팀</th>' +
      (g.columns || []).map(function (c) { return '<th>' + h(c) + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      g.summary.map(function (r) {
        return '<tr><td class="l">' + h(r.team) + '</td>' +
          r.cells.map(function (c) { return '<td>' + h(c) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>' +
      '<div class="sub" style="padding:8px 10px 0;margin:0">이코노미: 0–5k · $ 세미에코 5–10k · $$ 세미바이 10–20k · $$$ 풀바이 20k+</div>';
  }

  var rnd = '';
  if (g.rounds && g.rounds.length) {
    rnd = '<div class="rounds">' + g.rounds.map(function (r) {
      var b = r.bank || [];
      function sq(i) {
        var buy = (r.buys || [])[i] || {};
        var cls = r.winner === i ? ' ' + (r.side || 't') : ' dim';
        var cr = buy.credits ? (Math.round(+buy.credits / 100) / 10) + 'k 소지' : '';
        return '<div class="sq' + cls + '" title="' + h(cr) + '">' + h(buy.label || '') + '</div>';
      }
      return '<div class="econ-round"><div class="b">' + r.n + '</div>' +
        '<div class="b">' + h(b[0] || '') + '</div>' + sq(0) + sq(1) +
        '<div class="b">' + h(b[1] || '') + '</div></div>';
    }).join('') + '</div>';
  }
  if (!sum && !rnd) return '<div class="card"><div class="empty">이코노미 데이터가 없습니다.</div></div>';
  return '<div class="card">' + sum + rnd + '</div>';
}

var MATRIX_KINDS = [
  ['normal', '전체 킬'],
  ['fkfd', '퍼스트 킬'],
  ['op', '오퍼레이터 킬']
];

function perfGame(perf, gameId) {
  if (!perf) return null;
  var g = perf.filter(function (e) { return String(e.game_id) === String(gameId); })[0];
  return g || perf.filter(function (e) { return e.game_id === 'all'; })[0] || null;
}

function matrixHTML(m) {
  if (!m) return '<div class="empty">데이터가 없습니다.</div>';
  var head = '<tr><th class="l"></th>' + m.columns.map(function (c) {
    return '<th>' + h(c.name) + '<div style="font-weight:400;color:var(--fg-faint)">' + h(c.team) + '</div></th>';
  }).join('') + '</tr>';
  var body = m.rows.map(function (r) {
    return '<tr><td class="l">' + h(r.name) +
      ' <span class="tag" style="color:var(--fg-faint)">' + h(r.team) + '</span></td>' +
      r.cells.map(function (c) {
        if (!c || !c.length) return '<td></td>';
        var diff = c[2] || '';
        var cls = diff.indexOf('+') === 0 && diff !== '+0' ? 'pos'
          : diff.indexOf('-') === 0 ? 'neg' : 'zero';
        return '<td><span class="cell"><span>' + h(c[0] || '') + '</span><span>' + h(c[1] || '') +
          '</span><span class="' + cls + '">' + h(diff) + '</span></span></td>';
      }).join('') + '</tr>';
  }).join('');
  return '<div class="scroll-x"><table class="tbl matrix"><thead>' + head +
    '</thead><tbody>' + body + '</tbody></table></div>';
}

var ADV_HINT = {
  '2K': '더블 킬', '3K': '트리플 킬', '4K': '쿼드라 킬', '5K': '에이스',
  '1v1': '1대1 클러치', '1v2': '1대2 클러치', '1v3': '1대3 클러치',
  '1v4': '1대4 클러치', '1v5': '1대5 클러치',
  'ECON': '소비 크레딧 대비 효율', 'PL': '스파이크 설치', 'DE': '스파이크 해체'
};

/** 멀티킬·클러치 칸의 상세(라운드 · 잡은 대상)를 말풍선으로 */
function notableHTML(label, cell, mapName) {
  var lines = (cell.e || []).map(function (ev) {
    var kills = (ev.victims || []).map(function (v) {
      return '<span class="pop-kill">' + agentHTML({ name: v.agent, img: v.img }) +
        h(v.name) + '</span>';
    }).join('');
    return '<div class="pop-row"><b>' + (ev.round != null ? ev.round + '라운드' : '라운드 미상') +
      '</b><div class="pop-kills">' + kills + '</div></div>';
  }).join('');
  return '<span class="pop"><span class="pop-v">' + h(cell.v) + '</span>' +
    '<span class="pop-box"><span class="pop-head">' +
    (mapName ? h(mapName) + ' · ' : '') + h(label) + ' ' + h(cell.v) + '회</span>' +
    lines + '</span></span>';
}

function advHTML(g, mapName) {
  if (!g || !g.adv || !g.adv.length) return '';
  var cols = g.adv_columns || [];
  var hasDetail = g.adv.some(function (r) {
    return (r.cells || []).some(function (c) { return c && c.e && c.e.length; });
  });
  var head = '<tr><th class="l">선수</th><th class="l">요원</th>' +
    cols.map(function (c) { return '<th title="' + h(ADV_HINT[c] || c) + '">' + h(c) + '</th>'; }).join('') + '</tr>';
  var body = g.adv.map(function (r, i) {
    var sep = (i === 5) ? ' class="split"' : '';
    return '<tr' + sep + '><td class="l"><div class="pname"><span>' + h(r.name) + '</span>' +
      '<span class="tag">' + h(r.team) + '</span></div></td>' +
      '<td class="l"><div class="agents">' + (r.agents || []).map(agentHTML).join('') + '</div></td>' +
      (r.cells || []).map(function (c, ci) {
        // 예전 형식(문자열)도 그대로 받아준다
        if (typeof c === 'string') c = { v: c };
        if (!c || !c.v) return '<td><span class="zero">-</span></td>';
        if (!c.e || !c.e.length) return '<td>' + h(c.v) + '</td>';
        return '<td class="haspop">' + notableHTML(cols[ci] || '', c, mapName) + '</td>';
      }).join('') + '</tr>';
  }).join('');
  return '<h2>멀티킬 · 클러치' +
    (hasDetail
      ? ' <span class="chip">밑줄 친 숫자에 마우스를 올리면 라운드와 잡은 선수가 나옵니다</span>'
      : ' <span class="chip">라운드 상세는 맵별 탭에서만 볼 수 있습니다</span>') +
    '</h2><div class="card scroll-x">' +
    '<table class="tbl"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
}

/** 퍼포먼스 탭 전체 (매트릭스 3종 + 멀티킬/클러치) */
function performanceHTML(perf, gameId, kind, mapName) {
  var g = perfGame(perf, gameId);
  if (!g) {
    return '<div class="card"><div class="empty">이 경기는 퍼포먼스 스냅샷이 없습니다.</div></div>';
  }
  var avail = MATRIX_KINDS.filter(function (k) { return (g.matrix || {})[k[0]]; });
  var pick = avail.filter(function (k) { return k[0] === kind; })[0] || avail[0];
  var out = '';
  if (avail.length) {
    out += '<div class="card">' +
      '<div class="sidetoggle">' + avail.map(function (k) {
        return '<button data-mx="' + k[0] + '"' + (pick && k[0] === pick[0] ? ' class="on"' : '') + '>' +
          h(k[1]) + '</button>';
      }).join('') + '</div>' +
      '<div class="sub" style="padding:10px 26px 0;margin:0">' +
      '행 선수가 열 선수를 죽인 수 / 당한 수 / 차이</div>' +
      matrixHTML(g.matrix[pick[0]]) + '</div>';
  }
  out += advHTML(g, mapName);
  return out || '<div class="card"><div class="empty">퍼포먼스 데이터가 없습니다.</div></div>';
}

/* ------------------------------------------------------------------ */
/* 리플레이 (미니맵)                                                   */
/* ------------------------------------------------------------------ */

var MAPCAL = null;      // 맵 이름 -> 좌표 변환값
var RCACHE = {};        // "matchId-gameId" -> 리플레이 데이터
var play = { on: false, t: 0, speed: 1, raf: null, last: 0 };

/** 게임 좌표 -> 미니맵 0~1 좌표.
 *
 * 게임의 X 축이 미니맵 세로, Y 축이 가로에 대응한다. 그래서 가로에는 xMultiplier 를
 * 게임 Y 에, 세로에는 yMultiplier 를 게임 X 에 적용한다.
 * (13개 맵 콜아웃 300개를 전수 대입해 이 조합만 전부 0~1 안에 들어옴을 확인)
 */
function toMinimap(cal, x, y) {
  var u = y * cal.xMultiplier + cal.xScalarToAdd;
  var v = x * cal.yMultiplier + cal.yScalarToAdd;
  // valorant-api 의 맵 이미지는 게임 내 레이더와 90° 어긋나 있다. 시계방향으로
  // 돌려 rib.gg·게임과 같은 방향으로 맞춘다 (Ascent A 우측, Haven A 우측·C 좌측).
  // 이미지도 SVG 에서 같은 각도로 돌리므로 좌표와 그림이 함께 움직인다.
  return [1 - v, u];
}

/** 요원 초상화 파일명. 없으면 null. */
function agentFile(name) {
  if (!name) return null;
  var f = String(name).toLowerCase().replace(/[^a-z0-9]/g, '') + '.png';
  return AGENT_ASSETS[f] ? 'assets/agents/' + f : null;
}

function replayKey(m) {
  return m.id + '-' + (m.maps[detail.tab] || {}).game_id;
}

/** 좌표가 있는 이벤트(=관측 시점)만 모은다. 원본이 이 순간들만 알고 있다. */
function frames(round) {
  return (round.events || []).filter(function (e) { return e.loc; });
}

/** 관측 시점 t 에서의 상태.
 *
 *  보간하지 않는다. rib.gg 원본은 킬·설치·해체가 일어난 순간에만 좌표를 남기고
 *  그 사이에 선수가 어디로 어떻게 갔는지는 아무 데도 없다. 예전에는 두 시점을
 *  직선으로 이어 붙였는데, 없는 움직임을 지어내는 바람에 이동이 실제보다 느리고
 *  시선도 엉뚱한 곳을 향했다. 지금은 마지막 관측값을 그대로 유지한다.
 */
function posAt(round, t) {
  var fs = frames(round);
  if (!fs.length) return null;
  var cur = fs[0];
  for (var i = 0; i < fs.length; i++) {
    if (fs[i].t <= t) cur = fs[i];
    else break;
  }
  var dead = {};
  (round.events || []).forEach(function (e) {
    if (e.type === 'kill' && e.t <= t) dead[e.victim] = e.t;
  });
  return { loc: cur.loc, dead: dead, at: cur.t, stale: t > cur.t, ev: cur };
}

function minimapSVG(rep, cal, round, t) {
  var st = posAt(round, t);
  var img = 'assets/maps/' + (cal.img || '');
  var R = 2.2;            // 초상화 반지름 (viewBox 100 기준)
  var cones = '', marks = '', defs = '';
  if (st) {
    rep.players.forEach(function (p, i) {
      var L = st.loc[i];
      if (!L) return;
      var mp = toMinimap(cal, L[0], L[1]);
      var clamp = function (v) { return Math.max(R + .5, Math.min(100 - R - .5, v * 100)); };
      var cx = clamp(mp[0]).toFixed(2), cy = clamp(mp[1]).toFixed(2);
      var isDead = st.dead[i] != null;
      var cls = 'pd t' + p.team + (isDead ? ' dead' : '');
      // 시선 방향 부채꼴. 좌표를 90° 돌렸으므로 각도도 같이 돌린다.
      if (!isDead && L[2] != null) {
        var a = L[2] + Math.PI / 2, w = 0.45, r = R + 3.0;
        var p1 = [(+cx) + Math.cos(a - w) * r, (+cy) + Math.sin(a - w) * r];
        var p2 = [(+cx) + Math.cos(a + w) * r, (+cy) + Math.sin(a + w) * r];
        cones += '<path class="pcone t' + p.team + '" d="M' + cx + ' ' + cy +
          ' L' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2) +
          ' L' + p2[0].toFixed(2) + ' ' + p2[1].toFixed(2) + ' Z"/>';
      }
      // 이름 대신 요원 초상화. 겹쳐도 누군지 알아볼 수 있고 글자가 서로를 가리지 않는다.
      var face = agentFile(p.agent);
      var id = 'ac' + i;
      var body;
      if (face) {
        defs += '<clipPath id="' + id + '"><circle cx="' + cx + '" cy="' + cy +
          '" r="' + R + '"/></clipPath>';
        body = '<image href="' + h(face) + '" x="' + ((+cx) - R).toFixed(2) +
          '" y="' + ((+cy) - R).toFixed(2) + '" width="' + (R * 2) + '" height="' + (R * 2) +
          '" clip-path="url(#' + id + ')" preserveAspectRatio="xMidYMid slice"/>';
      } else {
        body = '<circle class="nof" cx="' + cx + '" cy="' + cy + '" r="' + (R * 0.6) + '"/>';
      }
      marks += '<g class="' + cls + '"><title>' + h(p.name || '') +
        (p.agent ? ' · ' + h(p.agent) : '') + '</title>' +
        body + '<circle class="ring" cx="' + cx + '" cy="' + cy + '" r="' + R + '"/></g>';
    });
  }
  // 이 장면이 킬이면 잡은 쪽 → 죽은 쪽으로 점선을 잇는다 (깜박이며 눈에 띄게)
  var link = '';
  if (st && st.ev && st.ev.type === 'kill') {
    var kp = st.ev.loc[st.ev.killer], vp = st.ev.loc[st.ev.victim];
    if (kp && vp) {
      var a = toMinimap(cal, kp[0], kp[1]), b = toMinimap(cal, vp[0], vp[1]);
      var cl = function (v) { return Math.max(0, Math.min(100, v * 100)).toFixed(2); };
      var team = rep.players[st.ev.killer] ? rep.players[st.ev.killer].team : 0;
      link = '<line class="klink t' + team + '" x1="' + cl(a[0]) + '" y1="' + cl(a[1]) +
        '" x2="' + cl(b[0]) + '" y2="' + cl(b[1]) + '"/>';
    }
  }
  return '<svg class="mmap" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">' +
    '<defs>' + defs + '</defs>' +
    '<image href="' + h(img) + '" x="0" y="0" width="100" height="100" ' +
    'transform="rotate(90 50 50)"/>' +
    cones + link + marks + '</svg>';
}

function feedHTML(rep, round, t) {
  var rows = (round.events || []).map(function (e) {
    var done = e.t <= t;
    var time = Math.floor(e.t / 1000);
    var stamp = Math.floor(time / 60) + ':' + String(time % 60).padStart(2, '0');
    var body;
    if (e.type === 'kill') {
      var k = rep.players[e.killer] || {}, v = rep.players[e.victim] || {};
      body = '<span class="k t' + k.team + '">' + h(k.name || '?') + '</span>' +
        '<span class="w">' + h(e.weapon || '') + '</span>' +
        '<span class="k t' + v.team + '">' + h(v.name || '?') + '</span>';
    } else if (e.type === 'plant') {
      body = '<span class="ev">스파이크 설치' + (e.site ? ' (' + h(e.site) + ')' : '') + '</span>';
    } else if (e.type === 'defuse') {
      body = '<span class="ev">스파이크 해체</span>';
    } else {
      body = '<span class="ev">' + h(e.type) + '</span>';
    }
    return '<div class="fev' + (done ? ' done' : '') + '" data-t="' + e.t + '">' +
      '<span class="ts">' + stamp + '</span>' + body + '</div>';
  }).join('');
  return '<div class="feed"><div class="feed-t">이벤트</div>' +
    (rows || '<div class="rnone">이벤트가 없습니다.</div>') + '</div>';
}

function replayHTML(m) {
  if (detail.tab === 'all') {
    return '<div class="card"><div class="empty">리플레이는 맵별로만 볼 수 있습니다.</div></div>';
  }
  var rep = RCACHE[replayKey(m)];
  if (!rep) {
    return '<div class="card"><div class="empty">이 맵은 리플레이 데이터가 없습니다.<br>' +
      '<span class="tdim">위치 데이터가 확보되면 여기에 표시됩니다.</span></div></div>';
  }
  var cal = (MAPCAL || {})[rep.map];
  if (!cal) {
    return '<div class="card"><div class="empty">맵 좌표 정보가 없습니다.<br>' +
      '<code>python fetch_assets.py --maps-only</code> 를 실행하세요.</div></div>';
  }
  var ri = Math.min(Math.max(0, detail.round | 0), rep.rounds.length - 1);
  var round = rep.rounds[ri];
  var dur = round.duration || 1;
  var t = Math.max(0, Math.min(dur, play.t));

  var warn = rep.sample
    ? '<div class="samplewarn">샘플 데이터입니다 — 좌표는 실제 경기 위치가 아니라 ' +
      '화면 확인용으로 생성한 가상 값입니다. 라운드 승패·승리 방식만 실제와 같습니다.</div>'
    : '';
  // 외부에서 가져온 위치 데이터는 출처를 밝힌다
  var credit = rep.source
    ? '<div class="tdim" style="font-size:12px;margin:0 0 8px">위치 데이터 출처: ' +
      (rep.source_url
        ? '<a href="' + h(rep.source_url) + '" target="_blank" rel="noopener">' + h(rep.source) + ' ↗</a>'
        : h(rep.source)) + '</div>'
    : '';

  var secs = Math.floor(t / 1000);
  var clock = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
  var fs = frames(round);
  var fi = frameIndex(round, t);

  var ctrl = '<div class="rpctrl">' +
    '<button class="pbtn" id="pprev" title="이전 장면">◀◀</button>' +
    '<button class="pbtn" id="pplay">' + (play.on ? '❚❚' : '▶') + '</button>' +
    '<button class="pbtn" id="pnext" title="다음 장면">▶▶</button>' +
    '<input type="range" id="pseek" min="0" max="' + dur + '" value="' + t + '">' +
    '<span class="clock">' + clock + '</span>' +
    '<span class="fidx tdim">장면 ' + (fi + 1) + '/' + fs.length + '</span>' +
    [0.5, 1, 2, 4].map(function (s) {
      return '<button class="sbtn' + (play.speed === s ? ' on' : '') +
        '" data-sp="' + s + '">' + s + '×</button>';
    }).join('') + '</div>' +
    '<div class="rpnote tdim">좌표는 킬·설치·해체가 일어난 <b>' + fs.length +
    '개 순간</b>에만 기록돼 있습니다. 그 사이 이동 경로는 원본에 없어 ' +
    '장면에서 장면으로 건너뜁니다.</div>';

  // 라운드 이동 — 라운드 탭과 같은 data-rgo 를 써서 핸들러를 공유한다
  var ri = Math.min(Math.max(0, detail.round | 0), rep.rounds.length - 1);
  var rnav = '<div class="rpround">' +
    '<button class="btn" data-rgo="' + (ri - 1) + '"' + (ri === 0 ? ' disabled' : '') +
    '>← 이전 라운드</button>' +
    '<b>Round ' + round.n + '</b>' +
    '<span class="tdim">/ ' + rep.rounds.length + ' · ' + h(rep.map) + '</span>' +
    '<button class="btn" data-rgo="' + (ri + 1) + '"' +
    (ri >= rep.rounds.length - 1 ? ' disabled' : '') + '>다음 라운드 →</button>' +
    '</div>' +
    '<div class="rpjump">' + rep.rounds.map(function (x, i) {
      return '<button class="rgo' + (i === ri ? ' on' : '') + '" data-rgo="' + i +
        '" title="Round ' + x.n + '">' + x.n + '</button>';
    }).join('') + '</div>';

  return warn + credit +
    '<div class="card rpcard">' +
    rnav +
    '<div class="rpbody"><div class="rpmap">' + minimapSVG(rep, cal, round, t) + '</div>' +
    feedHTML(rep, round, t) + '</div>' + ctrl + '</div>';
}

/** 지금 시각이 몇 번째 장면인지 (좌표가 있는 이벤트 기준) */
function frameIndex(round, t) {
  var fs = frames(round);
  var idx = 0;
  for (var i = 0; i < fs.length; i++) {
    if (fs[i].t <= t) idx = i;
    else break;
  }
  return idx;
}

/** 한 장면에 머무는 시간 (1× 기준). 원본에 중간 경로가 없으니 실시간 재생은 뜻이 없다. */
var DWELL_MS = 1100;

/** 장면 이동. dir 이 +1 이면 다음, -1 이면 이전. */
function stepFrame(m, dir) {
  var rep = RCACHE[replayKey(m)];
  if (!rep) return false;
  var round = rep.rounds[Math.min(detail.round | 0, rep.rounds.length - 1)];
  var fs = frames(round);
  if (!fs.length) return false;
  var i = frameIndex(round, play.t);
  // 첫 장면 이전(라운드 시작)에 있으면 다음은 첫 장면이다
  if (dir > 0 && play.t < fs[0].t) { play.t = fs[0].t; paintReplay(m); return true; }
  var j = i + dir;
  if (j < 0 || j >= fs.length) return false;
  play.t = fs[j].t;
  paintReplay(m);
  return true;
}

/** 재생 루프 — 장면에서 장면으로 건너뛴다 */
function stopPlay() {
  play.on = false;
  if (play.raf) { clearTimeout(play.raf); play.raf = null; }
}

function startPlay(m) {
  var rep = RCACHE[replayKey(m)];
  if (!rep) return;
  var round = rep.rounds[Math.min(detail.round | 0, rep.rounds.length - 1)];
  if (!frames(round).length) return;
  play.on = true;
  var tick = function () {
    if (!play.on) return;
    if (!stepFrame(m, 1)) { stopPlay(); paintReplay(m); return; }
    play.raf = setTimeout(tick, DWELL_MS / (play.speed || 1));
  };
  // 마지막 장면에 서 있으면 처음부터 다시
  var fs = frames(round);
  if (play.t >= fs[fs.length - 1].t) play.t = 0;
  paintReplay(m);
  play.raf = setTimeout(tick, DWELL_MS / (play.speed || 1));
}

/** 재생 중에는 전체를 다시 그리지 않고 점과 피드만 갱신한다 */
function paintReplay(m) {
  var rep = RCACHE[replayKey(m)];
  if (!rep) return;
  var cal = (MAPCAL || {})[rep.map];
  var round = rep.rounds[Math.min(detail.round | 0, rep.rounds.length - 1)];
  var dur = round.duration || 1;
  var t = Math.max(0, Math.min(dur, play.t));
  var host = document.querySelector('.rpmap');
  if (host && cal) host.innerHTML = minimapSVG(rep, cal, round, t);
  var feed = document.querySelector('.feed');
  if (feed) {
    feed.querySelectorAll('.fev').forEach(function (e) {
      e.classList.toggle('done', +e.dataset.t <= t);
    });
  }
  var seek = document.getElementById('pseek');
  if (seek) seek.value = t;
  var clock = document.querySelector('.rpctrl .clock');
  if (clock) {
    var s = Math.floor(t / 1000);
    clock.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  var fidx = document.querySelector('.rpctrl .fidx');
  if (fidx) {
    fidx.textContent = '장면 ' + (frameIndex(round, t) + 1) + '/' + frames(round).length;
  }
  var pb = document.getElementById('pplay');
  if (pb) pb.textContent = play.on ? '❚❚' : '▶';
}

/* ------------------------------------------------------------------ */
/* 라운드 탐색기                                                       */
/* ------------------------------------------------------------------ */

/** 해당 game_id 의 데이터만. (전체 맵으로 대체하지 않는다) */
function exactGame(list, gameId) {
  if (!list) return null;
  return list.filter(function (e) { return String(e.game_id) === String(gameId); })[0] || null;
}

/** 라운드 번호 -> 그 라운드에 기록된 킬 묶음
 *
 * 퍼포먼스 탭의 멀티킬·클러치 상세에서 온다. 즉 **모든 킬이 아니라
 * 멀티킬/클러치를 만든 킬만** 잡힌다. 화면에도 그렇게 안내한다.
 */
function roundKillIndex(perf, gameId) {
  var g = exactGame(perf, gameId);
  if (!g || !g.adv) return {};
  var cols = g.adv_columns || [];
  var by = {};
  g.adv.forEach(function (row) {
    (row.cells || []).forEach(function (c, ci) {
      if (!c || typeof c !== 'object' || !c.e) return;
      c.e.forEach(function (ev) {
        if (ev.round == null) return;
        (by[ev.round] = by[ev.round] || []).push({
          killer: row.name, team: row.team,
          kind: cols[ci] || '', victims: ev.victims || []
        });
      });
    });
  });
  return by;
}

/** 라운드 결과 한 줄 요약 (누가 · 어느 진영 · 어떻게) */
function roundOutcome(m, r) {
  var team = (m.teams[r.winner] || {}).name || '?';
  var side = r.side === 't' ? '<span class="h-t">공격</span>'
    : r.side === 'ct' ? '<span class="h-ct">수비</span>' : '';
  var mm = MAP_METHOD[r.method] || ['', r.method || '방식 미상'];
  return { team: team, side: side, method: mm[1], glyph: mm[0] };
}

/** 라운드별 점수차 흐름 그래프 (양수 = 왼쪽 팀 우세) */
function flowChartHTML(m, rounds, selIdx) {
  var pts = [0], maxAbs = 1;
  rounds.forEach(function (r) {
    var mm = /^(\d+)\s*-\s*(\d+)$/.exec(r.score || '');
    var d = mm ? (+mm[1] - +mm[2]) : pts[pts.length - 1];
    pts.push(d);
    if (Math.abs(d) > maxAbs) maxAbs = Math.abs(d);
  });

  var W = 1000, H = 150, PAD = 22;
  var innerH = H - PAD * 2;
  var stepX = W / Math.max(1, pts.length - 1);
  var y0 = PAD + innerH / 2;
  function xy(i) {
    return [i * stepX, y0 - (pts[i] / maxAbs) * (innerH / 2)];
  }

  var line = pts.map(function (_, i) {
    var p = xy(i);
    return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
  }).join(' ');
  var area = line + ' L' + W.toFixed(1) + ' ' + y0.toFixed(1) + ' L0 ' + y0.toFixed(1) + ' Z';

  // 전/후반 및 연장 경계
  var marks = '';
  [12, 24, 26, 28].forEach(function (n) {
    if (n >= pts.length) return;
    var x = (n * stepX).toFixed(1);
    marks += '<line class="fdiv" x1="' + x + '" y1="' + PAD + '" x2="' + x + '" y2="' + (H - PAD) + '"/>';
  });

  var sel = '';
  if (selIdx != null && selIdx + 1 < pts.length + 1) {
    var sp = xy(selIdx + 1);
    sel = '<line class="fsel" x1="' + sp[0].toFixed(1) + '" y1="' + PAD +
      '" x2="' + sp[0].toFixed(1) + '" y2="' + (H - PAD) + '"/>' +
      '<circle class="fdot" cx="' + sp[0].toFixed(1) + '" cy="' + sp[1].toFixed(1) + '" r="5"/>';
  }

  // 클릭용 투명 영역
  var hits = rounds.map(function (r, i) {
    return '<rect class="fhit" data-r="' + i + '" x="' + (i * stepX).toFixed(1) +
      '" y="0" width="' + stepX.toFixed(1) + '" height="' + H + '">' +
      '<title>Round ' + r.n + ' · ' + h(r.score || '') + '</title></rect>';
  }).join('');

  var lead = pts[pts.length - 1];
  var t0 = h(m.teams[0].name || ''), t1 = h(m.teams[1].name || '');

  return '<div class="card flowcard">' +
    '<div class="flowhead"><span class="up">▲ ' + t0 + '</span>' +
    '<span class="mid">라운드 점수차 흐름</span>' +
    '<span class="dn">▼ ' + t1 + '</span></div>' +
    '<svg class="flow" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
    '<line class="fzero" x1="0" y1="' + y0 + '" x2="' + W + '" y2="' + y0 + '"/>' +
    marks +
    '<path class="farea ' + (lead >= 0 ? 'up' : 'dn') + '" d="' + area + '"/>' +
    '<path class="fline" d="' + line + '"/>' + sel + hits +
    '</svg></div>';
}

function roundExplorerHTML(m) {
  if (detail.tab === 'all') {
    return '<div class="card"><div class="empty">' +
      '라운드는 맵별로만 볼 수 있습니다. 위에서 맵을 선택하세요.</div></div>';
  }
  var g = m.maps[detail.tab];
  var rounds = (g && g.rounds) || [];
  if (!rounds.length) {
    return '<div class="card"><div class="empty">이 맵은 라운드 데이터가 없습니다.</div></div>';
  }

  var idx = Math.min(Math.max(0, detail.round | 0), rounds.length - 1);
  var r = rounds[idx];
  var gid = g.game_id;
  var econ = exactGame(m.economy, gid);
  var kills = roundKillIndex(m.performance, gid);

  /* ---- 라운드 선택 띠 ---- */
  var strip = rounds.map(function (x, i) {
    var mm = MAP_METHOD[x.method] || ['', x.method || ''];
    var o = roundOutcome(m, x);
    var gap = (i === 12 || (i > 24 && (i - 24) % 2 === 0)) ? '<div class="gap"></div>' : '';
    return gap + '<button class="rpick' + (i === idx ? ' on' : '') + '" data-r="' + i + '"' +
      ' title="' + h(o.team + ' · ' + o.method) + '">' +
      '<span class="n">' + x.n + '</span>' +
      '<span class="sq ' + (x.side || '') + (x.winner === 1 ? ' bot' : '') + '">' + mm[0] + '</span>' +
      '</button>';
  }).join('');

  /* ---- 선택한 라운드 상세 ---- */
  var o = roundOutcome(m, r);
  var prev = idx > 0 ? rounds[idx - 1].score : '0-0';

  var head =
    '<div class="rhead">' +
    '<div class="rno">Round ' + r.n + '<span class="of"> / ' + rounds.length + '</span></div>' +
    '<div class="rwin">' +
    '<span class="w">' + h(o.team) + '</span> 라운드 승리 ' + o.side +
    '<span class="chip">' + o.glyph + ' ' + h(o.method) + '</span>' +
    '</div>' +
    '<div class="rsc">' + h(prev || '0-0') + ' → <b>' + h(r.score || '') + '</b></div>' +
    '</div>';

  /* ---- 이코노미 ---- */
  var money = '';
  var er = econ && (econ.rounds || []).filter(function (x) { return x.n === r.n; })[0];
  if (er) {
    money = '<div class="rsec"><div class="rsec-t">이코노미</div><div class="rmoney">' +
      [0, 1].map(function (i) {
        var buy = (er.buys || [])[i] || {};
        var cr = buy.credits ? (Math.round(+buy.credits / 100) / 10) + 'k' : '-';
        var tier = buy.label || '이코';
        return '<div class="rteam' + (er.winner === i ? ' win' : '') + '">' +
          '<div class="tn">' + img(m.teams[i].logo, '') + h(m.teams[i].name || '') + '</div>' +
          '<div class="buy">' + h(tier) + '</div>' +
          '<div class="cr">라운드 시작 ' + h(cr) + '</div>' +
          '<div class="bank">종료 후 ' + h((er.bank || [])[i] || '-') + '</div>' +
          '</div>';
      }).join('') + '</div></div>';
  }

  /* ---- 킬 ---- */
  var ev = kills[r.n] || [];
  var killHTML;
  if (ev.length) {
    killHTML = ev.map(function (k) {
      return '<div class="rkill">' +
        '<span class="who">' + h(k.killer) + '<span class="tag">' + h(k.team) + '</span></span>' +
        '<span class="kind">' + h(k.kind) + '</span>' +
        '<span class="arrow">→</span>' +
        '<span class="vics">' + k.victims.map(function (v) {
          return '<span class="pop-kill">' + agentHTML({ name: v.agent, img: v.img }) + h(v.name) + '</span>';
        }).join('') + '</span></div>';
    }).join('');
  } else {
    killHTML = '<div class="rnone">이 라운드에는 기록된 멀티킬·클러치가 없습니다.</div>';
  }
  var killSec = '<div class="rsec"><div class="rsec-t">킬 기록' +
    '<span class="chip">멀티킬 · 클러치만 (VLR 이 개별 킬 로그를 제공하지 않음)</span></div>' +
    '<div class="rkills">' + killHTML + '</div></div>';

  var nav = '<div class="rnav">' +
    '<button class="btn" data-rgo="' + (idx - 1) + '"' + (idx === 0 ? ' disabled' : '') + '>← 이전 라운드</button>' +
    '<button class="btn" data-rgo="' + (idx + 1) + '"' +
    (idx >= rounds.length - 1 ? ' disabled' : '') + '>다음 라운드 →</button>' +
    mapVodHTML(m.id, detail.tab) +
    '</div>';

  return flowChartHTML(m, rounds, idx) +
    '<div class="card" style="margin-top:14px"><div class="rstrip">' + strip + '</div></div>' +
    '<div class="card" style="margin-top:14px">' + head + money + killSec + nav + '</div>';
}

/** 선택한 맵의 game_id ('all' 이면 전체 맵) */
function currentGameId(m) {
  return detail.tab === 'all' ? 'all' : m.maps[detail.tab].game_id;
}

function mapHeadHTML(m) {
  if (detail.tab === 'all') return '';
  var g = m.maps[detail.tab];
  var hv0 = (g.halves || [])[0], hv1 = (g.halves || [])[1];
  return '<div class="maphead">' +
    '<div class="mt">' + img(m.teams[0].logo, '') + '<div><div>' + h(m.teams[0].name || '') + '</div>' +
    '<div class="halves">' + halvesHTML(hv0) + '</div></div>' +
    '<div class="msc" style="margin-left:14px">' + (g.scores[0] == null ? '-' : g.scores[0]) + '</div></div>' +
    '<div class="mid"><div class="mn">' + h(g.map || '') +
    (g.pick != null ? '<span class="chip">' + h((m.teams[g.pick] || {}).name || '') + ' 픽</span>' : '') +
    '</div><div class="md">' + h(g.duration || '') + '</div>' +
    mapVodHTML(m.id, detail.tab) + '</div>' +
    '<div class="mt r">' + img(m.teams[1].logo, '') + '<div style="text-align:right"><div>' + h(m.teams[1].name || '') + '</div>' +
    '<div class="halves">' + halvesHTML(hv1) + '</div></div>' +
    '<div class="msc" style="margin-right:14px">' + (g.scores[1] == null ? '-' : g.scores[1]) + '</div></div>' +
    '</div>' + roundsHTML(g);
}

function overviewHTML(m) {
  var players = detail.tab === 'all'
    ? (m.all_players && m.all_players.length ? m.all_players : (m.maps[0] || {}).players)
    : m.maps[detail.tab].players;
  var toggle = '<div class="sidetoggle">' +
    [['both', '전체'], ['t', '공격'], ['ct', '수비']].map(function (s) {
      return '<button data-s="' + s[0] + '"' + (detail.side === s[0] ? ' class="on"' : '') + '>' + s[1] + '</button>';
    }).join('') + '</div>';
  return '<div class="card">' + mapHeadHTML(m) + toggle + scoreboardHTML(players, detail.side) + '</div>';
}

function renderMatchBody(m) {
  var host = document.getElementById('mbody');
  var gid = currentGameId(m);

  // 데이터가 있는 탭만 보여준다
  var tabs = [['overview', '개요']];
  if (gid !== 'all' && ((m.maps[detail.tab] || {}).rounds || []).length) {
    tabs.push(['rounds', '라운드']);
  }
  if (gid !== 'all' && RCACHE[m.id + '-' + gid]) tabs.push(['replay', '리플레이']);
  if (perfGame(m.performance, gid)) tabs.push(['performance', '퍼포먼스']);
  if (gid !== 'all' && exactGame(m.economy, gid)) tabs.push(['economy', '이코노미']);
  if (!tabs.filter(function (t) { return t[0] === detail.view; })[0]) detail.view = 'overview';

  var nav = tabs.length > 1
    ? '<div class="viewnav">' + tabs.map(function (t) {
        return '<button data-v="' + t[0] + '"' + (detail.view === t[0] ? ' class="on"' : '') + '>' +
          h(t[1]) + '</button>';
      }).join('') + '</div>'
    : '';

  var body;
  if (detail.view === 'performance') {
    body = (detail.tab === 'all' ? '' : mapHeadWrap(m)) +
      performanceHTML(m.performance, gid, detail.matrix,
        detail.tab === 'all' ? null : (m.maps[detail.tab] || {}).map);
  } else if (detail.view === 'economy') {
    body = mapHeadWrap(m) + econHTML(m.economy, gid, m.teams);
  } else if (detail.view === 'rounds') {
    body = mapHeadWrap(m) + roundExplorerHTML(m);
  } else if (detail.view === 'replay') {
    body = mapHeadWrap(m) + replayHTML(m);
  } else {
    body = overviewHTML(m);
  }

  host.innerHTML = nav + body;

  host.querySelectorAll('.viewnav button').forEach(function (b) {
    b.onclick = function () {
      stopPlay();
      detail.view = b.dataset.v;
      if (detail.view === 'rounds' || detail.view === 'replay') {
        detail.round = detail.round || 0;
      }
      renderMatchBody(m);
    };
  });
  host.querySelectorAll('.rstrip .rpick, .flow .fhit').forEach(function (b) {
    b.onclick = function () {
      stopPlay(); play.t = 0;
      detail.round = +b.dataset.r; renderMatchBody(m);
    };
  });
  host.querySelectorAll('[data-rgo]').forEach(function (b) {
    b.onclick = function () {
      stopPlay(); play.t = 0;
      detail.round = +b.dataset.rgo; renderMatchBody(m);
    };
  });

  // 리플레이 재생 컨트롤
  var pb = document.getElementById('pplay');
  if (pb) {
    pb.onclick = function () {
      if (play.on) { stopPlay(); paintReplay(m); }
      else {
        var rep = RCACHE[replayKey(m)];
        var rd = rep && rep.rounds[Math.min(detail.round | 0, rep.rounds.length - 1)];
        if (rd && play.t >= (rd.duration || 1)) play.t = 0;
        startPlay(m);
      }
    };
  }
  var prevb = document.getElementById('pprev');
  if (prevb) prevb.onclick = function () { stopPlay(); stepFrame(m, -1); paintReplay(m); };
  var nextb = document.getElementById('pnext');
  if (nextb) nextb.onclick = function () { stopPlay(); stepFrame(m, 1); paintReplay(m); };
  var seek = document.getElementById('pseek');
  if (seek) {
    seek.oninput = function () { stopPlay(); play.t = +seek.value; paintReplay(m); };
  }
  host.querySelectorAll('[data-sp]').forEach(function (b) {
    b.onclick = function () {
      play.speed = +b.dataset.sp;
      host.querySelectorAll('[data-sp]').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
    };
  });
  host.querySelectorAll('.feed .fev').forEach(function (e) {
    e.onclick = function () { stopPlay(); play.t = +e.dataset.t; paintReplay(m); };
  });
  // 선택한 라운드가 띠 밖으로 나가 있으면 보이게 스크롤
  var sel = host.querySelector('.rstrip .rpick.on');
  if (sel && sel.scrollIntoView) {
    sel.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
  host.querySelectorAll('.sidetoggle button[data-s]').forEach(function (b) {
    b.onclick = function () { detail.side = b.dataset.s; renderMatchBody(m); };
  });
  host.querySelectorAll('.sidetoggle button[data-mx]').forEach(function (b) {
    b.onclick = function () { detail.matrix = b.dataset.mx; renderMatchBody(m); };
  });
}

/** 퍼포먼스·이코노미 탭에서도 맵 스코어를 보여주기 위한 래퍼 */
function mapHeadWrap(m) {
  var head = mapHeadHTML(m);
  return head ? '<div class="card" style="margin-bottom:14px">' + head + '</div>' : '';
}

/** 경기 영상: 맵별 VOD(해당 시점으로 점프) + 생중계 채널 */
function vodHTML(mid) {
  var row = VODS && VODS[String(mid)];
  if (!row) return '';
  var out = '';
  if (row.v && row.v.length) {
    out += '<div class="vodrow"><span class="lbl">다시보기</span>' +
      row.v.map(function (x) {
        return '<a class="btn vod" href="' + h(x[1]) + '" target="_blank" rel="noopener">▶ ' +
          h(x[0] || '영상') + '</a>';
      }).join('') + '</div>';
  }
  if (row.s && row.s.length) {
    out += '<div class="vodrow"><span class="lbl">중계</span>' +
      row.s.map(function (x) {
        return '<a class="btn" href="' + h(x[1]) + '" target="_blank" rel="noopener">' +
          h(x[0] || '채널') + ' ↗</a>';
      }).join('') + '</div>';
  }
  return out;
}

/** 지금 보고 있는 맵의 VOD 하나 (맵별 탭에서 강조) */
function mapVodHTML(mid, tab) {
  var row = VODS && VODS[String(mid)];
  if (!row || !row.v || tab === 'all') return '';
  var want = 'map ' + (tab + 1);
  var hit = row.v.filter(function (x) {
    return (x[0] || '').toLowerCase().indexOf(want) === 0;
  })[0] || (row.v.length === 1 ? row.v[0] : null);
  if (!hit) return '';
  return '<a class="btn vod" href="' + h(hit[1]) + '" target="_blank" rel="noopener">' +
    '▶ 이 맵 다시보기</a>';
}

/** 상세 스냅샷이 없는 경기: 결과 목록에서 얻은 요약만 보여준다 */
function renderSummaryOnly(row) {
  var d = parseTs(row[M_DATE]);
  var t0 = row[M_T1], t1 = row[M_T2];
  var s0 = t0[T_SCORE], s1 = t1[T_SCORE];
  var c0 = s0 != null && s1 != null ? (s0 > s1 ? 'w' : s0 < s1 ? 'l' : '') : '';
  var c1 = s0 != null && s1 != null ? (s1 > s0 ? 'w' : s1 < s0 ? 'l' : '') : '';
  function side(t, cls) {
    var logo = TEAM_LOGO[t[T_NAME]];
    return '<div class="side' + cls + '">' + (logo ? img(logo) : '') +
      '<div class="tn">' + h(t[T_NAME] || '?') + '</div></div>';
  }
  app.innerHTML =
    '<div style="margin-bottom:14px"><a href="#/matches" class="btn">← 경기 목록</a> ' +
    '<a href="https://www.vlr.gg/' + row[M_ID] + '/" target="_blank" rel="noopener" class="btn">VLR.gg 원본 ↗</a></div>' +
    '<div class="card"><div class="mhead">' +
    '<div class="evline">' + img(EV_LOGO[row[M_EVENT]]) +
    '<div><div><a href="#/matches?ev=' + encodeURIComponent(row[M_EVENT] || '') + '">' +
    h(row[M_EVENT] || '이벤트 미상') + '</a></div>' +
    '<div class="es">' + h(row[M_SERIES] || '') + '</div></div>' +
    '<div class="when">' + h(fmtDay(d)) + '<br>' + h(fmtTime(d)) + ' (현지 시간)</div></div>' +
    '<div class="vs">' + side(t0, '') +
    '<div><div class="note">결과</div><div class="score">' +
    '<span class="' + c0 + '">' + (s0 == null ? '-' : s0) + '</span><span class="sep">:</span>' +
    '<span class="' + c1 + '">' + (s1 == null ? '-' : s1) + '</span></div></div>' +
    side(t1, ' r') + '</div></div></div>' +
    '<div class="card" style="margin-top:14px"><div class="empty">' +
    (DB.meta.demo
      ? '공개 데모에는 최근 ' + DB.meta.demo.detail_included.toLocaleString() +
        '경기의 상세만 담겨 있습니다.<br>' +
        '<span class="tdim">전체 아카이브에는 ' +
        DB.meta.demo.detail_total.toLocaleString() + '경기의 상세가 있습니다.</span>'
      : '이 경기는 결과 목록 스냅샷에만 있습니다.<br>' +
        '스코어보드 · 라운드 · 이코노미 데이터는 수집되지 않았습니다.') +
    '</div></div>';
}

function viewMatch(match) {
  var id = match[1];
  var row = DB.byId[id];
  if (row && !row[M_DETAIL]) { renderSummaryOnly(row); return; }

  app.innerHTML = '<div class="spinner">경기 불러오는 중…</div>';
  var p = MCACHE[id] ? Promise.resolve(MCACHE[id]) : getJSON('data/matches/' + id + '.json');
  // 영상 링크 목록은 첫 경기 상세를 열 때 한 번만 받아 둔다
  var v = VODS ? Promise.resolve(VODS)
    : getJSON('data/vods.json').then(function (x) { VODS = x; }).catch(function () { VODS = {}; });
  // 미니맵 좌표 변환값 (fetch_assets.py --maps-only 로 받아둔 것)
  var c = MAPCAL ? Promise.resolve(MAPCAL)
    : getJSON('assets/maps/calibration.json')
        .then(function (x) { MAPCAL = x; }).catch(function () { MAPCAL = {}; });

  Promise.all([p, v, c]).then(function (r) {
    var m = r[0];
    MCACHE[id] = m;
    detail = { side: 'both', tab: 'all', view: 'overview', matrix: 'normal', round: 0 };
    var d = parseTs(m.date_utc);
    var t0 = m.teams[0], t1 = m.teams[1];
    var s0 = t0.score, s1 = t1.score;
    var c0 = s0 != null && s1 != null ? (s0 > s1 ? 'w' : s0 < s1 ? 'l' : '') : '';
    var c1 = s0 != null && s1 != null ? (s1 > s0 ? 'w' : s1 < s0 ? 'l' : '') : '';

    var tabs = '<button data-t="all" class="on">전체 맵</button>' + m.maps.map(function (g, i) {
      return '<button data-t="' + i + '">' + h(g.map || ('맵 ' + (i + 1))) +
        '<span class="mscore">' + (g.scores[0] == null ? '' : g.scores[0] + ':' + g.scores[1]) + '</span></button>';
    }).join('');

    app.innerHTML =
      '<div style="margin-bottom:14px"><a href="#/matches" class="btn">← 경기 목록</a> ' +
      '<a href="' + h(m.url) + '" target="_blank" rel="noopener" class="btn">VLR.gg 원본 ↗</a></div>' +
      '<div class="card"><div class="mhead">' +
      '<div class="evline">' + img(m.event.logo) +
      '<div><div><a href="#/matches?ev=' + encodeURIComponent(m.event.name || '') + '">' +
      h(m.event.name || '이벤트 미상') + '</a></div>' +
      '<div class="es">' + h(m.event.series || '') + '</div></div>' +
      '<div class="when">' + h(fmtDay(d)) + '<br>' + h(fmtTime(d)) + ' (현지 시간)</div></div>' +
      '<div class="vs">' +
      '<div class="side">' + img(t0.logo) + '<div class="tn">' + h(t0.name || '?') + '</div></div>' +
      '<div><div class="note">' + h(m.status || '') + '</div>' +
      '<div class="score"><span class="' + c0 + '">' + (s0 == null ? '-' : s0) + '</span>' +
      '<span class="sep">:</span><span class="' + c1 + '">' + (s1 == null ? '-' : s1) + '</span></div>' +
      '<div class="note">' + h(m.format || '') + '</div></div>' +
      '<div class="side r">' + img(t1.logo) + '<div class="tn">' + h(t1.name || '?') + '</div></div>' +
      '</div>' +
      (m.veto ? '<div class="veto">' + h(m.veto) + '</div>' : '') +
      vodHTML(m.id) +
      '</div><div class="maptabs">' + tabs + '</div></div>' +
      '<div id="mbody" style="margin-top:14px"></div>';

    // 각 맵에 리플레이 파일이 있는지 확인해 두면 탭 노출 여부가 정해진다
    Promise.all((m.maps || []).map(function (g) {
      var key = m.id + '-' + g.game_id;
      if (RCACHE[key] !== undefined) return null;
      return getJSON('data/replays/' + key + '.json')
        .then(function (x) { RCACHE[key] = x; })
        .catch(function () { RCACHE[key] = null; });
    })).then(function () { renderMatchBody(m); });

    app.querySelectorAll('.maptabs button').forEach(function (b) {
      b.onclick = function () {
        app.querySelectorAll('.maptabs button').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        stopPlay(); play.t = 0;
        detail.tab = b.dataset.t === 'all' ? 'all' : +b.dataset.t;
        detail.round = 0;   // 맵이 바뀌면 1라운드부터
        renderMatchBody(m);
      };
    });
    renderMatchBody(m);
  }).catch(function () {
    if (row) { renderSummaryOnly(row); return; }
    app.innerHTML = '<div class="card"><div class="empty">이 경기는 데이터에 없습니다.</div></div>';
  });
}

/* ------------------------------------------------------------------ */
/* 이벤트 / 팀                                                         */
/* ------------------------------------------------------------------ */

function tierLabel(key) {
  var t = (DB.meta.tiers || []).filter(function (x) { return x[0] === key; })[0];
  return t ? t[1] : key;
}
function regionLabel(key) {
  var r = (DB.meta.regions || []).filter(function (x) { return x[0] === key; })[0];
  return r ? r[1] : key;
}

/** 등급 필터 버튼 줄. counts 는 {등급: 개수} */
function tierBarHTML(counts, active) {
  var total = Object.keys(counts).reduce(function (n, k) { return n + counts[k]; }, 0);
  var out = '<button class="btn' + (active === '' ? ' on' : '') + '" data-tier="">전체 ' + total.toLocaleString() + '</button>';
  return out + (DB.meta.tiers || []).map(function (t) {
    if (!counts[t[0]]) return '';
    return '<button class="btn' + (active === t[0] ? ' on' : '') + '" data-tier="' + t[0] + '">' +
      h(t[1]) + ' ' + counts[t[0]].toLocaleString() + '</button>';
  }).join('');
}

var evState = { q: '', tier: '' };

function viewEvents() {
  app.innerHTML = '<h1>이벤트</h1>' +
    '<div class="sub">' + DB.events.length.toLocaleString() + '개 대회 · 연도별</div>' +
    '<div class="controls"><input type="search" id="q" placeholder="대회 이름 검색" value="' + h(evState.q) + '">' +
    '<span class="tierbar" id="tiers"></span></div>' +
    '<div id="glist"></div>';

  function render() {
    var q = evState.q.trim().toLowerCase();
    var hit = DB.events.filter(function (e) {
      return !q || (e.name || '').toLowerCase().indexOf(q) >= 0;
    });
    var counts = {};
    hit.forEach(function (e) { counts[e.tier] = (counts[e.tier] || 0) + 1; });
    document.getElementById('tiers').innerHTML = tierBarHTML(counts, evState.tier);
    document.querySelectorAll('#tiers [data-tier]').forEach(function (b) {
      b.onclick = function () { evState.tier = b.dataset.tier; render(); };
    });

    var list = evState.tier ? hit.filter(function (e) { return e.tier === evState.tier; }) : hit;

    // 연도별로 묶기 (대회가 걸친 마지막 연도 기준)
    var byYear = {};
    list.forEach(function (e) {
      var y = e.y1 || e.y0 || 0;
      (byYear[y] = byYear[y] || []).push(e);
    });
    var years = Object.keys(byYear).map(Number).sort(function (a, b) { return b - a; });

    var out = years.map(function (y) {
      var group = byYear[y].sort(function (a, b) {
        return (TIER_ORDER[a.tier] - TIER_ORDER[b.tier]) || (b.count - a.count);
      });
      return '<div class="yeargroup">' +
        '<div class="yearlabel">' + (y || '연도 미상') +
        '<span class="c">' + group.length + '개 대회 · ' +
        group.reduce(function (n, e) { return n + e.count; }, 0).toLocaleString() + '경기</span></div>' +
        '<div class="grid-cards">' + group.map(function (e) {
          return '<a class="ecard" href="#/matches?ev=' + encodeURIComponent(e.name) + '">' + img(e.logo) +
            '<div style="min-width:0"><div class="n">' + h(e.name || '이름 없음') + '</div>' +
            '<div class="c"><span class="tier ' + e.tier + '">' + h(tierLabel(e.tier)) + '</span>' +
            e.count + '경기' + (e.detail ? ' · 상세 ' + e.detail : '') +
            (e.y0 && e.y1 && e.y0 !== e.y1 ? ' · ' + e.y0 + '~' + e.y1 : '') +
            '</div></div></a>';
        }).join('') + '</div></div>';
    }).join('');

    document.getElementById('glist').innerHTML = out || '<div class="card"><div class="empty">결과 없음</div></div>';
  }

  document.getElementById('q').oninput = debounce(function (e) { evState.q = e.target.value; render(); }, 150);
  render();
}

var teamState = { q: '', tier: '', region: '', limit: 60 };

function viewTeams() {
  app.innerHTML = '<h1>팀</h1>' +
    '<div class="sub">' + DB.teams.length.toLocaleString() + '개 팀 · 권역별 · ' +
    '<b>1부</b>는 ' + (DB.meta.season || '최신') + ' 시즌 1부 리그에 출전한 팀만, ' +
    '이전에만 1부였던 팀은 <b>전 1부</b>로 뺐습니다</div>' +
    '<div class="controls"><input type="search" id="q" placeholder="팀 이름 검색" value="' + h(teamState.q) + '">' +
    '<span class="tierbar" id="tiers"></span></div>' +
    '<div id="regions"></div>' +
    '<div id="glist"></div>';

  function render() {
    var q = teamState.q.trim().toLowerCase();
    var hit = DB.teams.filter(function (t) {
      return !q || (t.name || '').toLowerCase().indexOf(q) >= 0;
    });
    var counts = {};
    hit.forEach(function (t) { counts[t.tier] = (counts[t.tier] || 0) + 1; });
    document.getElementById('tiers').innerHTML = tierBarHTML(counts, teamState.tier);
    document.querySelectorAll('#tiers [data-tier]').forEach(function (b) {
      b.onclick = function () {
        teamState.tier = b.dataset.tier;
        teamState.region = '';   // 등급을 바꾸면 권역 선택은 초기화
        teamState.limit = 60;
        render();
      };
    });

    var list = teamState.tier ? hit.filter(function (t) { return t.tier === teamState.tier; }) : hit;

    // 등급을 고른 뒤에 권역 하위 탭을 보여준다
    var rHost = document.getElementById('regions');
    if (!teamState.tier) {
      rHost.innerHTML = '';
      teamState.region = '';
    } else {
      var rCount = {};
      list.forEach(function (t) { rCount[t.region] = (rCount[t.region] || 0) + 1; });
      if (!rCount[teamState.region]) teamState.region = '';
      rHost.innerHTML = '<div class="subbar">' +
        '<span class="lbl">권역</span>' +
        '<button class="btn' + (teamState.region === '' ? ' on' : '') + '" data-rg="">' +
        '전체 ' + list.length.toLocaleString() + '</button>' +
        (DB.meta.regions || []).map(function (r) {
          if (!rCount[r[0]]) return '';
          return '<button class="btn' + (teamState.region === r[0] ? ' on' : '') +
            '" data-rg="' + r[0] + '">' + h(r[1]) + ' ' + rCount[r[0]] + '</button>';
        }).join('') + '</div>';
      rHost.querySelectorAll('[data-rg]').forEach(function (b) {
        b.onclick = function () { teamState.region = b.dataset.rg; teamState.limit = 60; render(); };
      });
    }
    if (teamState.region) {
      list = list.filter(function (t) { return t.region === teamState.region; });
    }

    var byRegion = {};
    list.forEach(function (t) { (byRegion[t.region] = byRegion[t.region] || []).push(t); });

    var order = (DB.meta.regions || []).map(function (r) { return r[0]; });
    var out = order.map(function (rg) {
      var group = byRegion[rg];
      if (!group || !group.length) return '';
      var shown = group.slice(0, teamState.limit);
      return '<div class="yeargroup"><div class="yearlabel">' + h(regionLabel(rg)) +
        '<span class="c">' + group.length.toLocaleString() + '개 팀' +
        (group.length > shown.length ? ' · 상위 ' + shown.length + '개 표시' : '') + '</span></div>' +
        '<div class="card scroll-x"><table class="tbl"><thead><tr>' +
        '<th class="l">팀</th><th class="l">등급</th><th>기간</th>' +
        '<th>경기</th><th>1부</th><th>승</th><th>패</th><th>승률</th>' +
        '</tr></thead><tbody>' +
        shown.map(function (t) {
          var wr = (t.wins + t.losses) ? Math.round(t.wins / (t.wins + t.losses) * 100) : 0;
          var yr = t.years ? (t.years[0] === t.years[1] ? t.years[0] : t.years[0] + '–' + t.years[1]) : '-';
          return '<tr data-team="' + h(t.name) + '">' +
            '<td class="l"><div class="pname">' + img(t.logo, '') + '<span>' + h(t.name) + '</span></div></td>' +
            '<td class="l"><span class="tier ' + t.tier + '">' + h(tierLabel(t.tier)) + '</span>' +
            (t.tier === 't1x' && t.t1_last ? '<span class="tdim">~' + t.t1_last + '</span>' : '') +
            '</td>' +
            '<td class="tdim">' + yr + '</td>' +
            '<td>' + t.matches + '</td>' +
            '<td>' + (t.t1 ? t.t1 : '<span class="zero">-</span>') + '</td>' +
            '<td>' + t.wins + '</td><td>' + t.losses + '</td><td>' + wr + '%</td></tr>';
        }).join('') + '</tbody></table></div></div>';
    }).join('');

    document.getElementById('glist').innerHTML =
      (out || '<div class="card"><div class="empty">결과 없음</div></div>') +
      (list.length > teamState.limit
        ? '<div class="pager"><button class="btn" id="more">더 보기 (+60)</button></div>' : '');

    document.querySelectorAll('#glist tr[data-team]').forEach(function (tr) {
      tr.style.cursor = 'pointer';
      tr.onclick = function () { location.hash = '#/matches?team=' + encodeURIComponent(tr.dataset.team); };
    });
    var more = document.getElementById('more');
    if (more) more.onclick = function () { teamState.limit += 60; render(); };
  }

  document.getElementById('q').oninput = debounce(function (e) {
    teamState.q = e.target.value; teamState.limit = 60; render();
  }, 150);
  render();
}

/* ------------------------------------------------------------------ */
/* 선수                                                                */
/* ------------------------------------------------------------------ */

var pState = { q: '', sort: 'acs', dir: -1, min: 10, region: '', act: '' };

/** '2026-07-30' -> '2026.07' */
function ym(s) { return s ? s.slice(0, 7).replace('-', '.') : '-'; }

var P_COLS = [
  ['matches', '경기', 0],
  ['maps', '맵', 0],
  ['rating', 'R', 2],
  ['acs', 'ACS', 0],
  ['kd', 'K/D', 2],
  ['k', 'K', 0],
  ['d', 'D', 0],
  ['a', 'A', 0],
  ['adr', 'ADR', 0],
  ['kast', 'KAST%', 0],
  ['hs', 'HS%', 0],
  ['fk', 'FK', 0],
  ['fd', 'FD', 0]
];

function renderPlayers() {
  var q = pState.q.trim().toLowerCase();
  var hit = PLAYERS.filter(function (p) {
    if (p.matches < pState.min) return false;
    if (!q) return true;
    return (p.name || '').toLowerCase().indexOf(q) >= 0 ||
      (p.teams || []).join(' ').toLowerCase().indexOf(q) >= 0;
  });

  // 활동 여부 탭 (마지막 경기 기준)
  var aCount = { 1: 0, 0: 0 };
  hit.forEach(function (p) { aCount[p.active] += 1; });
  var cut = DB.meta.active_cutoff;
  document.getElementById('pactive').innerHTML = '<div class="subbar">' +
    '<span class="lbl">활동</span>' +
    '<button class="btn' + (pState.act === '' ? ' on' : '') + '" data-act="">' +
    '전체 ' + hit.length.toLocaleString() + '</button>' +
    '<button class="btn' + (pState.act === '1' ? ' on' : '') + '" data-act="1"' +
    ' title="' + h(cut || '') + ' 이후에 경기가 있는 선수">활동 ' + aCount[1].toLocaleString() + '</button>' +
    '<button class="btn' + (pState.act === '0' ? ' on' : '') + '" data-act="0"' +
    ' title="마지막 경기가 ' + h(cut || '') + ' 이전인 선수">비활동 ' + aCount[0].toLocaleString() + '</button>' +
    '</div>';
  document.querySelectorAll('#pactive [data-act]').forEach(function (b) {
    b.onclick = function () { pState.act = b.dataset.act; renderPlayers(); };
  });
  if (pState.act !== '') {
    hit = hit.filter(function (p) { return String(p.active) === pState.act; });
  }

  // 권역 탭 (현재 검색·최소경기·활동 조건 안에서의 개수)
  var rCount = {};
  hit.forEach(function (p) { rCount[p.region] = (rCount[p.region] || 0) + 1; });
  if (pState.region && !rCount[pState.region]) pState.region = '';
  document.getElementById('pregions').innerHTML = '<div class="subbar">' +
    '<span class="lbl">권역</span>' +
    '<button class="btn' + (pState.region === '' ? ' on' : '') + '" data-rg="">' +
    '전체 ' + hit.length.toLocaleString() + '</button>' +
    (DB.meta.regions || []).map(function (r) {
      if (!rCount[r[0]]) return '';
      return '<button class="btn' + (pState.region === r[0] ? ' on' : '') +
        '" data-rg="' + r[0] + '">' + h(r[1]) + ' ' + rCount[r[0]].toLocaleString() + '</button>';
    }).join('') + '</div>';
  document.querySelectorAll('#pregions [data-rg]').forEach(function (b) {
    b.onclick = function () { pState.region = b.dataset.rg; renderPlayers(); };
  });

  var list = pState.region
    ? hit.filter(function (p) { return p.region === pState.region; })
    : hit;

  var k = pState.sort, dir = pState.dir;
  list.sort(function (a, b) {
    var x = a[k], y = b[k];
    if (x == null) return 1;
    if (y == null) return -1;
    if (x === y) return (b.k - a.k) || (b.matches - a.matches);
    return (x < y ? -1 : 1) * dir;
  });
  list = list.slice(0, 300);

  var head = '<tr><th class="l">선수</th><th class="l">권역</th><th class="l">팀</th>' +
    '<th class="l" title="첫 경기 ~ 마지막 경기">활동 기간</th><th class="l">주 요원</th>' +
    P_COLS.map(function (c) {
      return '<th class="sortable' + (pState.sort === c[0] ? ' sorted' : '') + '" data-k="' + c[0] + '">' +
        h(c[1]) + (pState.sort === c[0] ? (pState.dir < 0 ? ' ▼' : ' ▲') : '') + '</th>';
    }).join('') + '</tr>';

  var body = list.map(function (p) {
    var top = (p.agents || []).slice(0, 3).map(function (a) {
      return agentHTML({ name: a[0], img: 'https://www.vlr.gg/img/vlr/game/agents/' +
        String(a[0]).toLowerCase() + '.png' }) +
        '<span class="agent-n">' + a[1] + '</span>';
    }).join('');
    return '<tr><td class="l"><a class="pname plink" href="#/player/' + p.id + '">' +
      flag(p.country) + '<span>' + h(p.name) + '</span></a></td>' +
      '<td class="l tdim nowrap">' + h(regionLabel(p.region)) + '</td>' +
      '<td class="l tdim">' + h((p.teams || []).slice(0, 3).join(', ')) + '</td>' +
      '<td class="l tdim nowrap">' + ym(p.first) + ' ~ ' + ym(p.last) +
      (p.active ? '' : '<span class="tier idle">비활동</span>') + '</td>' +
      '<td class="l"><div class="agents nowrap">' + top + '</div></td>' +
      P_COLS.map(function (c) {
        var v = p[c[0]];
        if (v == null) return '<td><span class="zero">-</span></td>';
        return '<td>' + (c[2] ? v.toFixed(c[2]) : Math.round(v).toLocaleString()) + '</td>';
      }).join('') + '</tr>';
  }).join('');

  document.getElementById('plist').innerHTML =
    '<table class="tbl"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>' +
    (list.length ? '' : '<div class="empty">결과 없음</div>');

  document.querySelectorAll('#plist th.sortable').forEach(function (th) {
    th.onclick = function () {
      if (pState.sort === th.dataset.k) pState.dir *= -1;
      else { pState.sort = th.dataset.k; pState.dir = -1; }
      renderPlayers();
    };
  });
}

function viewPlayers() {
  if (!PLAYERS) {
    app.innerHTML = '<div class="spinner">선수 데이터 불러오는 중…</div>';
    needPlayers().then(viewPlayers).catch(function () {
      app.innerHTML = '<div class="card"><div class="empty">선수 데이터를 불러오지 못했습니다.</div></div>';
    });
    return;
  }
  app.innerHTML = '<h1>선수</h1>' +
    '<div class="sub">All Maps 스코어보드 기준 누적 · 정렬 조건 상위 300명 표시 · ' +
    'Rating 2.0 / KAST 는 최신 대회에만 기록됨 · ' +
    '권역은 출전 대회(1부 우선)로 정하고, 판별이 안 되면 국적으로 추정합니다 · ' +
    '마지막 경기가 ' + h(DB.meta.active_cutoff || '') + ' 이전이면 <b>비활동</b>으로 분류합니다</div>' +
    '<div class="controls">' +
    '<input type="search" id="q" placeholder="선수 · 팀 태그 검색" value="' + h(pState.q) + '">' +
    '<select id="min">' + [1, 5, 10, 20, 50].map(function (n) {
      return '<option value="' + n + '"' + (pState.min === n ? ' selected' : '') + '>최소 ' + n + '경기</option>';
    }).join('') + '</select></div>' +
    '<div id="pactive"></div>' +
    '<div id="pregions"></div>' +
    '<div class="card scroll-x" id="plist"></div>';
  document.getElementById('q').oninput = debounce(function (e) { pState.q = e.target.value; renderPlayers(); }, 180);
  document.getElementById('min').onchange = function (e) { pState.min = +e.target.value; renderPlayers(); };
  renderPlayers();
}

/* ------------------------------------------------------------------ */
/* 선수 상세                                                           */
/* ------------------------------------------------------------------ */

var PCACHE = {};
var PLAYERS_REQ = null;

/** players.json 을 처음 필요할 때 한 번만 받는다. renderPlayers 는 널 가드가 없으므로
    반드시 이 게이트 뒤에서만 부를 것. */
function needPlayers() {
  if (PLAYERS) return Promise.resolve(PLAYERS);
  if (!PLAYERS_REQ) {
    PLAYERS_REQ = getJSON('data/players.json').then(function (x) { PLAYERS = x; return x; });
  }
  return PLAYERS_REQ;
}

/** 선수 상세의 경기 기록 표 컬럼 */
var PM_COLS = [
  [PM_RATING, 'R', 2],
  [PM_ACS, 'ACS', 0],
  [PM_K, 'K', 0],
  [PM_D, 'D', 0],
  [PM_A, 'A', 0],
  [PM_ADR, 'ADR', 0],
  [PM_KAST, 'KAST%', 0],
  [PM_HS, 'HS%', 0],
  [PM_FK, 'FK', 0],
  [PM_FD, 'FD', 0]
];

function statCard(label, value, sub) {
  return '<div class="stat"><div class="v">' + value + '</div>' +
    '<div class="k">' + h(label) + '</div>' +
    (sub ? '<div class="s">' + h(sub) + '</div>' : '') + '</div>';
}

function viewPlayer(match) {
  var pid = +match[1];
  app.innerHTML = '<div class="spinner">선수 기록 불러오는 중…</div>';
  // PLAYERS 가 아직 없으면 이름·국적·커리어 통계가 통째로 빈 화면이 된다.
  if (!PLAYERS) {
    needPlayers().then(function () { viewPlayer(match); }).catch(function () { viewPlayer(match); });
    return;
  }
  var p = (PLAYERS || []).filter(function (x) { return x.id === pid; })[0];

  var got = PCACHE[pid] ? Promise.resolve(PCACHE[pid]) : getJSON('data/players/' + pid + '.json');
  got.then(function (data) {
    PCACHE[pid] = data;
    renderPlayer(pid, p, data.matches || []);
  }).catch(function () {
    // 상세를 못 받아도 이름·국적·Rating·ACS 는 이미 PLAYERS 에 있다.
    // 화면을 지워 버리면 가진 정보까지 같이 버리는 셈이다.
    renderPlayer(pid, p, []);
  });
}

function renderPlayer(pid, p, rows) {
  var name = p ? p.name : '선수 #' + pid;
  // 공개 배포에는 최근 N경기의 상세만 담기므로 rows 는 커리어의 일부다.
  // 카드의 경기수·승패는 players.json 의 커리어 값을 쓰고(목록과 같은 숫자),
  // 표 제목만 실제로 담긴 행 수를 말한다.
  var wins, losses, total;
  if (p && p.wins != null) {
    wins = p.wins; losses = p.losses;
    total = (p.matches != null) ? p.matches : rows.length;
  } else {
    wins = 0; losses = 0;
    rows.forEach(function (r) {
      if (r[PM_WON] === 1) wins++;
      else if (r[PM_WON] === 0) losses++;
    });
    total = rows.length;
  }
  var wr = (wins + losses) ? Math.round(wins / (wins + losses) * 100) : null;

  var head =
    '<div style="margin-bottom:14px"><a href="#/players" class="btn">← 선수 목록</a> ' +
    '<a href="https://www.vlr.gg/player/' + pid + '/" target="_blank" rel="noopener" class="btn">VLR.gg 원본 ↗</a></div>' +
    '<div class="card"><div class="mhead">' +
    '<div class="vs" style="grid-template-columns:1fr">' +
    '<div class="side"><div>' +
    '<div class="tn">' + flag(p && p.country) + ' ' + h(name) + '</div>' +
    '<div class="es" style="color:var(--fg-faint);font-size:14px;margin-top:6px">' +
    (p ? h(regionLabel(p.region)) + ' · ' + h((p.teams || []).join(', ')) : '') +
    (p && p.first ? ' · ' + ym(p.first) + ' ~ ' + ym(p.last) : '') +
    (p && !p.active ? '<span class="tier idle">비활동</span>' : '') +
    '</div></div></div></div></div></div>';

  var cards = '<div class="statgrid" style="margin-top:18px">' +
    statCard('경기', total.toLocaleString()) +
    statCard('승 · 패', wins + ' · ' + losses, wr == null ? '' : wr + '%') +
    (p && p.rating != null ? statCard('Rating 2.0', p.rating.toFixed(2), p.rating_n + '경기 기준') : '') +
    (p && p.acs != null ? statCard('ACS', Math.round(p.acs)) : '') +
    (p && p.kd != null ? statCard('K/D', p.kd.toFixed(2), p.k + ' / ' + p.d) : '') +
    (p && p.adr != null ? statCard('ADR', Math.round(p.adr)) : '') +
    '</div>';

  var agents = (p && p.agents && p.agents.length)
    ? '<h2>많이 쓴 요원</h2><div class="card" style="padding:16px 18px">' +
      '<div class="agents">' + p.agents.map(function (a) {
        return agentHTML({ name: a[0], img: 'https://www.vlr.gg/img/vlr/game/agents/' +
          String(a[0]).toLowerCase() + '.png' }) + '<span class="agent-n">' + a[1] + '</span>';
      }).join('') + '</div></div>'
    : '';

  var partial = DB.meta.demo && rows.length < total;
  var tbl = '<h2>경기 기록 <span class="chip">' +
    (partial ? '표시된 ' : '') + rows.length.toLocaleString() + '경기</span></h2>';
  if (partial) {
    tbl += '<div class="sub">공개본에는 최근 ' +
      DB.meta.demo.detail_included.toLocaleString() + '경기의 상세만 담겨 있어 ' +
      '개별 경기 기록은 일부만 나옵니다 (전체 ' +
      DB.meta.demo.detail_total.toLocaleString() + '경기). 위 통계는 커리어 전체 기준입니다.</div>';
  }
  if (!rows.length) {
    tbl += '<div class="card"><div class="empty">' +
      (DB.meta.demo ? '이 선수의 경기는 공개본에 담긴 최근 ' +
        DB.meta.demo.detail_included.toLocaleString() + '경기 밖에 있습니다.'
        : '스코어보드가 있는 경기가 없습니다.') + '</div></div>';
  } else {
    var th = '<tr><th class="l">날짜</th><th class="l">대회</th><th class="l">팀</th>' +
      '<th class="l">상대</th><th>결과</th><th class="l">요원</th>' +
      PM_COLS.map(function (c) { return '<th>' + h(c[1]) + '</th>'; }).join('') + '</tr>';
    var body = rows.map(function (r) {
      var d = parseTs(r[PM_DATE]);
      var res = r[PM_WON] === 1 ? '<span class="pos">승</span>'
        : r[PM_WON] === 0 ? '<span class="neg">패</span>' : '<span class="zero">-</span>';
      var sc = (r[PM_SCORE] == null ? '-' : r[PM_SCORE]) + ':' + (r[PM_OPPSCORE] == null ? '-' : r[PM_OPPSCORE]);
      var ag = (r[PM_AGENTS] || []).map(function (n) {
        return agentHTML({ name: n, img: 'https://www.vlr.gg/img/vlr/game/agents/' +
          String(n).toLowerCase() + '.png' });
      }).join('');
      return '<tr data-mid="' + r[PM_ID] + '">' +
        '<td class="l tdim nowrap">' + (d ? d.getFullYear() + '.' +
          String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getDate()).padStart(2, '0') : '-') + '</td>' +
        '<td class="l"><div class="ev2"><div class="en">' + h(r[PM_EVENT] || '-') + '</div>' +
        '<div class="es">' + h(r[PM_SERIES] || '') + '</div></div></td>' +
        '<td class="l tdim">' + h(r[PM_TEAM] || '-') + '</td>' +
        '<td class="l">' + h(r[PM_OPP] || '-') + '</td>' +
        '<td class="nowrap">' + res + ' <span class="tdim">' + sc + '</span></td>' +
        '<td class="l"><div class="agents nowrap">' + ag + '</div></td>' +
        PM_COLS.map(function (c) {
          var v = r[c[0]];
          if (v == null) return '<td><span class="zero">-</span></td>';
          return '<td>' + (c[2] ? (+v).toFixed(c[2]) : Math.round(v).toLocaleString()) + '</td>';
        }).join('') + '</tr>';
    }).join('');
    tbl += '<div class="card scroll-x"><table class="tbl"><thead>' + th +
      '</thead><tbody>' + body + '</tbody></table></div>';
  }

  app.innerHTML = head + cards + agents + tbl;
  app.querySelectorAll('tr[data-mid]').forEach(function (tr) {
    tr.style.cursor = 'pointer';
    tr.onclick = function () { location.hash = '#/match/' + tr.dataset.mid; };
  });
}

/* ------------------------------------------------------------------ */
/* 통계                                                                */
/* ------------------------------------------------------------------ */

var STATS = null;

/** 승률에 따른 배경색 (낮으면 파랑, 높으면 빨강) */
function wrColor(p) {
  if (p == null) return 'transparent';
  var t = Math.max(0, Math.min(1, (p - 0.5) * 2.2 + 0.5));
  return t >= 0.5
    ? 'rgba(255, 70, 85, ' + ((t - 0.5) * 1.5).toFixed(3) + ')'
    : 'rgba(75, 159, 213, ' + ((0.5 - t) * 1.5).toFixed(3) + ')';
}

function pct(n, w) {
  return n ? (100 * w / n) : null;
}

function econStatsHTML(e) {
  var tiers = e.tiers || [];
  var head = '<tr><th class="l">우리 구매</th>' +
    tiers.map(function (t) {
      return '<th>vs ' + h(t[1].replace(/^\$+\s*/, '')) + '</th>';
    }).join('') + '<th>전체</th></tr>';

  var body = tiers.map(function (t, i) {
    var cells = tiers.map(function (_, j) {
      var c = e.matrix[i][j];
      var p = pct(c[0], c[1]);
      if (!c[0]) return '<td><span class="zero">-</span></td>';
      return '<td style="background:' + wrColor(p / 100) + '">' +
        '<b>' + p.toFixed(1) + '%</b>' +
        '<div class="n">' + c[0].toLocaleString() + '</div></td>';
    }).join('');
    var o = e.overall[i];
    var op = pct(o[0], o[1]);
    return '<tr><td class="l"><span class="etier">' + h(t[1]) + '</span>' +
      '<div class="n">' + h(t[2]) + '</div></td>' + cells +
      '<td class="tot"><b>' + (op == null ? '-' : op.toFixed(1) + '%') + '</b>' +
      '<div class="n">' + o[0].toLocaleString() + '</div></td></tr>';
  }).join('');

  return '<h2>이코노미 구간별 승률</h2>' +
    '<div class="sub">' + (e.rounds || 0).toLocaleString() + '라운드 기준 · ' +
    '행이 우리 팀 구매 등급, 열이 상대 팀 구매 등급입니다. ' +
    '같은 등급끼리는 정의상 50%입니다.</div>' +
    '<div class="card scroll-x"><table class="tbl econmx"><thead>' + head +
    '</thead><tbody>' + body + '</tbody></table></div>';
}

function viewStats() {
  app.innerHTML = '<h1>통계</h1><div class="spinner">불러오는 중…</div>';
  var got = STATS ? Promise.resolve(STATS) : getJSON('data/stats.json');
  got.then(function (s) {
    STATS = s;
    app.innerHTML = '<h1>통계</h1>' +
      '<div class="sub">상세 스탯이 있는 경기 전체를 누적한 값입니다.</div>' +
      (s.econ ? econStatsHTML(s.econ) : '<div class="card"><div class="empty">통계가 없습니다.</div></div>');
  }).catch(function () {
    app.innerHTML = '<h1>통계</h1><div class="card"><div class="empty">' +
      'stats.json 이 없습니다. <code>python build_data.py</code> 를 먼저 실행하세요.</div></div>';
  });
}

/* ------------------------------------------------------------------ */
/* 데이터 안내                                                         */
/* ------------------------------------------------------------------ */

/* ---- 서버 제어 (로컬 실행일 때만) ---------------------------------- */

var LIVE = { on: false, timer: null, logFrom: 0 };

function liveStop() {
  if (LIVE.timer) { clearInterval(LIVE.timer); LIVE.timer = null; }
}

/** 서버가 붙어 있으면 상태 카드를 채우고, 아니면 조용히 사라진다. */
function liveInit() {
  var box = document.getElementById('livebox');
  if (!box) return;
  fetch('_api/status')
    .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
    .then(function (s) { LIVE.on = true; liveRender(s); liveWire(); })
    .catch(function () { box.remove(); });
}

function liveRender(s) {
  var box = document.getElementById('livebox');
  if (!box) return;
  var b = s.build, d = s.data;
  var built = d.meta && d.meta.built_at ? d.meta.built_at : '-';
  var running = b.running;

  var rawLine = d.raw_ok
    ? '<span class="ok">연결됨</span> <code>' + h(d.raw || '') + '</code>'
    : '<span class="bad">찾을 수 없음</span> <code>' + h(d.raw || '-') + '</code>';

  box.innerHTML =
    '<div class="livehead"><b>서버에 연결됨</b>' +
    '<span class="tdim">서버를 끄지 않고 여기서 갱신할 수 있습니다.</span></div>' +
    '<div class="liverows">' +
    '<div><span class="k">원본</span>' + rawLine + '</div>' +
    '<div><span class="k">마지막 빌드</span>' + h(built) + '</div>' +
    '<div><span class="k">파일</span>경기 상세 ' + (d.match_files || 0).toLocaleString() +
    '개 · 리플레이 ' + (d.replays || 0).toLocaleString() + '개</div>' +
    '</div>' +
    '<div class="liveact">' +
    '<button id="livebuild"' + (running || !d.raw_ok ? ' disabled' : '') + '>' +
    (running ? '갱신하는 중…' : '지금 갱신') + '</button>' +
    (running ? '' : '<button id="livereload" class="ghost">화면 새로고침</button>') +
    '<span class="tdim" id="livemsg">' +
    (running ? '' : (d.raw_ok ? '스냅샷이 바뀐 경기만 다시 파싱합니다.'
                              : '원본 폴더에 연결되지 않아 갱신할 수 없습니다.')) +
    '</span></div>' +
    '<pre id="livelog" class="livelog"' + (running ? '' : ' hidden') + '></pre>';
  liveWire();
}

function liveWire() {
  var b = document.getElementById('livebuild');
  if (b) b.onclick = liveBuild;
  var r = document.getElementById('livereload');
  if (r) r.onclick = function () { location.reload(); };
}

function liveBuild() {
  var btn = document.getElementById('livebuild');
  var log = document.getElementById('livelog');
  var msg = document.getElementById('livemsg');
  if (btn) { btn.disabled = true; btn.textContent = '갱신하는 중…'; }
  if (log) { log.hidden = false; log.textContent = ''; }
  LIVE.logFrom = 0;
  fetch('_api/build', { method: 'POST' })
    .then(function (r) { return r.json(); })
    .then(function (x) {
      if (msg) msg.textContent = x.message || '';
      liveStop();
      LIVE.timer = setInterval(livePoll, 1000);
    })
    .catch(function () { if (msg) msg.textContent = '서버에 연결하지 못했습니다.'; });
}

function livePoll() {
  fetch('_api/log?from=' + LIVE.logFrom)
    .then(function (r) { return r.json(); })
    .then(function (x) {
      var log = document.getElementById('livelog');
      if (!log) { liveStop(); return; }
      LIVE.logFrom = x.next;
      if (x.lines.length) {
        log.textContent += x.lines.join('\n') + '\n';
        log.scrollTop = log.scrollHeight;
      }
      if (!x.build.running) {
        liveStop();
        var ok = x.build.code === 0;
        var msg = document.getElementById('livemsg');
        var btn = document.getElementById('livebuild');
        if (btn) { btn.disabled = false; btn.textContent = '지금 갱신'; }
        if (msg) {
          msg.innerHTML = ok
            ? '<span class="ok">갱신 완료</span> — 새로고침하면 반영됩니다. ' +
              '<a href="#" id="liveafter">지금 새로고침</a>'
            : '<span class="bad">빌드 실패</span> — 위 로그를 확인하세요.';
          var a = document.getElementById('liveafter');
          if (a) a.onclick = function (e) { e.preventDefault(); location.reload(); };
        }
      }
    })
    .catch(function () { liveStop(); });
}

function viewAbout() {
  liveStop();
  var m = DB.meta;
  var from = parseTs(m.range[0]), to = parseTs(m.range[1]);
  app.innerHTML = '<h1>데이터</h1>' +
    '<div class="card livebox" id="livebox"><div class="tdim">서버 상태 확인 중…</div></div>' +
    '<div class="sub">raw/ 폴더의 VLR.gg HTML 스냅샷을 파싱해 만든 정적 아카이브입니다.</div>' +
    '<div class="statgrid">' +
    [['경기', m.matches], ['상세 스탯', m.detail], ['이벤트', m.events],
     ['팀', m.teams], ['선수', m.players]].map(function (s) {
      return '<div class="stat"><div class="v">' + s[1].toLocaleString() + '</div><div class="k">' + s[0] + '</div></div>';
    }).join('') + '</div>' +
    (m.demo ? '<div class="samplewarn">' + h(m.demo.note) +
      ' 전체 아카이브에는 상세 ' + m.demo.detail_total.toLocaleString() +
      '경기가 있습니다.</div>' : '') +
    '<h2>두 종류의 경기</h2><div class="card" style="padding:16px 18px;line-height:1.9">' +
    '<div><b>상세</b> · ' + m.detail.toLocaleString() + '경기 — 경기 페이지 스냅샷이 있어 ' +
    '스코어보드 · 라운드 타임라인 · 밴픽까지 볼 수 있습니다.</div>' +
    '<div><b>요약</b> · ' + (m.matches - m.detail).toLocaleString() + '경기 — 결과 목록 페이지에만 있어 ' +
    '날짜 · 팀 · 점수 · 대회명만 있습니다.</div>' +
    '<div style="color:var(--fg-faint)">경기 목록의 <b>상세만</b> 버튼으로 앞쪽만 걸러 볼 수 있습니다.</div>' +
    '</div>' +
    '<h2>등급 · 권역 분류</h2><div class="card" style="padding:16px 18px;line-height:1.9">' +
    '<div><span class="tier t1">1부</span> 그 시기의 공식 최상위 대회. ' +
    '2023년부터는 인터내셔널 리그(Americas · EMEA · Pacific · China)와 Kickoff · Stage 1/2, ' +
    'Masters · Champions · LOCK//IN · LCQ. 2022년까지는 Champions Tour 의 Masters 와 Champions.</div>' +
    '<div><span class="tier t1x">전 1부</span> 예전에는 1부였지만 ' +
    (m.season || '최신') + ' 시즌 1부 리그에는 출전하지 않은 팀. ' +
    '1부 목록을 현재 소속 팀만으로 유지하려고 따로 뺐습니다.</div>' +
    '<div><span class="tier t2">2부</span> Challengers · Ascension · VRL · Premier</div>' +
    '<div><span class="tier gc">게임 체인저스</span> 여성부 서킷</div>' +
    '<div><span class="tier etc">기타</span> 인비테이셔널 · 컵 · 커뮤니티 대회</div>' +
    '<div style="color:var(--fg-faint);margin-top:6px">' +
    '팀 권역은 <b>1부 출전 권역</b>을 먼저 봅니다. 소속 리그가 팀의 권역을 정하기 때문입니다 ' +
    '(예: Gen.G 는 2020~21년 NA 경기가 더 많지만 퍼시픽으로 분류). ' +
    '1부 기록이 없으면 전체 이벤트 최빈값, 그것도 없으면 선수 국적으로 추정합니다.</div>' +
    '</div>' +
    '<h2>수집 범위</h2><div class="card" style="padding:16px 18px;line-height:1.9">' +
    '<div>기간 · ' + h(fmtDay(from)) + ' ~ ' + h(fmtDay(to)) + '</div>' +
    '<div>원본 · VLR.gg 경기 페이지(Overview / Economy / Performance 탭) 및 결과 목록 페이지</div>' +
    (m.built_at ? '<div>마지막 빌드 · ' + h(m.built_at) + '</div>' : '') +
    '<div>갱신 · <code>python build_data.py</code> — 스냅샷이 바뀐 경기만 다시 파싱합니다</div>' +
    '</div>' +
    '<h2>주의</h2><div class="card" style="padding:16px 18px;line-height:1.9;color:var(--fg-dim)">' +
    '<div>· Rating 2.0, KAST, ADR, HS% 는 VLR 이 집계한 대회에서만 제공됩니다. 오래된 경기는 K/D/A 와 ACS 만 있습니다.</div>' +
    '<div>· 이코노미 · 킬 매트릭스는 스냅샷이 존재하는 일부 경기에만 표시됩니다.</div>' +
    '<div>· 시리즈 점수는 맵 승수로 재계산했고, 맵 데이터가 없으면 페이지에 표기된 점수를 그대로 씁니다.</div>' +
    '<div>· VLR 의 <code>data-utc-ts</code> 는 이름과 달리 미국 동부시간이라 UTC 로 변환했습니다. ' +
    '결과 목록 시각은 상세 경기와 겹치는 것들로 매 빌드마다 타임존을 실측 보정합니다' +
    (m.list_tz_offset != null ? ' (이번 빌드: UTC' + (m.list_tz_offset >= 0 ? '+' : '') + m.list_tz_offset + ')' : '') +
    '. 화면의 시각은 브라우저 현지 시간으로 표시됩니다.</div>' +
    '<div>· 이벤트와 팀은 이름 기준으로 묶습니다. 목록 페이지에는 ID 가 없어, ' +
    '같은 팀이 이름을 바꾸면 다른 팀으로 잡힙니다.</div>' +
    '</div>';
  liveInit();
}

/* ------------------------------------------------------------------ */
/* 부트                                                                */
/* ------------------------------------------------------------------ */

// 요원 초상화를 받아뒀는지 확인 (없어도 vlr.gg 원본으로 동작한다)
var assetsReady = getJSON('assets/agents/manifest.json')
  .then(function (list) { (list || []).forEach(function (f) { AGENT_ASSETS[f] = 1; }); })
  .catch(function () { });

// players.json 은 첫 화면(#/matches)·이벤트·팀·경기상세 어디서도 안 쓴다.
// 여기서 같이 기다리면 선수 화면에 들어가지도 않은 사람까지 1MB 를 더 받고 나서야
// 첫 렌더가 시작된다. 선수 화면에서만 받도록 needPlayers() 로 뺐다.
Promise.all([getJSON('data/index.json'), assetsReady])
  .then(function (r) {
    DB = r[0];
    DB.events.forEach(function (e) { if (e.logo) EV_LOGO[e.name] = e.logo; });
    DB.teams.forEach(function (t) { if (t.logo) TEAM_LOGO[t.name] = t.logo; });
    DB.byId = {};
    DB.matches.forEach(function (m) { DB.byId[m[M_ID]] = m; });
    document.getElementById('topmeta').textContent =
      DB.meta.matches.toLocaleString() + '경기 (상세 ' + DB.meta.detail.toLocaleString() + ') · ' +
      DB.meta.events.toLocaleString() + '개 대회';
    route();
  })
  .catch(function (e) {
    app.innerHTML = '<div class="card"><div class="empty">데이터를 불러오지 못했습니다.<br>' + h(e.message) +
      '<br><br>파일을 직접 열지 말고 <code>python serve.py</code> 로 실행한 뒤 ' +
      '<code>http://localhost:8000</code> 에 접속하세요.</div></div>';
  });
