/* STUDY AGENT Ver.0.3 — vanilla JS, no build step. */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  var APP_VERSION = '0.4.4';
  var MASTER_BOX = 2;                   // 箱2以上＝日をあけて2回続けて正解＝「習得」
  var MAX_RECHECK = 2;                  // 0.4: 同日再確認は1ミッション最大2問（空き枠があるときだけ）
  var EXTRA_NEW_PER_DAY = 5;            // 追加セットで先取りできる新規問題の数
  var RANKS = [
    [0, '訓練生'], [5, '見習いエージェント'], [10, 'エージェント'],
    [20, '上級エージェント'], [30, 'エリートエージェント'], [40, 'マスターエージェント']
  ];
  var BADGES = [
    { id: 'first', name: '初ミッション', desc: 'はじめてミッションを完了' },
    { id: 'perfect', name: 'パーフェクト', desc: '5問以上のミッションで全問正解' },
    { id: 'streak3', name: '3日連続', desc: '3日続けてミッション完了' },
    { id: 'streak7', name: '7日連続', desc: '7日続けてミッション完了' },
    { id: 'week5', name: '週5日', desc: '1週間で5日学習' },
    { id: 'comeback', name: '苦手克服', desc: '一度間違えた問題を習得' },
    { id: 'master10', name: '習得10問', desc: '10問を習得' },
    { id: 'master20', name: '習得20問', desc: '20問を習得' },
    { id: 'unit', name: '単元マスター', desc: '1つの単元をすべて習得' }
  ];
  var SCHEMA = 1;
  var KEY_REAL = 'sa_data_v1';          // 本番の学習記録
  var KEY_TEST = 'sa_data_test_v1';     // テストモード用のコピー
  var KEY_TESTCFG = 'sa_testcfg_v1';    // テストモード設定 {enabled, date}
  var INTERVALS = [1, 3, 7, 14, 30];    // 箱0〜4 の次回出題までの日数
  var MAX_Q = 10;
  var MAX_NEW_PER_DAY = 5;
  var TIME_LIMIT_MS = 10 * 60 * 1000;
  var SLOW_MS = 20 * 1000;

  var $ = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------------------------
  // Date helpers (学習日は端末のローカル日付 YYYY-MM-DD)
  // ---------------------------------------------------------------------------
  function pad(n) { return String(n).padStart(2, '0'); }
  function localDay(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function isDay(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var p = s.split('-').map(Number);
    var dt = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return dt.getUTCFullYear() === p[0] && dt.getUTCMonth() === p[1] - 1 && dt.getUTCDate() === p[2];
  }
  function addDays(day, n) {
    var p = day.split('-').map(Number);
    var dt = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
    return dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate());
  }
  function dayLabel(day) {
    var p = day.split('-').map(Number);
    var w = '日月火水木金土'[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()];
    return p[1] + '/' + p[2] + '(' + w + ')';
  }

  // ---------------------------------------------------------------------------
  // Storage (破損・容量不足・プライベートモードに耐える)
  // ---------------------------------------------------------------------------
  var notices = [];
  function addNotice(msg) { notices.push(msg); renderNotice(); }

  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function safeRemove(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }

  function emptyData() {
    return { schema: SCHEMA, progress: {}, log: [], days: {}, settings: { allowUnverified: false }, badges: {}, best: 0 };
  }

  function isInt(n, min, max) { return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max; }
  function safeId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id) && !['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty'].includes(id); }

  /** 構造を検証し、正規化したコピーを返す。不正なら {ok:false, errors:[...]} */
  function validateData(d) {
    var errors = [];
    if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, errors: ['データがオブジェクトではありません'] };
    if (d.schema !== SCHEMA) errors.push('schema が ' + SCHEMA + ' ではありません');
    var out = emptyData();

    if (!d.progress || typeof d.progress !== 'object' || Array.isArray(d.progress)) errors.push('progress が不正です');
    else Object.keys(d.progress).forEach(function (id) {
      var p = d.progress[id];
      if (!safeId(id) || !p || !isInt(p.box, 0, 4) || !isDay(p.due) || !isInt(p.correct, 0, 1e9) || !isInt(p.wrong, 0, 1e9) ||
          (p.mastered !== undefined && p.mastered !== null && !isDay(p.mastered))) {   // 0.3.1 (M5)
        errors.push('progress[' + id + '] が不正です');
      } else {
        out.progress[id] = { box: p.box, due: p.due, correct: p.correct, wrong: p.wrong,
          last: isDay(p.last) ? p.last : null, lastCorrect: p.lastCorrect === true,
          mastered: isDay(p.mastered) ? p.mastered : null };
      }
    });

    if (!Array.isArray(d.log)) errors.push('log が配列ではありません');
    else d.log.forEach(function (r, i) {
      if (!r || typeof r.ts !== 'string' || !Number.isFinite(Date.parse(r.ts)) || !isDay(r.day) || !safeId(r.id) ||
          typeof r.correct !== 'boolean' || !Number.isFinite(r.ms) || !(r.ms >= 0)) {
        errors.push('log[' + i + '] が不正です');
      } else {
        out.log.push({ ts: r.ts, day: r.day, id: r.id, unit: typeof r.unit === 'string' ? r.unit : '',
          correct: r.correct, ms: Math.round(r.ms), chosen: isInt(r.chosen, 0, 3) ? r.chosen : null,
          mode: typeof r.mode === 'string' ? r.mode : 'review' });
      }
    });

    if (!d.days || typeof d.days !== 'object' || Array.isArray(d.days)) errors.push('days が不正です');
    else Object.keys(d.days).forEach(function (day) {
      var r = d.days[day];
      if (!isDay(day) || !r || !isInt(r.newCount, 0, 1e6) || !isInt(r.answered, 0, 1e6)) errors.push('days[' + day + '] が不正です');
      else out.days[day] = { newCount: r.newCount, answered: r.answered, missionDone: r.missionDone === true };
    });

    if (d.settings && typeof d.settings === 'object') out.settings.allowUnverified = d.settings.allowUnverified === true;

    // 0.4: これまでの最大習得数（ランクを下げないため。旧データには無いので任意）
    if (d.best !== undefined) {
      if (!isInt(d.best, 0, 1e6)) errors.push('best が不正です');
      else out.best = d.best;
    }

    // 0.3: 実績（任意。旧バージョンのデータにはキー自体が無いので、無いのは可）
    // 0.3.1 (M5): あるのに形が不正・既知の実績の日付が不正 → エラー。未知の実績IDは読み飛ばす（将来版の実績を想定）
    if (d.badges !== undefined) {
      if (!d.badges || typeof d.badges !== 'object' || Array.isArray(d.badges)) errors.push('badges が不正です');
      else Object.keys(d.badges).forEach(function (k) {
        if (!badgeById(k)) return;
        if (!isDay(d.badges[k])) errors.push('badges[' + k + '] の日付が不正です');
        else out.badges[k] = d.badges[k];
      });
    }

    return errors.length ? { ok: false, errors: errors } : { ok: true, data: out };
  }

  function loadTestCfg() {
    var raw = safeGet(KEY_TESTCFG);
    if (!raw) return { enabled: false, date: null };
    try {
      var c = JSON.parse(raw);
      if (c && c.enabled === true && isDay(c.date)) return { enabled: true, date: c.date };
    } catch (e) { /* fall through */ }
    return { enabled: false, date: null };
  }
  function saveTestCfg() { safeSet(KEY_TESTCFG, JSON.stringify(testCfg)); }

  function activeKey() { return testCfg.enabled ? KEY_TEST : KEY_REAL; }

  function loadData() {
    var key = activeKey();
    var raw = safeGet(key);
    if (raw === null) return emptyData();
    var parsed;
    try { parsed = JSON.parse(raw); } catch (e) { parsed = undefined; }
    var v = validateData(parsed);
    if (v.ok) return v.data;
    // 破損：元の文字列を退避してから初期化（消さない）
    var quarantine = 'sa_corrupt_' + Date.now();
    safeSet(quarantine, raw);
    addNotice('学習記録の読み込みに失敗したため、新しい記録で開始しました。元のデータは「' + quarantine + '」に退避しています。');
    return emptyData();
  }

  function save() {
    if (!safeSet(activeKey(), JSON.stringify(data))) {
      addNotice('学習記録を保存できませんでした（容量不足またはプライベートブラウズの可能性）。保護者画面からバックアップを書き出してください。');
    }
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  var testCfg = loadTestCfg();
  var data = loadData();
  var QUESTIONS = [];
  var QMAP = {};
  var QWARN = [];
  var qLoadError = null;
  var mission = null;

  function today() { return testCfg.enabled && testCfg.date ? testCfg.date : localDay(new Date()); }
  function getDay(day) { return data.days[day] || { newCount: 0, answered: 0, missionDone: false }; }
  function dayRec(day) {
    if (!data.days[day]) data.days[day] = { newCount: 0, answered: 0, missionDone: false };
    return data.days[day];
  }

  // ---------------------------------------------------------------------------
  // Questions
  // ---------------------------------------------------------------------------
  function validateQuestion(q) {
    if (!q || typeof q !== 'object') return 'オブジェクトではありません';
    if (!safeId(q.id)) return 'id が不正です';
    if (typeof q.unit !== 'string' || !q.unit) return 'unit がありません';
    if (typeof q.question !== 'string' || !q.question) return 'question がありません';
    if (!Array.isArray(q.choices) || q.choices.length !== 4 ||
        !q.choices.every(function (c) { return typeof c === 'string' && c.length; })) return 'choices は4つの文字列が必要です';
    if (!isInt(q.answer, 0, 3)) return 'answer は 0〜3 の整数が必要です';
    if (typeof q.explanation !== 'string') return 'explanation がありません';
    if (typeof q.verified !== 'boolean') return 'verified は true/false が必要です';
    // 0.4: 任意項目
    if (q.point !== undefined && (typeof q.point !== 'string' || !q.point)) return 'point は文字列が必要です';
    if (q.form !== undefined && typeof q.form !== 'string') return 'form は文字列が必要です';
    if (q.ja !== undefined && typeof q.ja !== 'string') return 'ja は文字列が必要です';
    return null;
  }

  function loadQuestions() {
    return fetch('questions.json', { cache: 'no-cache' })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function (arr) {
        if (!Array.isArray(arr)) throw new Error('questions.json が配列ではありません');
        var seen = {};
        arr.forEach(function (q, i) {
          var err = validateQuestion(q);
          var label = (i + 1) + '件目（' + (q && q.id ? q.id : 'IDなし') + '）';
          if (err) { QWARN.push(label + '：' + err); return; }
          if (seen[q.id]) { QWARN.push(label + '：ID が重複しています'); return; }
          seen[q.id] = true;
          QUESTIONS.push(q);
          QMAP[q.id] = q;
        });
      })
      .catch(function (e) { qLoadError = String(e && e.message || e); });
  }

  function pool() {
    return QUESTIONS.filter(function (q) { return q.verified || data.settings.allowUnverified; });
  }
  function dueList(day) {
    return pool().filter(function (q) { var p = data.progress[q.id]; return p && p.due <= day; })
      .sort(function (a, b) {
        var pa = data.progress[a.id], pb = data.progress[b.id];
        return pa.due < pb.due ? -1 : pa.due > pb.due ? 1 : pa.box - pb.box;
      });
  }
  function unseenList() { return pool().filter(function (q) { return !data.progress[q.id]; }); }
  function newLeftToday(day) { return Math.max(0, MAX_NEW_PER_DAY - getDay(day).newCount); }

  function weakness(p) { var n = p.correct + p.wrong; return n ? p.wrong / n : 0; }
  function weakSort(a, b) {
    var pa = data.progress[a.id], pb = data.progress[b.id];
    return (weakness(pb) - weakness(pa)) || (pb.wrong - pa.wrong) || (pa.box - pb.box);
  }

  /**
   * normal: 期限到来の復習 → 新規（1日最大5問）。最大10問。重複なし。期限前の問題は出さない。
   * extra : 上と同じ順で残りを出し、空きがあれば既習問題を苦手順に「練習」として出す（箱は動かさない）。
   */
  function buildMission(mode) {
    var day = today();
    if (mode === 'one') return buildOne(day);
    var items = [];
    var used = {};
    function push(q, kind) { if (items.length < MAX_Q && !used[q.id]) { used[q.id] = true; items.push({ q: q, kind: kind }); } }

    dueList(day).forEach(function (q) { push(q, 'review'); });
    // 追加セットでは、通常の1日5問に加えてさらに5問まで新しい問題を先取りできる
    var left = mode === 'extra'
      ? Math.max(0, MAX_NEW_PER_DAY + EXTRA_NEW_PER_DAY - getDay(day).newCount)
      : newLeftToday(day);
    unseenList().forEach(function (q) { if (left > 0 && items.length < MAX_Q) { push(q, 'new'); left--; } });
    if (mode === 'extra') {
      pool().filter(function (q) { return data.progress[q.id] && !used[q.id]; })
        .sort(weakSort)
        .forEach(function (q) { push(q, 'practice'); });
    }
    return items;
  }

  /**
   * 0.4.4: 「1問だけ」。次の順で最初に見つかった1問だけを出す（同じ順位の中は dueList と同じ期限の古い順）。
   *   1. 期限が来た復習で、前回不正解
   *   2. 期限が来た復習で、前回正解
   *   3. 新しい問題（1日の新規枠の範囲内）
   *   4. 期限前で前回正解の問題を「練習」として（箱・次回日は動かさない）
   */
  function buildOne(day) {
    var due = dueList(day);
    function lastOk(q) { return data.progress[q.id].lastCorrect === true; }
    var pick = due.filter(function (q) { return !lastOk(q); })[0];
    if (pick) return [{ q: pick, kind: 'review' }];
    pick = due.filter(lastOk)[0];
    if (pick) return [{ q: pick, kind: 'review' }];
    if (newLeftToday(day) > 0) {
      pick = unseenList()[0];
      if (pick) return [{ q: pick, kind: 'new' }];
    }
    pick = pool().filter(function (q) { var p = data.progress[q.id]; return p && p.lastCorrect === true && p.due > day; })
      .sort(function (a, b) { var pa = data.progress[a.id], pb = data.progress[b.id]; return pa.due < pb.due ? -1 : pa.due > pb.due ? 1 : 0; })[0];
    if (pick) return [{ q: pick, kind: 'practice' }];
    return [];
  }

  /** 1問の回答を記録し、ライトナーの箱と次回出題日を更新する */
  function recordAnswer(item, chosen, ms, mode) {
    var q = item.q;
    var day = mission ? mission.day : today();
    var correct = chosen === q.answer;
    // 0.4: 同日再確認は「確認」として記録だけ残す。箱・次回日・習得・新規枠・回答数には一切影響させない
    if (item.kind === 'recheck') {
      data.log.push({ ts: new Date().toISOString(), day: day, id: q.id, unit: q.unit, correct: correct,
        ms: Math.round(ms), chosen: chosen, mode: 'recheck' });
      save();
      return correct;
    }
    var p = data.progress[q.id];
    var d = dayRec(day);
    if (!p) {
      p = { box: 0, due: day, correct: 0, wrong: 0, last: null, lastCorrect: false, mastered: null };
      d.newCount++;
    }
    if (correct) p.correct++; else p.wrong++;
    p.last = day;
    p.lastCorrect = correct;

    var oldBox = p.box;
    if (item.kind !== 'practice') {
      if (!correct) p.box = 0;
      else if (ms < SLOW_MS) p.box = Math.min(4, p.box + 1);
      // 正解でも 20 秒以上なら箱は据え置き
      p.due = addDays(day, INTERVALS[p.box]);
      // 0.3.1: 「箱2未満 → 箱2以上」に上がった瞬間だけを習得イベントとする（M1・H3）
      if (oldBox < MASTER_BOX && p.box >= MASTER_BOX) {
        if (!p.mastered) {
          p.mastered = day;                                   // 初めての習得日（週の集計用）
          if (mission) mission.newMastered = (mission.newMastered || 0) + 1;
        }
        if (p.wrong > 0 && mission) mission.comeback = true;  // 過去に間違えた問題を復習で習得した
      }
    }
    data.progress[q.id] = p;
    updateBest();
    d.answered++;
    data.log.push({ ts: new Date().toISOString(), day: day, id: q.id, unit: q.unit, correct: correct,
      ms: Math.round(ms), chosen: chosen,
      mode: mode === 'one' ? 'one' : item.kind === 'practice' ? 'practice' : mode === 'extra' ? 'extra' : item.kind });
    save();
    return correct;
  }

  function streak() {
    var d = today();
    if (!getDay(d).missionDone) d = addDays(d, -1);
    var n = 0;
    while (getDay(d).missionDone && n < 3660) { n++; d = addDays(d, -1); }
    return n;
  }

  /** 今日のミッションが完了扱いか（途中でやめて残りが0になった場合も完了とみなす） */
  function isTodayDone() {
    var t = today(), r = getDay(t);
    if (r.missionDone) return true;
    if (r.answered > 0 && buildMission('normal').length === 0) {
      dayRec(t).missionDone = true; save(); return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Growth (0.3): 習得・ランク・今週の振り返り・実績
  // ---------------------------------------------------------------------------
  function isMastered(q) { var p = data.progress[q.id]; return !!(p && p.box >= MASTER_BOX); }
  function masteredCount() { return pool().filter(isMastered).length; }
  /** 0.4: ランクは「これまでの最大習得数」で決める（下がらない）。習得数そのものは今の値を表示する */
  function rankCount() { return Math.max(data.best || 0, masteredCount()); }
  /** best を現在の習得数以上にそろえる。変わったら true */
  function updateBest() { var mc = masteredCount(); if (mc > (data.best || 0)) { data.best = mc; return true; } return false; }

  function rankInfo(n) {
    var cur = RANKS[0], next = null;
    for (var i = 0; i < RANKS.length; i++) {
      if (n >= RANKS[i][0]) { cur = RANKS[i]; next = RANKS[i + 1] || null; }
    }
    return { name: cur[1], min: cur[0], next: next ? { name: next[1], need: next[0] } : null };
  }

  function weekStart(day) {
    var p = day.split('-').map(Number);
    var dow = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();   // 0=日
    return addDays(day, -((dow + 6) % 7));                            // 月曜はじまり
  }
  function weekStats(start, cap) {
    var end = addDays(start, 6), n = 0, c = 0, days = {}, mastered = 0;
    if (cap && cap < end) end = cap;   // 0.3.1: 今週分は「今日まで」に限る
    data.log.forEach(function (r) {
      if (r.mode === 'recheck') return;   // 0.4: 同日確認は週の集計に入れない
      if (r.day >= start && r.day <= end) { n++; if (r.correct) c++; days[r.day] = true; }
    });
    Object.keys(data.progress).forEach(function (id) {
      var m = data.progress[id].mastered;
      if (m && m >= start && m <= end) mastered++;
    });
    return { n: n, c: c, rate: n ? Math.round(c / n * 100) : null, days: days, dayCount: Object.keys(days).length, mastered: mastered };
  }

  /** 条件を満たした実績を解除し、今回新しく解除したものを返す */
  function checkBadges(m) {
    var t = today(), got = [];
    function unlock(id) { if (!data.badges[id]) { data.badges[id] = t; got.push(id); } }
    var mc = masteredCount();
    if (Object.keys(data.days).some(function (d) { return data.days[d].missionDone; })) unlock('first');
    // 0.3.1 (H2): 通常ミッションを最後まで終えた（10分終了を含む・中断は除く）ときだけ
    if (m && m.completed && m.mode === 'normal' && m.results.length >= 5 &&
        m.results.every(function (r) { return r.correct; })) unlock('perfect');
    var s = streak();
    if (s >= 3) unlock('streak3');
    if (s >= 7) unlock('streak7');
    if (weekStats(weekStart(t), t).dayCount >= 5) unlock('week5');
    // 0.3.1 (H3): このミッション中に「過去に間違えた問題が復習で箱2以上に上がった」ときだけ
    if (m && m.comeback) unlock('comeback');
    if (mc >= 10) unlock('master10');
    if (mc >= 20) unlock('master20');
    var units = {};
    pool().forEach(function (q) { (units[q.unit] = units[q.unit] || []).push(q); });
    if (Object.keys(units).some(function (u) { return units[u].every(isMastered); })) unlock('unit');
    if (got.length) save();
    return got;
  }
  function badgeById(id) { for (var i = 0; i < BADGES.length; i++) if (BADGES[i].id === id) return BADGES[i]; return null; }

  // ---------------------------------------------------------------------------
  // Timing: performance.now() + visibilitychange で非表示時間を除外
  // ---------------------------------------------------------------------------
  var hiddenAt = null;
  var qTimer = { start: 0, hidden: 0, answered: true };

  function onHide() { if (hiddenAt === null) hiddenAt = performance.now(); }
  function onShow() {
    if (hiddenAt === null) return;
    var dt = performance.now() - hiddenAt;
    hiddenAt = null;
    if (!qTimer.answered) qTimer.hidden += dt;   // 解説表示中の時間は元々計測外
    if (mission) mission.hidden += dt;
    if (!mission && currentScreen === 'home') renderHome();   // 日付が変わっていれば更新
  }
  document.addEventListener('visibilitychange', function () { if (document.hidden) onHide(); else onShow(); });
  window.addEventListener('pagehide', onHide);
  window.addEventListener('pageshow', onShow);

  function missionElapsed() { return mission ? performance.now() - mission.startAt - mission.hidden : 0; }

  // ---------------------------------------------------------------------------
  // UI helpers
  // ---------------------------------------------------------------------------
  var currentScreen = 'home';
  function showScreen(name) {
    ['home', 'quiz', 'result', 'parent'].forEach(function (s) { $('screen-' + s).hidden = s !== name; });
    currentScreen = name;
    window.scrollTo(0, 0);
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }
  function renderNotice() {
    var n = $('notice');
    n.hidden = notices.length === 0;
    n.textContent = notices.join(' / ');
  }
  function renderTestBanner() {
    var b = $('testBanner');
    b.hidden = !testCfg.enabled;
    b.textContent = testCfg.enabled ? 'テストモード：' + dayLabel(testCfg.date) + '（本番の記録には影響しません）' : '';
  }

  // ---------------------------------------------------------------------------
  // Home
  // ---------------------------------------------------------------------------
  function renderHome() {
    renderTestBanner();
    // 0.4.1 (M1): 旧データ（best なし）や復元直後でも、最初の回答より前に今の習得数を best へ退避する
    if (QUESTIONS.length && updateBest()) save();
    var t = today();
    $('homeDate').textContent = dayLabel(t);
    var due = dueList(t).length;
    $('statDue').textContent = due;
    $('statNew').textContent = Math.min(newLeftToday(t), unseenList().length);
    $('statStreak').textContent = streak();
    renderHomeGrowth();

    var main = $('homeMain');
    main.innerHTML = '';

    if (qLoadError) {
      main.appendChild(el('p', 'status-msg', '問題データを読み込めませんでした（' + qLoadError + '）。一度オンラインで開き直してください。'));
      return;
    }
    if (pool().length === 0) {
      main.appendChild(el('p', 'status-msg', '出題できる問題がありません。questions.json で問題を確認して verified を true にするか、保護者画面のデモ設定を使ってください。'));
      return;
    }

    // 0.4.4: 「1問だけ」をいちばん上に置く（出せる問題があるときだけ）
    if (buildMission('one').length) {
      var b1 = el('button', 'btn btn-primary', '1問だけ');
      b1.type = 'button';
      b1.id = 'btnOne';
      b1.addEventListener('click', function () { startMission('one'); });
      main.appendChild(b1);
      main.appendChild(el('p', 'status-msg', '1問で終わってOK。'));
    }

    if (isTodayDone()) {
      main.appendChild(el('p', 'status-done', '本日のミッション完了'));
      main.appendChild(el('p', 'status-msg', 'おつかれさま。続きはまた明日。'));
      var extra = buildMission('extra');
      if (extra.length) {
        main.appendChild(el('p', 'status-msg', '今日はここまでで十分。追加は余裕のあるときだけ。'));
        var b2 = el('button', 'btn', '追加セット（任意・' + extra.length + '問）');
        b2.type = 'button';
        b2.addEventListener('click', function () { startMission('extra'); });
        main.appendChild(b2);
      }
      return;
    }

    var items = buildMission('normal');
    if (!items.length) {
      main.appendChild(el('p', 'status-msg', '今日出題する問題はありません。'));
      return;
    }
    var b = el('button', 'btn', '今日のミッション開始（' + items.length + '問）');
    b.type = 'button';
    b.id = 'btnMission';
    b.addEventListener('click', function () { startMission('normal'); });
    main.appendChild(b);
    main.appendChild(el('p', 'status-msg', '目安は10分。時間になったら、その問題で終わります。'));
  }

  function bar(pct) {
    var track = el('div', 'bar');
    var fill = el('div', 'bar-fill');
    fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
    track.appendChild(fill);
    return track;
  }

  function renderHomeGrowth() {
    var total = pool().length;
    var mc = masteredCount();
    var rk = rankInfo(rankCount());   // 0.4: ランクは下がらない

    // ランクと習得バー
    var r = $('homeRank');
    r.innerHTML = '';
    r.hidden = total === 0;
    r.appendChild(el('div', 'hud-label', 'RANK'));
    r.appendChild(el('div', 'rank-name', rk.name));
    r.appendChild(el('div', 'growth-line', '習得 ' + mc + ' / ' + total + ' 問'));
    r.appendChild(bar(total ? mc / total * 100 : 0));
    r.appendChild(el('div', 'growth-note', rk.next
      ? '次のランク「' + rk.next.name + '」まで、今の習得数から あと' + Math.max(0, rk.next.need - mc) + '問'
      : '最高ランク到達！'));
    r.appendChild(el('div', 'growth-note', '※「習得」は覚え具合の目安。日をあけた復習で、20秒以内の正解を重ねた問題の数です'));

    // 今週の振り返り
    var t = today(), ws = weekStart(t);
    var cur = weekStats(ws, t), prev = weekStats(addDays(ws, -7));
    var w = $('homeWeek');
    w.innerHTML = '';
    w.hidden = total === 0;
    w.appendChild(el('div', 'hud-label', 'THIS WEEK'));
    w.appendChild(el('div', 'section-title', '今週の振り返り'));
    var dots = el('div', 'week-dots');
    for (var i = 0; i < 7; i++) {
      var d = addDays(ws, i);
      var cell = el('div', 'wd-cell');
      cell.appendChild(el('div', 'wd-label', '月火水木金土日'[i]));
      cell.appendChild(el('div', 'wd-dot' + (cur.days[d] ? ' on' : '') + (d === t ? ' today' : ''), cur.days[d] ? '✓' : ''));
      dots.appendChild(cell);
    }
    w.appendChild(dots);
    var grid = el('div', 'stats');
    function stat(num, label) {
      var s = el('div', 'stat');
      s.appendChild(el('div', 'stat-num', num));
      s.appendChild(el('div', 'stat-label', label));
      grid.appendChild(s);
    }
    stat(String(cur.n), '回答数');
    stat(cur.rate === null ? '－' : cur.rate + '%', '正答率');
    stat('+' + cur.mastered, '新しく習得');
    w.appendChild(grid);
    // 0.3.1 (M3): データから言えない評価・原因は書かない
    var cmp;
    if (cur.rate === null) cmp = '今週はまだこれから。今日の5問から始めよう。';
    else if (prev.rate === null) cmp = '今週は ' + cur.dayCount + '日取り組んだね。来週はこの記録と比べられるよ。';
    else if (cur.rate > prev.rate) cmp = '今週は' + cur.rate + '％、先週は' + prev.rate + '％。今週も取り組めたね。';
    else if (cur.rate === prev.rate) cmp = '正答率は先週と同じ' + cur.rate + '％。解説も確認しておこう。';
    else cmp = '今週は' + cur.rate + '％。問題の内容や数が違うので、先週との差は目安だよ。';
    w.appendChild(el('div', 'growth-note', cmp));
    if (cur.rate !== null) w.appendChild(el('div', 'growth-note', '今週は途中の記録です。正答率は出た問題によって変わります。'));

    // 実績
    var b = $('homeBadges');
    b.innerHTML = '';
    b.hidden = total === 0;
    var have = BADGES.filter(function (x) { return data.badges[x.id]; }).length;
    b.appendChild(el('div', 'hud-label', 'ACHIEVEMENTS'));
    b.appendChild(el('div', 'section-title', '実績 ' + have + ' / ' + BADGES.length));
    var g = el('div', 'badge-grid');
    BADGES.forEach(function (x) {
      var on = !!data.badges[x.id];
      var it = el('div', 'badge-item' + (on ? ' on' : ''));
      it.appendChild(el('div', 'badge-name', (on ? '★ ' : '☆ ') + x.name));
      it.appendChild(el('div', 'badge-desc', x.desc));
      g.appendChild(it);
    });
    b.appendChild(g);
  }

  // ---------------------------------------------------------------------------
  // Quiz
  // ---------------------------------------------------------------------------
  var KIND_LABEL = { review: '復習', 'new': '新しい問題', practice: '練習', recheck: 'もう一度確認' };

  function startMission(mode) {
    var items = buildMission(mode);
    if (!items.length) { toast('出題できる問題がありません'); renderHome(); return; }
    if (updateBest()) save();   // 0.4.1 (M1): 念のため開始前にも退避
    mission = { mode: mode, items: items, idx: 0, results: [], startAt: performance.now(), hidden: 0, day: today(), timeUp: false,
      newMastered: 0, comeback: false, rechecks: 0, rankBeforeMin: rankInfo(rankCount()).min };
    showScreen('quiz');
    renderQuestion();
  }

  function renderQuestion() {
    var item = mission.items[mission.idx];
    var q = item.q;
    $('quizProgress').textContent = 'MISSION ' + (mission.idx + 1) + ' / ' + mission.items.length;
    $('progressBar').style.width = (mission.idx / mission.items.length * 100) + '%';
    $('quizUnit').textContent = q.unit;
    $('quizKind').textContent = KIND_LABEL[item.kind] || '';
    $('quizQuestion').textContent = q.question;
    $('feedback').hidden = true;
    $('feedbackTime').hidden = true;
    $('btnNext').hidden = true;

    var box = $('choices');
    box.innerHTML = '';
    // 0.3: 答えの位置を覚えないよう、表示順を毎回シャッフル（記録は元の番号）
    var order = [0, 1, 2, 3];
    for (var k = order.length - 1; k > 0; k--) {
      var j = Math.floor(Math.random() * (k + 1));
      var tmp = order[k]; order[k] = order[j]; order[j] = tmp;
    }
    order.forEach(function (i) {
      var b = el('button', 'choice');
      b.type = 'button';
      b.origIndex = i;
      b.appendChild(el('span', 'choice-text', q.choices[i]));
      b.addEventListener('click', function () { answer(i); });
      box.appendChild(b);
    });

    qTimer = { start: performance.now(), hidden: 0, answered: false };
  }

  /**
   * 0.4: 同日再確認。印（point）のある問題を間違えたとき、空き枠（最大10問まで）があれば、
   * 同じ point の別の問題を2問あと以降に1問だけ入れる。1ミッション最大 MAX_RECHECK 問。
   */
  function queueRecheck(q) {
    if (!q.point || !mission || mission.mode === 'one') return null;   // 0.4.4: 1問モードでは入れない
    if (mission.rechecks >= MAX_RECHECK || mission.items.length >= MAX_Q) return null;
    var used = {};
    mission.items.forEach(function (it) { used[it.q.id] = true; });
    var sibs = pool().filter(function (x) { return x.point === q.point && !used[x.id]; });
    if (!sibs.length) return null;
    sibs.sort(function (a, b) { return (a.form === q.form ? 1 : 0) - (b.form === q.form ? 1 : 0); });   // 違う形を優先
    // 0.4.1 (H1): 間に2問を挟めるときだけ入れる。挟めなければ入れない（元の誤答は通常どおり翌日復習）
    var pos = mission.idx + 3;
    if (pos > mission.items.length) return null;
    mission.items.splice(pos, 0, { q: sibs[0], kind: 'recheck' });
    mission.rechecks++;
    return sibs[0];
  }

  function answer(chosen) {
    if (!mission || qTimer.answered) return;
    var ms = Math.max(0, performance.now() - qTimer.start - qTimer.hidden);
    qTimer.answered = true;
    var item = mission.items[mission.idx];
    var q = item.q;
    var correct = recordAnswer(item, chosen, ms, mission.mode);
    mission.results.push({ q: q, chosen: chosen, correct: correct, ms: ms, kind: item.kind });
    var queued = (!correct && item.kind !== 'recheck') ? queueRecheck(q) : null;

    var buttons = $('choices').children;
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i], o = btn.origIndex;
      btn.disabled = true;
      // 0.3: 色だけでなく文字でも「正解」「あなたの答え」を示す
      if (o === q.answer) {
        btn.classList.add('is-correct');
        btn.appendChild(el('span', 'choice-badge ok', correct ? '✓ 正解（あなたの答え）' : '✓ 正解'));
      } else if (o === chosen) {
        btn.classList.add('is-wrong');
        btn.appendChild(el('span', 'choice-badge ng', '✗ あなたの答え'));
      } else {
        btn.classList.add('is-dim');
      }
    }
    var fr = $('feedbackResult');
    fr.textContent = correct ? '正解！' : '不正解';
    fr.className = 'feedback-result ' + (correct ? 'ok' : 'ng');
    $('feedbackAnswer').textContent = '正解：' + q.choices[q.answer];
    $('feedbackExplanation').textContent = q.explanation;
    // 0.4: 回答後にだけ、正確な日本語訳を表示する
    $('feedbackJa').textContent = q.ja ? '訳：' + q.ja : '';
    $('feedbackJa').hidden = !q.ja;
    $('feedbackRecheck').hidden = !queued;
    $('feedbackRecheck').textContent = queued ? 'このあと、同じ言葉を別の形でもう一度確認します。' : '';
    $('feedback').hidden = false;

    var timeUp = missionElapsed() >= TIME_LIMIT_MS;
    if (timeUp) {
      $('feedbackTime').textContent = '10分たったので、この問題で今日のミッションは終了です。';
      $('feedbackTime').hidden = false;
    }
    var last = timeUp || mission.idx + 1 >= mission.items.length;
    $('btnNext').textContent = mission.mode === 'one' ? '完了' : last ? '結果を見る' : '次の問題へ';
    $('btnNext').hidden = false;
    $('progressBar').style.width = ((mission.idx + 1) / mission.items.length * 100) + '%';
    // 0.2.2: 小さい画面や長い解説でも「次へ」が画面外に隠れないようにする
    try { $('btnNext').scrollIntoView({ block: 'nearest' }); } catch (e) { /* 古いブラウザは無視 */ }
  }

  function next() {
    if (!mission || !qTimer.answered) return;
    // 解説を読んでいる間に10分を超えた場合も、ここで終了する
    if (missionElapsed() >= TIME_LIMIT_MS) mission.timeUp = true;
    if (mission.timeUp || mission.idx + 1 >= mission.items.length) { finishMission(); return; }
    mission.idx++;
    renderQuestion();
  }

  function quit() {
    if (!mission) return;
    var answeredCount = mission.results.length;
    var msg = answeredCount
      ? 'ミッションを中断しますか？ここまでの' + answeredCount + '問の記録は保存されています。'
      : 'ミッションを中断しますか？';
    if (!confirm(msg)) return;
    if (answeredCount) { finishMission(true); return; }
    mission = null;
    showScreen('home');
    renderHome();
  }

  function finishMission(interrupted) {
    var m = mission;
    var rec = dayRec(m.day);
    if (m.mode === 'normal' && !interrupted) rec.missionDone = true;
    m.completed = !interrupted;   // 10分終了は完了扱い、中断は未完了
    save();
    m.newBadges = checkBadges(m);
    mission = null;
    qTimer.answered = true;
    renderResult(m);
    showScreen('result');
  }

  // ---------------------------------------------------------------------------
  // Result
  // ---------------------------------------------------------------------------
  function commentFor(c, n) {
    if (n > 0 && c === n) return '全問正解！この調子で記録を伸ばそう。';
    if (c * 2 >= n) return c + '問正解。間違えた問題の解説を確認して、次の復習につなげよう。';
    return '今日は手ごわかったね。間違えた問題の解説を1つだけでも読んでおこう。';
  }

  function renderResult(m) {
    var n = m.results.length;
    var c = m.results.filter(function (r) { return r.correct; }).length;
    $('resultScore').textContent = c + ' / ' + n;
    // 0.4.4: 1問モードでは点数を出さない（結果画面は使い回すので、他のモードでは毎回表示に戻す）
    $('resultScore').hidden = m.mode === 'one';
    $('resultScoreLabel').hidden = m.mode === 'one';
    var comment = commentFor(c, n);
    if (m.results.some(function (r) { return r.kind === 'recheck'; })) comment += '（「もう一度確認」の問題を含む）';
    if (m.timeUp) comment = '10分たったので今日はここまで。' + comment;
    if (m.mode === 'one') comment = '1問クリア。今日はここまででOK。';   // 0.4.4: 点数より「終えたこと」を伝える
    $('resultComment').textContent = comment;

    // 0.3: 成長と実績
    var gbox = $('resultGrowth');
    gbox.innerHTML = '';
    var mc = masteredCount(), total = pool().length, rk = rankInfo(rankCount());
    if (rk.min > m.rankBeforeMin) {   // 0.3.1 (H1): 上がったときだけ通知（下がったときは出さない）
      gbox.appendChild(el('div', 'unlock', 'ランクアップ！ 「' + rk.name + '」になった'));
    }
    (m.newBadges || []).forEach(function (id) {
      var bd = badgeById(id);
      if (bd) gbox.appendChild(el('div', 'unlock', '実績解除！ ★ ' + bd.name + '（' + bd.desc + '）'));
    });
    var gp = el('div', 'panel');
    gp.appendChild(el('div', 'hud-label', 'GROWTH'));
    gp.appendChild(el('div', 'rank-name', rk.name));
    gp.appendChild(el('div', 'growth-line', '習得 ' + mc + ' / ' + total + ' 問' + (m.newMastered ? '（今回 +' + m.newMastered + '）' : '')));
    gp.appendChild(bar(total ? mc / total * 100 : 0));
    gp.appendChild(el('div', 'growth-note', rk.next
      ? '次のランク「' + rk.next.name + '」まで、今の習得数から あと' + Math.max(0, rk.next.need - mc) + '問'
      : '最高ランク到達！'));
    gbox.appendChild(gp);

    var list = $('wrongList');
    list.innerHTML = '';
    var wrong = m.results.filter(function (r) { return !r.correct; });
    $('wrongTitle').textContent = wrong.length ? '間違えた問題（タップで解説）' : '間違えた問題はありません';
    wrong.forEach(function (r) {
      var b = el('button', 'panel wrong-item');
      b.type = 'button';
      b.appendChild(el('div', 'hint', r.q.unit));
      b.appendChild(el('div', 'wq', r.q.question));
      var detail = el('div', 'wd');
      detail.appendChild(el('div', '', 'あなたの答え：' + r.q.choices[r.chosen]));
      detail.appendChild(el('div', '', '正解：' + r.q.choices[r.q.answer]));
      if (r.q.ja) detail.appendChild(el('div', '', '訳：' + r.q.ja));
      detail.appendChild(el('div', '', r.q.explanation));
      detail.hidden = true;
      b.appendChild(detail);
      b.addEventListener('click', function () { detail.hidden = !detail.hidden; });
      list.appendChild(b);
    });
  }

  // ---------------------------------------------------------------------------
  // Parent
  // ---------------------------------------------------------------------------
  function renderParent() {
    renderTestBanner();
    var verified = QUESTIONS.filter(function (q) { return q.verified; }).length;
    $('pQuestions').textContent = qLoadError
      ? '読み込みエラー：' + qLoadError
      : '全' + QUESTIONS.length + '問／確認済み ' + verified + '問／現在の出題対象 ' + pool().length + '問';
    var wl = $('pQuestionWarnings');
    wl.innerHTML = '';
    QWARN.forEach(function (w) { wl.appendChild(el('li', '', w)); });

    // 直近7日
    var week = $('pWeek');
    week.innerHTML = '';
    var t = today();
    for (var i = 6; i >= 0; i--) {
      var d = addDays(t, -i);
      var r = getDay(d);
      var cell = el('div');
      cell.appendChild(el('div', 'd', dayLabel(d).replace(/^\d+\//, '')));
      cell.appendChild(el('div', 'm ' + (r.missionDone ? 'done' : r.answered ? 'some' : ''), r.missionDone ? '✓' : r.answered ? '・' : '－'));
      week.appendChild(cell);
    }

    // 単元別
    var units = {};
    var order = [];
    QUESTIONS.forEach(function (q) { if (!units[q.unit]) { units[q.unit] = { n: 0, c: 0 }; order.push(q.unit); } });
    data.log.forEach(function (r) {
      if (r.mode === 'recheck') return;   // 0.4: 同日確認は単元別の成績に入れない
      var u = r.unit || (QMAP[r.id] && QMAP[r.id].unit) || '不明';
      if (!units[u]) { units[u] = { n: 0, c: 0 }; order.push(u); }
      units[u].n++; if (r.correct) units[u].c++;
    });
    var tbl = el('table', 'data');
    var hr = el('tr');
    hr.appendChild(el('th', '', '単元')); hr.appendChild(el('th', 'num', '回答数')); hr.appendChild(el('th', 'num', '正答率'));
    tbl.appendChild(hr);
    order.forEach(function (u) {
      var tr = el('tr');
      tr.appendChild(el('td', '', u));
      tr.appendChild(el('td', 'num', String(units[u].n)));
      tr.appendChild(el('td', 'num', units[u].n ? Math.round(units[u].c / units[u].n * 100) + '%' : '－'));
      tbl.appendChild(tr);
    });
    $('pUnits').innerHTML = '';
    $('pUnits').appendChild(tbl);

    // 苦手上位10
    var weakIds = Object.keys(data.progress).filter(function (id) { return data.progress[id].wrong > 0; })
      .map(function (id) { return { id: id }; }).sort(weakSort).slice(0, 10);
    var wk = $('pWeak');
    wk.innerHTML = '';
    if (!weakIds.length) wk.appendChild(el('p', 'small-note', 'まだ間違えた問題はありません。'));
    weakIds.forEach(function (w) {
      var p = data.progress[w.id], q = QMAP[w.id];
      var row = el('div', 'weak-item');
      row.appendChild(el('div', '', q ? q.question : w.id + '（問題データにありません）'));
      row.appendChild(el('div', 'weak-meta', w.id + '・' + (q ? q.unit : '') + '・正解' + p.correct + '／不正解' + p.wrong + '・箱' + p.box + '・次回 ' + p.due));
      wk.appendChild(row);
    });

    $('chkUnverified').checked = data.settings.allowUnverified;
    $('pTestOff').hidden = testCfg.enabled;
    $('pTestOn').hidden = !testCfg.enabled;
    if (testCfg.enabled) $('inpTestDate').value = testCfg.date;
    $('btnRestore').disabled = testCfg.enabled;
    $('pDataNote').textContent = testCfg.enabled
      ? 'テストモード中です。書き出しはテスト用データになります。読み込みはテスト終了後に行ってください。'
      : '記録は学習履歴 ' + data.log.length + '件。週に1回はJSONバックアップを書き出してください。';
    $('pVersion').textContent = 'STUDY AGENT Ver.' + APP_VERSION;
  }

  // ---------------------------------------------------------------------------
  // Export / Import
  // ---------------------------------------------------------------------------
  function csvCell(v) {
    var s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function fmtTs(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    return localDay(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  var MODE_LABEL = { review: '復習', 'new': '新規', extra: '追加セット', practice: '練習', recheck: '同日確認', one: '1問' };
  function buildCsv() {
    var rows = [['日時', '学習日', '問題ID', '単元', '正誤', '回答時間(秒)', '選んだ答え', '正解', '種類']];
    data.log.forEach(function (r) {
      var q = QMAP[r.id];
      rows.push([fmtTs(r.ts), r.day, r.id, r.unit, r.correct ? '正解' : '不正解', (r.ms / 1000).toFixed(1),
        q && r.chosen !== null ? q.choices[r.chosen] : '', q ? q.choices[q.answer] : '', MODE_LABEL[r.mode] || r.mode]);
    });
    return '﻿' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  }

  function stamp() { var d = new Date(); return localDay(d).replace(/-/g, '') + '-' + pad(d.getHours()) + pad(d.getMinutes()); }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime });
    // ホーム画面から起動した iOS PWA では <a download> が不安定なため共有シートを使う
    if (navigator.standalone === true && navigator.canShare) {
      try {
        var file = new File([blob], filename, { type: mime });
        if (navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file] }).catch(function () { /* キャンセル */ });
          return;
        }
      } catch (e) { /* fall back */ }
    }
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  function exportCsv() { download('study-agent-log-' + stamp() + '.csv', buildCsv(), 'text/csv'); }
  function exportBackup() {
    var payload = { app: 'STUDY AGENT', schema: SCHEMA, appVersion: APP_VERSION, exportedAt: new Date().toISOString(), test: testCfg.enabled, data: data };
    download('study-agent-backup-' + stamp() + '.json', JSON.stringify(payload, null, 1), 'application/json');
  }

  function importBackupText(text) {
    var obj;
    try { obj = JSON.parse(text); } catch (e) { return { ok: false, errors: ['JSONとして読み込めません'] }; }
    if (!obj || obj.app !== 'STUDY AGENT' || obj.schema !== SCHEMA) return { ok: false, errors: ['STUDY AGENT のバックアップ形式ではありません'] };
    if (obj.test !== false) return { ok: false, errors: ['テスト用または種別不明のバックアップは本番へ読み込めません'] };
    return validateData(obj.data);
  }

  function onRestoreFile(file) {
    if (testCfg.enabled) { alert('テストモード中は読み込めません。'); return; }
    file.text().then(function (text) {
      var v = importBackupText(text);
      if (!v.ok) { alert('読み込みを中止しました：\n' + v.errors.slice(0, 5).join('\n')); return; }
      if (!confirm('バックアップ（学習履歴 ' + v.data.log.length + '件）で現在の記録（' + data.log.length + '件）を上書きします。よろしいですか？')) return;
      safeSet('sa_pre_import_' + Date.now(), JSON.stringify(data));   // 念のため上書き前を退避
      data = v.data;
      updateBest();   // 0.4.1 (M1)
      save();
      toast('バックアップを読み込みました');
      renderParent();
    }).catch(function () { alert('ファイルを読み込めませんでした。'); });
  }

  // ---------------------------------------------------------------------------
  // Test mode (本番データのコピー上で日付を動かす)
  // ---------------------------------------------------------------------------
  function testOn() {
    if (!confirm('テストモードを開始します。本番の記録をコピーして、そのコピー上で日付を動かします。')) return;
    var realToday = localDay(new Date());
    safeSet(KEY_TEST, JSON.stringify(data));
    testCfg = { enabled: true, date: realToday };
    saveTestCfg();
    data = loadData();
    renderParent();
  }
  function testOff() {
    if (!confirm('テストモードを終了し、テスト用のデータを破棄します。本番の記録は変わりません。')) return;
    safeRemove(KEY_TEST);
    testCfg = { enabled: false, date: null };
    saveTestCfg();
    data = loadData();
    renderParent();
  }
  function setTestDate(day) {
    if (!testCfg.enabled || !isDay(day)) return;
    testCfg.date = day;
    saveTestCfg();
    renderParent();
  }

  // ---------------------------------------------------------------------------
  // Wire up
  // ---------------------------------------------------------------------------
  $('btnParent').addEventListener('click', function () { renderParent(); showScreen('parent'); });
  $('btnParentBack').addEventListener('click', function () { showScreen('home'); renderHome(); });
  $('btnNext').addEventListener('click', next);
  $('btnQuit').addEventListener('click', quit);
  $('btnHome').addEventListener('click', function () { showScreen('home'); renderHome(); });
  $('btnCsv').addEventListener('click', exportCsv);
  $('btnBackup').addEventListener('click', exportBackup);
  $('btnRestore').addEventListener('click', function () { $('fileRestore').value = ''; $('fileRestore').click(); });
  $('fileRestore').addEventListener('change', function (e) { if (e.target.files[0]) onRestoreFile(e.target.files[0]); });
  $('chkUnverified').addEventListener('change', function (e) { data.settings.allowUnverified = e.target.checked; save(); renderParent(); });
  $('btnTestOn').addEventListener('click', testOn);
  $('btnTestOff').addEventListener('click', testOff);
  $('btnTestPlus1').addEventListener('click', function () { setTestDate(addDays(testCfg.date, 1)); });
  $('inpTestDate').addEventListener('change', function (e) { setTestDate(e.target.value); });

  if (!safeSet('sa_probe', '1')) addNotice('この端末では記録を保存できません（プライベートブラウズを解除してください）。');
  else safeRemove('sa_probe');

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function (reg) { reg.update(); }).catch(function () { /* ignore */ });
    });
  }

  renderNotice();
  loadQuestions().then(function () { renderHome(); });

  // テスト・デバッグ用（UIからは使わない）
  window.__SA = {
    get data() { return data; }, get mission() { return mission; }, get questions() { return QUESTIONS; },
    buildMission: buildMission, recordAnswer: recordAnswer, today: today, addDays: addDays,
    validateData: validateData, importBackupText: importBackupText, buildCsv: buildCsv,
    rankInfo: rankInfo, masteredCount: masteredCount, weekStart: weekStart, weekStats: weekStats, rankCount: rankCount,
    _setMissionStart: function (msAgo) { if (mission) mission.startAt = performance.now() - msAgo; },
    _setQuestionStart: function (msAgo) { qTimer.start = performance.now() - msAgo; },
    _onHide: onHide, _onShow: onShow
  };
})();
