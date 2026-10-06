#!/usr/bin/env node
'use strict';

/**
 * 計算ロジック（LeaveCalc.gs）の手元テスト。Google にはつながない。
 *
 *   node test/leave-calc.test.js            # 既定: いくつかの基準日でダミーデータを計算して検証
 *   node test/leave-calc.test.js --print    # 2026-10-01 時点の「残日数一覧」を表示して目で確かめる
 */

const assert = require('assert');
const path = require('path');
const LeaveCalc = require(path.join(__dirname, '..', 'LeaveCalc.gs'));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('ok   ' + name);
  } catch (err) {
    console.error('FAIL ' + name);
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  }
}

/** シートに書いて読み戻したのと同じ形（row 付き）にする */
function sample(today) {
  const data = LeaveCalc.buildSampleData(today);
  data.records = data.records.map((r, i) => Object.assign({ row: i + 2 }, r));
  return data;
}
function resultOf(out, id) { return out.results.find((r) => r.emp.id === id); }
function judgementsOf(out, data, id) {
  return data.records.filter((r) => r.empId === id).map((r) => out.judgements[r.row].msg);
}

// ------------------------------------------------------------------ 日付・区分の基礎

test('6か月後の応当日（応当日が無い月は翌月1日）', () => {
  assert.strictEqual(LeaveCalc.addMonths('2025-04-01', 6), '2025-10-01');
  assert.strictEqual(LeaveCalc.addMonths('2025-08-31', 6), '2026-03-01');
  assert.strictEqual(LeaveCalc.addMonths('2024-02-29', 24), '2026-03-01');
  assert.strictEqual(LeaveCalc.addMonths('2026-03-15', -18), '2024-09-15');
});

test('日付の判定: 形が YYYY-MM-DD でも暦上あり得ない日付は弾く', () => {
  ['2026-02-28', '2024-02-29', '2026-04-30', '2026-12-31'].forEach((d) => assert.strictEqual(LeaveCalc.isYmd(d), true, d));
  ['2026-02-30', '2025-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00', '2026-1-1', '', null, undefined]
    .forEach((d) => assert.strictEqual(LeaveCalc.isYmd(d), false, String(d)));
});

test('付与区分: 週30時間以上 または 週5日以上は通常付与', () => {
  const cfg = LeaveCalc.mergeConfig();
  assert.strictEqual(LeaveCalc.grantCategory({ weekDays: 4, weekHours: 32 }, cfg), 'normal');
  assert.strictEqual(LeaveCalc.grantCategory({ weekDays: 5, weekHours: 25 }, cfg), 'normal');
  assert.strictEqual(LeaveCalc.grantCategory({ weekDays: 4, weekHours: 24 }, cfg), 'w4');
  assert.strictEqual(LeaveCalc.grantCategory({ weekDays: 1, weekHours: 6 }, cfg), 'w1');
  assert.strictEqual(LeaveCalc.grantCategory({ weekDays: 0, weekHours: 0 }, cfg), 'none');
});

test('時間単位の1日 = 1日の所定労働時間を切り上げ（7.5時間→8時間）', () => {
  assert.strictEqual(LeaveCalc.hoursPerDay({ dailyHours: 7.5 }), 8);
  assert.strictEqual(LeaveCalc.hoursPerDay({ dailyHours: 8 }), 8);
  assert.strictEqual(LeaveCalc.hoursPerDay({ weekDays: 4, weekHours: 26 }), 7);
});

test('更新履歴の編集者メールは伏せ字（先頭1文字＋***＋ドメイン）、取れなければ（不明）', () => {
  assert.strictEqual(LeaveCalc.maskEmail('nanashi@gmail.com'), 'n***@gmail.com');
  assert.strictEqual(LeaveCalc.maskEmail(' a@example.co.jp '), 'a***@example.co.jp');
  assert.strictEqual(LeaveCalc.maskEmail(''), '（不明）');
  assert.strictEqual(LeaveCalc.maskEmail(null), '（不明）');
  assert.strictEqual(LeaveCalc.maskEmail(undefined), '（不明）');
  assert.strictEqual(LeaveCalc.maskEmail('no-at-mark'), '（不明）');
  assert.strictEqual(LeaveCalc.maskEmail('@gmail.com'), '（不明）');
  assert.strictEqual(LeaveCalc.maskEmail('nanashi@'), '（不明）');
});

// ------------------------------------------------------------------ 単体シナリオ

const FULL = { id: 'T1', name: 'テスト', hire: '2020-04-01', weekDays: 5, weekHours: 40, dailyHours: 8 };

test('法定付与日数: 0.5年10日 → 6.5年以上20日', () => {
  const r = LeaveCalc.computeEmployee(FULL, [], '2027-10-01', LeaveCalc.mergeConfig());
  assert.deepStrictEqual(r.grants.map((g) => g.days), [10, 11, 12, 14, 16, 18, 20, 20]);
  assert.strictEqual(r.grants[0].date, '2020-10-01');
});

test('付与から2年で時効消滅し、同じ日に新しい付与が入る（保有は最大40日）', () => {
  const r = LeaveCalc.computeEmployee(FULL, [], '2027-10-01', LeaveCalc.mergeConfig());
  // 2027-10-01 時点で有効なのは 2026-10-01（20日）と 2027-10-01（20日）
  assert.strictEqual(r.remainingH, 40 * 8);
  const expired = r.grants.filter((g) => g.expired);
  assert.strictEqual(expired.length, 6);
  assert.ok(expired.every((g) => g.expiredH === g.grantedH));
  assert.ok(r.grants.every((g) => g.cutH === 0), '法定どおりなら上限切り捨ては発動しない');
});

test('付与日数を法定より多く設定すると、保有上限を超えた分を古い付与から切り捨て', () => {
  const cfg = LeaveCalc.mergeConfig({ table: { normal: [25, 25, 25, 25, 25, 25, 25] } });
  const r = LeaveCalc.computeEmployee(FULL, [], '2021-10-01', cfg);
  assert.strictEqual(r.remainingH, 40 * 8);
  assert.strictEqual(r.grants[0].cutH, 10 * 8);
  assert.ok(r.alerts.some((a) => a.includes('切り捨て')));
});

test('古い付与（繰越分）から先に使う', () => {
  const recs = [{ row: 2, empId: 'T1', date: '2021-11-01', type: '全日' }];
  const r = LeaveCalc.computeEmployee(FULL, recs, '2021-12-01', LeaveCalc.mergeConfig());
  assert.strictEqual(r.grants[0].usedH, 8);
  assert.strictEqual(r.grants[1].usedH, 0);
});

test('残日数が足りない取得は計上しない', () => {
  const recs = [];
  for (let i = 0; i < 11; i++) recs.push({ row: 2 + i, empId: 'T1', date: LeaveCalc.addDays('2020-11-01', i), type: '全日' });
  const r = LeaveCalc.computeEmployee(FULL, recs, '2021-03-01', LeaveCalc.mergeConfig());
  assert.ok(r.judgements[12].startsWith('✖ 残日数が足りません'));
  assert.strictEqual(r.remainingH, 0);
});

test('暦上あり得ない取得日（2月30日など）は計上しない', () => {
  const recs = [{ row: 2, empId: 'T1', date: '2021-02-30', type: '全日' }];
  const r = LeaveCalc.computeEmployee(FULL, recs, '2021-03-10', LeaveCalc.mergeConfig());
  assert.ok(r.judgements[2].startsWith('✖'));
  assert.strictEqual(r.grants[0].usedH, 0);
});

test('年5日取得義務: 半日は0.5日、時間単位は数えない', () => {
  const recs = [
    { row: 2, empId: 'T1', date: '2020-11-02', type: '全日' },
    { row: 3, empId: 'T1', date: '2020-11-03', type: '半日' },
    { row: 4, empId: 'T1', date: '2020-11-04', type: '時間', hours: 4 }
  ];
  const r = LeaveCalc.computeEmployee(FULL, recs, '2021-08-01', LeaveCalc.mergeConfig());
  assert.strictEqual(r.obligation.applies, true);
  assert.strictEqual(r.obligation.taken, 1.5);
  assert.strictEqual(r.obligation.deadline, '2021-09-30');
  assert.ok(r.alerts.some((a) => a.includes('年5日取得義務')));
});

// ------------------------------------------------------------------ ダミーデータ（複数の基準日で）

const TODAYS = ['2026-10-01', '2026-01-31', '2027-02-28', '2028-02-29', '2026-12-31'];

for (const today of TODAYS) {
  test(`ダミーデータの見どころがそろう（基準日 ${today}）`, () => {
    const data = sample(today);
    const out = LeaveCalc.computeAll(data.employees, data.records, today);

    // 全員: 残はマイナスにならない・付与の内訳が合う
    out.results.forEach((r) => {
      assert.ok(r.remainingH >= 0, r.emp.id + ' の残がマイナス');
      r.grants.forEach((g) => assert.ok(g.grantedH - g.usedH - g.expiredH - g.cutH > -1e-9, r.emp.id + ' の付与内訳が合わない'));
    });

    const e1 = resultOf(out, 'E001');
    assert.strictEqual(e1.category, 'normal');
    assert.strictEqual(e1.current.days, 20);
    assert.ok(e1.current.carryInH > 0, 'E001 に繰越がある');
    assert.strictEqual(e1.obligation.met, true, 'E001 は年5日達成');
    assert.ok(judgementsOf(out, data, 'E001').some((m) => m.startsWith('予定')));

    const e2 = resultOf(out, 'E002');
    assert.strictEqual(e2.H, 8);
    assert.strictEqual(e2.current.hourlyH, 36);
    assert.ok(judgementsOf(out, data, 'E002').some((m) => m.includes('時間単位年休の上限')));
    assert.strictEqual(e2.obligation.met, false);
    assert.ok(e2.alerts.some((a) => a.includes('年5日取得義務')), 'E002 は義務期限が近いアラート');

    const e3 = resultOf(out, 'E003');
    assert.strictEqual(e3.category, 'w4');
    assert.strictEqual(e3.current.days, 10);
    assert.strictEqual(e3.obligation.applies, true);
    assert.strictEqual(e3.obligation.taken, 2.5);

    const e4 = resultOf(out, 'E004');
    assert.strictEqual(e4.category, 'w3');
    assert.strictEqual(e4.obligation.applies, false);
    assert.ok(e4.grants.some((g) => g.expiredH > 0), 'E004 に時効消滅した付与がある');
    assert.ok(e4.alerts.some((a) => a.includes('時効で消滅見込み')), 'E004 に時効警告');

    const e5 = resultOf(out, 'E005');
    assert.strictEqual(e5.current, null);
    assert.ok(judgementsOf(out, data, 'E005')[0].includes('初回付与'));

    const e6 = resultOf(out, 'E006');
    assert.strictEqual(e6.category, 'normal');
    assert.strictEqual(e6.current.days, 10);

    // 表の形
    assert.ok(out.summaryRows.every((row) => row.length === LeaveCalc.SUMMARY_HEADERS.length));
    assert.ok(out.grantRows.every((row) => row.length === LeaveCalc.GRANT_HEADERS.length));
  });
}

if (process.argv.includes('--print')) {
  const today = '2026-10-01';
  const data = sample(today);
  const out = LeaveCalc.computeAll(data.employees, data.records, today);
  console.log('\n--- 残日数一覧（' + today + ' 時点）');
  console.log(LeaveCalc.SUMMARY_HEADERS.join(' | '));
  out.summaryRows.forEach((row) => console.log(row.map((v) => String(v).replace(/\n/g, ' / ')).join(' | ')));
  console.log('\n--- 付与履歴');
  out.grantRows.forEach((row) => console.log(row.join(' | ')));
  console.log('\n--- 取得記録の判定');
  data.records.forEach((r) => console.log(r.empId, r.date, r.type, r.hours, '→', out.judgements[r.row].msg));
}

console.log(`\n${passed} 件 OK`);
