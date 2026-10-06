/**
 * 有給休暇の計算ロジック（純粋関数・Google の API を一切使わない）
 *
 * Code.gs（Apps Script）からも、Node のテスト（test/leave-calc.test.js）からも同じものを使う。
 * ＝シートに書く前の「計算の正しさ」を、Google にログインせず手元で確かめられる。
 *
 * ■ 日付の扱い
 *   日付はすべて 'YYYY-MM-DD' の文字列で扱う（Date オブジェクトはタイムゾーンで1日ずれやすいため）。
 *   「入社から6か月」「付与から2年」のような月単位の計算は、応当日（同じ日付）を使い、
 *   応当日が無い月（例: 8/31 の6か月後＝2/31）は翌月1日とする（期間の満了＝その月の末日 → 翌日が付与日）。
 *
 * ■ 時間の扱い
 *   残日数は内部では「時間」で持つ（1日＝1日の所定労働時間。端数は時間単位に切り上げ。7.5時間→8時間）。
 *   表示するときに「X日Y時間」に直す。
 *
 * 前提にした法令ルールと簡略化の一覧は README.md を参照。
 */
var LeaveCalc = (function () {
  'use strict';

  var EPS = 1e-9;

  /** 既定の設定。シートの「設定」タブで上書きできる（就業規則に合わせて調整する前提）。 */
  var DEFAULT_CONFIG = {
    maxHoldDays: 40,        // 保有上限（超えた分は古い付与から切り捨て）
    expireYears: 2,         // 時効（労基法115条）
    hourlyCapDays: 5,       // 時間単位年休の上限（労基法39条4項・繰越分を含めて年5日）
    warnDays: 90,           // 時効・年5日義務の期限がこの日数以内ならアラート
    obligationMinGrant: 10, // 年5日取得義務の対象（その基準日の付与日数がこれ以上）
    obligationDays: 5,      // 年5日取得義務の日数
    firstGrantMonths: 6,    // 初回付与（入社から何か月後）
    normalWeekHours: 30,    // 週所定労働時間がこれ以上なら通常付与
    normalWeekDays: 5,      // 週所定労働日数がこれ以上なら通常付与
    // 勤続 0.5年 / 1.5年 / 2.5年 / 3.5年 / 4.5年 / 5.5年 / 6.5年以上
    table: {
      normal: [10, 11, 12, 14, 16, 18, 20],
      w4: [7, 8, 9, 10, 12, 13, 15],
      w3: [5, 6, 6, 8, 9, 10, 11],
      w2: [3, 4, 4, 5, 6, 6, 7],
      w1: [1, 2, 2, 2, 3, 3, 3]
    }
  };

  var CATEGORY_LABEL = {
    normal: '通常付与',
    w4: '比例付与（週4日）',
    w3: '比例付与（週3日）',
    w2: '比例付与（週2日）',
    w1: '比例付与（週1日）',
    none: '付与対象外'
  };

  // ---------------------------------------------------------------- 表示用

  /**
   * 更新履歴に残す編集者メールを伏せ字にする（公開・共有したシートで Gmail が丸見えにならないように）。
   * 'user@example.com' → 'u***@example.com'。メールの形でない・空なら '（不明）'。
   */
  function maskEmail(s) {
    var str = String(s == null ? '' : s).trim();
    var at = str.lastIndexOf('@');
    if (at < 1 || at === str.length - 1) return '（不明）';
    return str.charAt(0) + '***@' + str.slice(at + 1);
  }

  // ---------------------------------------------------------------- 日付

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function parseYmd(s) { var p = s.split('-'); return { y: +p[0], m: +p[1], d: +p[2] }; }
  function fmtYmd(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }
  /** 'YYYY-MM-DD' の形で、かつ暦上ある日付か（2026-02-30 等は false）。parse → 再フォーマットの往復一致で判定。 */
  function isYmd(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var p = parseYmd(s);
    var dt = new Date(Date.UTC(p.y, p.m - 1, p.d));
    return fmtYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()) === s;
  }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

  /** n か月後の応当日。応当日が無い月は翌月1日。 */
  function addMonths(s, n) {
    var p = parseYmd(s);
    var total = p.y * 12 + (p.m - 1) + n;
    var y = Math.floor(total / 12);
    var m = total - y * 12 + 1;
    if (p.d <= daysInMonth(y, m)) return fmtYmd(y, m, p.d);
    return m === 12 ? fmtYmd(y + 1, 1, 1) : fmtYmd(y, m + 1, 1);
  }
  function toSerial(s) { var p = parseYmd(s); return Math.round(Date.UTC(p.y, p.m - 1, p.d) / 86400000); }
  function fromSerial(n) {
    var dt = new Date(n * 86400000);
    return fmtYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  function addDays(s, n) { return fromSerial(toSerial(s) + n); }
  /** b − a（日数） */
  function diffDays(a, b) { return toSerial(b) - toSerial(a); }

  // ---------------------------------------------------------------- 設定・区分

  function mergeConfig(partial) {
    var cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    if (!partial) return cfg;
    Object.keys(partial).forEach(function (k) {
      if (k === 'table') return;
      var v = partial[k];
      if (typeof v === 'number' && isFinite(v)) cfg[k] = v;
    });
    if (partial.table) {
      Object.keys(partial.table).forEach(function (cat) {
        var row = partial.table[cat];
        if (Array.isArray(row) && row.length && row.every(function (x) { return typeof x === 'number' && isFinite(x) && x >= 0; })) {
          cfg.table[cat] = row.slice();
        }
      });
    }
    return cfg;
  }

  /** 通常付与か比例付与か（週所定労働時間・日数で判定）。 */
  function grantCategory(emp, cfg) {
    var wd = Number(emp.weekDays) || 0;
    var wh = Number(emp.weekHours) || 0;
    if (wh >= cfg.normalWeekHours || wd >= cfg.normalWeekDays) return 'normal';
    if (wd >= 1 && wd < 5) return 'w' + Math.floor(wd);
    return 'none';
  }

  /** 時間単位年休の「1日」が何時間か（1日の所定労働時間。端数は切り上げ）。 */
  function hoursPerDay(emp) {
    var daily = Number(emp.dailyHours);
    if (!(daily > 0)) {
      var wd = Number(emp.weekDays) || 0;
      var wh = Number(emp.weekHours) || 0;
      daily = wd > 0 ? wh / wd : 0;
    }
    return daily > 0 ? Math.ceil(daily - EPS) : 0;
  }

  function grantDate(hire, k, cfg) { return addMonths(hire, cfg.firstGrantMonths + 12 * k); }
  function grantDaysFor(cat, k, cfg) {
    var row = cfg.table[cat];
    if (!row || !row.length) return 0;
    return row[Math.min(k, row.length - 1)] || 0;
  }
  function serviceLabel(k, cfg) {
    var years = cfg.firstGrantMonths / 12 + k;
    var rowLen = (cfg.table.normal || []).length || 7;
    var label = (Math.round(years * 10) / 10) + '年';
    return k >= rowLen - 1 ? label + '（最上段）' : label;
  }

  /** 時間 → 「X日Y時間」 */
  function fmtDH(h, H) {
    if (!(h > EPS) || !(H > 0)) return '0日';
    var d = Math.floor((h + EPS) / H);
    var r = Math.round((h - d * H) * 100) / 100;
    if (r < EPS) r = 0;
    return ((d ? d + '日' : '') + (r ? r + '時間' : '')) || '0日';
  }
  function fmtDays(x) { return (Math.round(x * 10) / 10) + '日'; }

  function normalizeType(t) {
    var s = String(t == null ? '' : t).trim();
    if (s === '全日' || s === '1日' || s === '終日') return 'full';
    if (s === '半日' || s === '午前' || s === '午後') return 'half';
    if (s === '時間' || s === '時間単位') return 'hourly';
    return '';
  }

  // ---------------------------------------------------------------- 1人分の計算

  /**
   * @param {{id,name,hire,weekDays,weekHours,dailyHours}} emp  hire は 'YYYY-MM-DD'
   * @param {Array<{row,empId,date,type,hours}>} records         その職員の取得記録（date は 'YYYY-MM-DD'）
   * @param {string} today  計算基準日 'YYYY-MM-DD'
   * @param {object} cfg    mergeConfig() の戻り値
   */
  function computeEmployee(emp, records, today, cfg) {
    var res = {
      emp: emp, category: 'none', H: 0, grants: [], judgements: {}, alerts: [],
      current: null, next: null, expiry: null, remainingH: 0, obligation: null
    };
    function judgeAll(msg) { records.forEach(function (r) { res.judgements[r.row] = msg; }); }

    if (!isYmd(emp.hire)) {
      res.alerts.push('✖ 入社日が未入力か日付ではありません');
      judgeAll('✖ 職員マスタの入社日を確認してください');
      return res;
    }
    var cat = grantCategory(emp, cfg);
    var H = hoursPerDay(emp);
    res.category = cat;
    res.H = H;
    if (cat === 'none' || !H) {
      res.alerts.push(cat === 'none' ? '✖ 週所定労働日数・時間が未入力（付与区分を判定できません）' : '✖ 1日の所定労働時間が未入力です');
      judgeAll('✖ 職員マスタの所定労働日数・時間を確認してください');
      return res;
    }

    // 計算基準日までの付与（基準日）を並べる
    var grants = [];
    for (var k = 0; k < 200; k++) {
      var gd = grantDate(emp.hire, k, cfg);
      if (gd > today) break;
      var days = grantDaysFor(cat, k, cfg);
      grants.push({
        k: k, date: gd, expire: addMonths(gd, 12 * cfg.expireYears), days: days,
        grantedH: days * H, usedH: 0, expiredH: 0, cutH: 0, carryInH: 0, expired: false
      });
    }
    res.grants = grants;

    var stats = grants.map(function () { return { usedH: 0, hourlyH: 0, oblDays: 0 }; });
    var live = [];  // 有効な付与（古い順）
    var gi = 0;     // 次に反映する付与の添字

    function remain(b) { return b.grantedH - b.usedH - b.expiredH - b.cutH; }
    function liveRemain() { return live.reduce(function (s, b) { return s + remain(b); }, 0); }

    /** d までに起きる「時効消滅」「付与（＋上限切り捨て）」を日付順に反映。同じ日は 時効→付与 の順。 */
    function advanceTo(d) {
      for (;;) {
        var exp = live.length && live[0].expire <= d ? live[0].expire : null;
        var gnt = gi < grants.length && grants[gi].date <= d ? grants[gi].date : null;
        if (!exp && !gnt) return;
        if (exp && (!gnt || exp <= gnt)) {
          var b = live.shift();
          b.expiredH = Math.max(0, remain(b));
          b.expired = true;
        } else {
          var g = grants[gi++];
          g.carryInH = liveRemain();
          live.push(g);
          var maxH = cfg.maxHoldDays * H;
          var excess = liveRemain() - maxH;
          if (excess > EPS) {
            for (var i = 0; i < live.length && excess > EPS; i++) {
              var cut = Math.min(remain(live[i]), excess);
              live[i].cutH += cut;
              excess -= cut;
            }
          }
        }
      }
    }

    var sorted = records.slice().sort(function (a, b) {
      var da = isYmd(a.date) ? a.date : '9999-99-99';
      var db = isYmd(b.date) ? b.date : '9999-99-99';
      return da < db ? -1 : da > db ? 1 : a.row - b.row;
    });

    sorted.forEach(function (r) {
      if (!isYmd(r.date)) { res.judgements[r.row] = '✖ 取得日が未入力か日付ではありません'; return; }
      var type = normalizeType(r.type);
      if (!type) { res.judgements[r.row] = '✖ 区分は「全日」「半日」「時間」のどれかにしてください'; return; }
      if (r.date > today) { res.judgements[r.row] = '予定（計算基準日より後のため未計上）'; return; }

      advanceTo(r.date);
      var p = gi - 1;
      if (p < 0) {
        res.judgements[r.row] = '✖ 初回付与（' + grantDate(emp.hire, 0, cfg) + '）より前の日付です';
        return;
      }

      var amount;
      if (type === 'full') amount = H;
      else if (type === 'half') amount = H / 2;
      else {
        var h = Number(r.hours);
        if (!(h >= 1 && h < H && Math.floor(h) === h)) {
          res.judgements[r.row] = '✖ 時間数は 1〜' + (H - 1) + ' の整数で入力してください（' + H + '時間以上は「全日」）';
          return;
        }
        var capH = cfg.hourlyCapDays * H;
        if (stats[p].hourlyH + h > capH + EPS) {
          res.judgements[r.row] = '✖ 時間単位年休の上限（年' + cfg.hourlyCapDays + '日＝' + capH + '時間）を超えます（今期の使用済 ' + stats[p].hourlyH + '時間）';
          return;
        }
        amount = h;
      }

      var available = liveRemain();
      if (amount > available + EPS) {
        res.judgements[r.row] = '✖ 残日数が足りません（残 ' + fmtDH(available, H) + '）';
        return;
      }

      // 古い付与（繰越分）から先に使う
      var rest = amount;
      for (var i = 0; i < live.length && rest > EPS; i++) {
        var use = Math.min(remain(live[i]), rest);
        live[i].usedH += use;
        rest -= use;
      }
      stats[p].usedH += amount;
      if (type === 'hourly') stats[p].hourlyH += amount;
      else stats[p].oblDays += (type === 'full' ? 1 : 0.5);
      res.judgements[r.row] = '✔ 計上（この時点の残 ' + fmtDH(liveRemain(), H) + '）';
    });

    advanceTo(today);
    res.remainingH = liveRemain();

    var cur = gi - 1;
    res.next = { date: grantDate(emp.hire, cur + 1, cfg), days: grantDaysFor(cat, cur + 1, cfg) };
    if (cur < 0) return res;

    var g = grants[cur];
    res.current = {
      date: g.date, days: g.days, carryInH: g.carryInH,
      usedH: stats[cur].usedH, hourlyH: stats[cur].hourlyH, hourlyCapH: cfg.hourlyCapDays * H
    };

    // 年5日取得義務（その基準日の付与が10日以上の人。期限＝基準日から1年。時間単位は数えない）
    var deadline = addDays(addMonths(g.date, 12), -1);
    var applies = g.days >= cfg.obligationMinGrant;
    var taken = stats[cur].oblDays;
    var daysLeft = diffDays(today, deadline);
    res.obligation = { applies: applies, taken: taken, deadline: deadline, daysLeft: daysLeft, met: applies && taken >= cfg.obligationDays };
    if (applies && taken < cfg.obligationDays && daysLeft <= cfg.warnDays) {
      res.alerts.push('⚠ 年' + cfg.obligationDays + '日取得義務：あと' + fmtDays(cfg.obligationDays - taken) + '（期限 ' + deadline + '・残り' + daysLeft + '日）');
    }
    if (cur >= 1) {
      var pg = grants[cur - 1];
      if (pg.days >= cfg.obligationMinGrant && stats[cur - 1].oblDays < cfg.obligationDays) {
        res.alerts.push('✖ 前の期間（' + pg.date + '付与分）の年' + cfg.obligationDays + '日取得義務が未達でした（' + fmtDays(stats[cur - 1].oblDays) + '）');
      }
    }

    // 時効の見込み（いちばん古い有効な付与のうち、残があるもの）
    for (var j = 0; j < live.length; j++) {
      var rr = remain(live[j]);
      if (rr > EPS) {
        var until = diffDays(today, live[j].expire);
        res.expiry = { date: live[j].expire, hours: rr, daysUntil: until };
        if (until <= cfg.warnDays) {
          res.alerts.push('⚠ ' + live[j].expire + ' に ' + fmtDH(rr, H) + ' が時効で消滅見込み（あと' + until + '日）');
        }
        break;
      }
    }

    var cutTotal = grants.reduce(function (s, b) { return s + b.cutH; }, 0);
    if (cutTotal > EPS) res.alerts.push('⚠ 保有上限（' + cfg.maxHoldDays + '日）を超えた ' + fmtDH(cutTotal, H) + ' を切り捨てました');

    return res;
  }

  // ---------------------------------------------------------------- 全員分 → シートに書く2次元配列

  var SUMMARY_HEADERS = ['職員ID', '氏名', '付与区分', '直近の付与日', '今回付与', '繰越', '今期の取得', '残（日）', '残（時間）',
    '時間単位（今期/上限）', '年5日取得義務', '次回付与日', '次回付与', '時効の見込み', 'アラート'];
  var GRANT_HEADERS = ['職員ID', '氏名', '付与日', '勤続', '付与日数', '時効日（この日に消滅）', '使用', '時効消滅', '上限切捨', '残', '状態'];

  /**
   * @returns {{summaryRows: any[][], grantRows: any[][], judgements: Object<number,{name:string,msg:string}>, results: object[]}}
   */
  function computeAll(employees, records, today, cfgPartial) {
    var cfg = mergeConfig(cfgPartial);
    var byEmp = {};
    var known = {};
    employees.forEach(function (e) { known[e.id] = e; byEmp[e.id] = []; });
    var judgements = {};
    records.forEach(function (r) {
      if (!r.empId) { judgements[r.row] = { name: '', msg: '✖ 職員IDが未入力です' }; return; }
      if (!known[r.empId]) { judgements[r.row] = { name: '', msg: '✖ 職員IDが職員マスタにありません' }; return; }
      byEmp[r.empId].push(r);
    });

    var summaryRows = [];
    var grantRows = [];
    var results = [];
    employees.forEach(function (e) {
      var res = computeEmployee(e, byEmp[e.id], today, cfg);
      results.push(res);
      var H = res.H;
      Object.keys(res.judgements).forEach(function (row) { judgements[row] = { name: e.name, msg: res.judgements[row] }; });

      var c = res.current;
      var ob = res.obligation;
      var obText = '';
      if (c) {
        if (!ob.applies) obText = '対象外（付与' + c.days + '日）';
        else if (ob.met) obText = '達成（' + fmtDays(ob.taken) + '）';
        else obText = '未達 ' + fmtDays(ob.taken) + '/' + cfg.obligationDays + '日（期限 ' + ob.deadline + '）';
      }
      var expText = res.expiry ? res.expiry.date + ' に ' + fmtDH(res.expiry.hours, H) : (c ? 'なし' : '');
      var remDays = H ? Math.floor((res.remainingH + EPS) / H) : 0;
      var remHours = H ? Math.round((res.remainingH - remDays * H) * 100) / 100 : 0;
      var catLabel = CATEGORY_LABEL[res.category] || '';
      if (!c && res.category !== 'none' && isYmd(e.hire)) catLabel += '（初回付与前）';

      summaryRows.push([
        e.id, e.name, catLabel,
        c ? c.date : '',
        c ? c.days + '日' : '',
        c ? fmtDH(c.carryInH, H) : '',
        c ? fmtDH(c.usedH, H) : '',
        c ? remDays : '',
        c ? remHours : '',
        c ? c.hourlyH + '/' + c.hourlyCapH + '時間' : '',
        obText,
        res.category === 'none' || !isYmd(e.hire) ? '' : res.next.date,
        res.category === 'none' || !isYmd(e.hire) ? '' : res.next.days + '日',
        expText,
        res.alerts.join('\n')
      ]);

      res.grants.forEach(function (b) {
        var rem = b.grantedH - b.usedH - b.expiredH - b.cutH;
        var state = b.expired ? (b.expiredH > EPS ? '時効消滅' : '期間満了') : (rem > EPS ? '有効' : '使い切り');
        grantRows.push([
          e.id, e.name, b.date, serviceLabel(b.k, cfg), b.days + '日', b.expire,
          fmtDH(b.usedH, H), b.expiredH > EPS ? fmtDH(b.expiredH, H) : '', b.cutH > EPS ? fmtDH(b.cutH, H) : '',
          b.expired ? '' : fmtDH(rem, H), state
        ]);
      });
    });

    return { summaryRows: summaryRows, grantRows: grantRows, judgements: judgements, results: results, cfg: cfg };
  }

  // ---------------------------------------------------------------- ダミーデータ（実在の人物・組織とは無関係）

  /**
   * 計算基準日 today から逆算したダミーデータ。いつ setup しても各機能（比例付与・時間単位の上限・
   * 時効警告・年5日義務・付与前）が画面に現れるよう、日付はすべて相対で作る。
   */
  function buildSampleData(today) {
    var cfg = DEFAULT_CONFIG;
    /** k 回目（0始まり）の付与を受けた期間の途中で、次の付与まで daysToNext 日になる入社日 */
    function hireFor(k, daysToNext) { return addMonths(addDays(today, daysToNext), -(cfg.firstGrantMonths + 12 * (k + 1))); }

    var employees = [
      { id: 'E001', name: '山田 太郎', hire: hireFor(6, 200), weekDays: 5, weekHours: 40, dailyHours: 8, note: 'フルタイム・勤続6.5年以上（20日付与）' },
      { id: 'E002', name: '佐藤 花子', hire: hireFor(1, 60), weekDays: 5, weekHours: 37.5, dailyHours: 7.5, note: '1日7.5時間 → 時間単位は8時間で1日に換算' },
      { id: 'E003', name: '鈴木 一郎', hire: hireFor(3, 250), weekDays: 4, weekHours: 24, dailyHours: 6, note: '週4日・週30時間未満 → 比例付与' },
      { id: 'E004', name: '田中 美咲', hire: hireFor(4, 30), weekDays: 3, weekHours: 15, dailyHours: 5, note: '週3日 → 比例付与（10日未満なので年5日義務は対象外）' },
      { id: 'E005', name: '松本 健太', hire: addMonths(today, -4), weekDays: 5, weekHours: 40, dailyHours: 8, note: '入社6か月未満（初回付与前）' },
      { id: 'E006', name: '渡辺 さくら', hire: hireFor(0, 300), weekDays: 4, weekHours: 32, dailyHours: 8, note: '週4日だが週30時間以上 → 通常付与' }
    ];
    var hireOf = {};
    employees.forEach(function (e) { hireOf[e.id] = e.hire; });

    var records = [];
    function add(id, k, offset, type, hours, note) {
      records.push({ empId: id, date: addDays(grantDate(hireOf[id], k, cfg), offset), type: type, hours: hours || '', note: note || '' });
    }
    // E001: 前期間に8日、今期に全日4日＋半日2回（＝年5日達成）、2週間後に予定1件
    [15, 40, 80, 120, 160, 200, 240, 300].forEach(function (o) { add('E001', 5, o, '全日'); });
    [10, 30, 60, 90].forEach(function (o) { add('E001', 6, o, '全日'); });
    add('E001', 6, 100, '半日'); add('E001', 6, 130, '半日');
    records.push({ empId: 'E001', date: addDays(today, 14), type: '全日', hours: '', note: '取得予定' });

    // E002: 前期間5日（達成）。今期は時間単位を36時間使い、さらに6時間で上限（5日×8時間＝40時間）超え
    [20, 60, 100, 150, 200].forEach(function (o) { add('E002', 0, o, '全日'); });
    [[10, 4], [40, 4], [70, 5], [100, 3], [130, 6], [160, 4], [190, 5], [220, 5]].forEach(function (x) { add('E002', 1, x[0], '時間', x[1], '通院'); });
    add('E002', 1, 240, '全日'); add('E002', 1, 260, '全日');
    add('E002', 1, 280, '時間', 6, '（デモ：時間単位の上限超過の例）');

    // E003: 比例付与・今期10日付与（義務対象）で 2.5日取得（期限はまだ先）
    [30, 90, 200].forEach(function (o) { add('E003', 2, o, '全日'); });
    add('E003', 3, 20, '全日'); add('E003', 3, 50, '全日'); add('E003', 3, 80, '半日');

    // E004: 古い付与分の一部が時効消滅済み＋繰越分が30日後に時効消滅見込み
    add('E004', 2, 100, '全日');
    [40, 120, 250].forEach(function (o) { add('E004', 3, o, '全日'); });
    add('E004', 4, 60, '全日'); add('E004', 4, 200, '全日');

    // E005: 初回付与より前の日付（エラー表示の例）
    records.push({ empId: 'E005', date: addDays(today, -30), type: '全日', hours: '', note: '（デモ：付与前の例）' });

    // E006: 週4日×8時間（通常付与）
    add('E006', 0, 20, '全日'); add('E006', 0, 45, '半日');

    return { employees: employees, records: records };
  }

  return {
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    SUMMARY_HEADERS: SUMMARY_HEADERS,
    GRANT_HEADERS: GRANT_HEADERS,
    mergeConfig: mergeConfig,
    grantCategory: grantCategory,
    hoursPerDay: hoursPerDay,
    computeEmployee: computeEmployee,
    computeAll: computeAll,
    buildSampleData: buildSampleData,
    fmtDH: fmtDH,
    addMonths: addMonths,
    addDays: addDays,
    diffDays: diffDays,
    isYmd: isYmd,
    maskEmail: maskEmail
  };
})();

// Node（テスト）から読み込むとき用。Apps Script では module が無いので何もしない。
if (typeof module !== 'undefined' && module.exports) module.exports = LeaveCalc;
