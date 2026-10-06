/**
 * 有給休暇管理シート（GAS版・デモ）
 *
 * ■ かんたんセットアップ（推奨・1クリック）
 *   1) 新しい Google スプレッドシートを作り「拡張機能 > Apps Script」を開く
 *   2) この Code.gs と LeaveCalc.gs を貼る（ファイルは2つ。名前もそのまま）
 *   3) 関数一覧から setup を選んで▶実行 → 初回だけ認可を「許可」
 *      → タブ（残日数一覧・取得記録・職員マスタ・付与履歴・設定・更新履歴・使い方）、ダミーデータ、
 *        入力欄以外の保護、編集時トリガー・毎朝の再計算トリガーが一括で作られる
 *
 * ■ コピーして使う場合（「ファイル > コピーを作成」）
 *   スクリプトはコピーに付いてくるが、トリガーと保護の持ち主は引き継がれない。
 *   コピーを開いたら、メニュー「有給管理 > 初期設定（コピー後に1回）」を1回実行する。
 *
 * ■ 設計の考え方
 *   - 計算は LeaveCalc.gs（純粋関数）に分離。シートの読み書きはこのファイルだけ
 *     → 計算の正しさを Node のテストで手元確認できる（test/leave-calc.test.js）
 *   - 人が入力するのは「職員マスタ」「取得記録」「設定」の入力欄だけ。それ以外は保護して自動計算
 *   - 入力の変更は「更新履歴」に自動で残す（誰が・いつ・どのセルを・何から何へ）
 *   - 編集トリガーは「インストール型」（持ち主の権限で動く）。単純トリガー onEdit だと、
 *     持ち主以外が編集したとき保護された計算欄・履歴に書けないため
 *   - 付与日数や上限は「設定」タブで変えられる（就業規則に合わせて調整する前提）
 */

var SHEET = {
  SUMMARY: '残日数一覧',
  RECORDS: '取得記録',
  STAFF: '職員マスタ',
  GRANTS: '付与履歴',
  SETTINGS: '設定',
  LOG: '更新履歴',
  HELP: '使い方'
};
var SHEET_ORDER = [SHEET.HELP, SHEET.SUMMARY, SHEET.RECORDS, SHEET.STAFF, SHEET.GRANTS, SHEET.LOG, SHEET.SETTINGS];
var INPUT_SHEETS = [SHEET.STAFF, SHEET.RECORDS, SHEET.SETTINGS];

var STAFF_HEADERS = ['職員ID', '氏名', '入社日', '週所定労働日数', '週所定労働時間', '1日の所定労働時間', '備考'];
var RECORD_HEADERS = ['職員ID', '取得日', '区分（全日/半日/時間）', '時間数（時間のとき）', '備考', '氏名（自動）', '判定（自動）'];
var RECORD_INPUT_COLS = 5;  // A〜E が入力欄、F・G は自動
var LOG_HEADERS = ['日時', '編集者', 'シート', 'セル', '変更前', '変更後'];

/** 設定タブ: [項目名, キー, 既定値, 説明]。読み込みは A列の項目名で照合する（行がずれても壊れない）。 */
var SETTING_DEFS = [
  ['計算基準日', 'today', '', '空欄＝今日。日付を入れると、その日時点で計算します'],
  ['保有上限', 'maxHoldDays', 40, '付与の時点で保有がこれを超えたら、古い付与から切り捨て。法定どおりの付与なら最大20＋20＝40日なので発動しません（法定を上回る付与をするとき用）。40未満にすると法定分を切り捨てることになるので注意'],
  ['時効（年）', 'expireYears', 2, '付与日から2年で消滅（労基法115条）'],
  ['時間単位年休の上限（日/年）', 'hourlyCapDays', 5, '年5日以内・繰越分を含む（労基法39条4項）。導入には労使協定が必要'],
  ['警告を出す日数（日前）', 'warnDays', 90, '時効消滅・年5日義務の期限がこの日数以内に迫ったらアラート'],
  ['年5日義務の対象（付与日数がこれ以上）', 'obligationMinGrant', 10, '年10日以上付与される人が対象（労基法39条7項）'],
  ['年5日義務の日数', 'obligationDays', 5, '付与日（基準日）から1年以内に取得させる日数。半日は0.5日、時間単位は数えない'],
  ['初回付与（入社から何か月後）', 'firstGrantMonths', 6, '6か月継続勤務・出勤率8割以上で付与（労基法39条1項）。出勤率は満たしている前提で計算'],
  ['通常付与となる週所定労働時間（以上）', 'normalWeekHours', 30, 'これ以上なら日数に関係なく通常付与'],
  ['通常付与となる週所定労働日数（以上）', 'normalWeekDays', 5, 'これ以上なら通常付与。未満かつ時間も未満なら比例付与（労基法施行規則24条の3）']
];
var TABLE_HEADER = ['勤続年数', '通常', '週4日', '週3日', '週2日', '週1日'];
var TABLE_KEYS = ['normal', 'w4', 'w3', 'w2', 'w1'];
var TABLE_ROW_LABELS = ['0.5年', '1.5年', '2.5年', '3.5年', '4.5年', '5.5年', '6.5年以上'];

var PROTECT_TAG = '[yukyu-demo]';
var PROP_SS_ID = 'YUKYU_DEMO_SPREADSHEET_ID';

// ====================================================================== メニュー・セットアップ

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('有給管理')
    .addItem('再計算', 'recalc')
    .addItem('初期設定（コピー後に1回）', 'initAfterCopy')
    .addToUi();
}

/**
 * 1クリックの初期セットアップ。タブ・ダミーデータ・保護・トリガーをまとめて作る。
 * 何度実行してもよい（入力済みのデータ・設定は上書きしない。職員マスタが空のときだけダミーを入れる）。
 */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) ss = SpreadsheetApp.create('有給休暇管理（デモ）');  // スタンドアロンで実行した場合
  PropertiesService.getScriptProperties().setProperty(PROP_SS_ID, ss.getId());

  buildSheets_(ss);
  var staffSheet = ss.getSheetByName(SHEET.STAFF);
  if (staffSheet.getLastRow() < 2) writeSampleData_(ss);
  initialize_(ss, 'setup を実行（タブ・保護・トリガーを作成）');

  var msg = [
    '✅ セットアップ完了',
    'スプレッドシート: ' + ss.getUrl(),
    '→「取得記録」に1行足すと、数秒で「残日数一覧」が更新され「更新履歴」に記録されます'
  ].join('\n');
  Logger.log(msg);
  return msg;
}

/** コピーしたシートで1回実行する。トリガーと保護を自分の持ち物として作り直す（データは触らない）。 */
function initAfterCopy() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().setProperty(PROP_SS_ID, ss.getId());
  buildSheets_(ss);
  initialize_(ss, '初期設定を実行（コピー後）');
  SpreadsheetApp.getUi().alert('初期設定が完了しました。以後、入力すると自動で再計算されます。');
}

function initialize_(ss, logMessage) {
  installTriggers_(ss);
  applyProtections_(ss);
  logSystem_(ss, logMessage);
  recalc();
}

/** 何度実行してもトリガーが増えないよう、既存分を消してから作る。 */
function installTriggers_(ss) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'handleEdit' || f === 'recalc') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('handleEdit').forSpreadsheet(ss).onEdit().create();
  // 日付が進むと時効・義務期限のアラートが変わるため、毎朝再計算する
  ScriptApp.newTrigger('recalc').timeBased().everyDays(1).atHour(6).create();
}

// ====================================================================== シートの組み立て

function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  var created = false;
  if (!sh) {
    // 新規スプレッドシートの既定の空シート（シート1 / Sheet1）があれば流用する
    var reusable = ss.getSheets().filter(function (s) {
      var n = s.getName();
      return (n === 'シート1' || n === 'Sheet1') && s.getLastRow() === 0 && s.getLastColumn() === 0;
    })[0];
    if (reusable) {
      sh = reusable;
      sh.setName(name);
    } else {
      // insertSheet をインデックス無しで呼ぶと稀に "Sheet 0 not found" になるため明示する
      sh = ss.insertSheet(name, ss.getNumSheets());
    }
    created = true;
  }
  if (headers && sh.getRange(1, 1).getValue() === '') {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#e8f0fe');
    sh.setFrozenRows(1);
  }
  return { sheet: sh, created: created };
}

function buildSheets_(ss) {
  var staff = ensureSheet_(ss, SHEET.STAFF, STAFF_HEADERS).sheet;
  var records = ensureSheet_(ss, SHEET.RECORDS, RECORD_HEADERS).sheet;
  var summary = ensureSheet_(ss, SHEET.SUMMARY, LeaveCalc.SUMMARY_HEADERS).sheet;
  var grants = ensureSheet_(ss, SHEET.GRANTS, LeaveCalc.GRANT_HEADERS).sheet;
  var log = ensureSheet_(ss, SHEET.LOG, LOG_HEADERS).sheet;
  var settings = ensureSheet_(ss, SHEET.SETTINGS, ['項目', '値', '説明']);
  var help = ensureSheet_(ss, SHEET.HELP, null);

  if (settings.created) writeDefaultSettings_(settings.sheet);
  if (help.created) writeHelp_(help.sheet);

  // 入力規則（入力ミスを入口で止める）。行数は各シートの最終行まで（範囲外を指定しない）
  var n = staff.getMaxRows() - 1;
  staff.getRange(2, 3, n, 1).setNumberFormat('yyyy-mm-dd')
    .setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).setHelpText('日付を入力（例: 2024-04-01）').build());
  staff.getRange(2, 4, n, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireNumberBetween(0, 7).setAllowInvalid(false).build());
  staff.getRange(2, 5, n, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireNumberBetween(0, 80).setAllowInvalid(false).build());
  staff.getRange(2, 6, n, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireNumberBetween(0.5, 24).setAllowInvalid(false).build());

  n = records.getMaxRows() - 1;
  records.getRange(2, 1, n, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInRange(staff.getRange('A2:A'), true).setAllowInvalid(false).build());
  records.getRange(2, 2, n, 1).setNumberFormat('yyyy-mm-dd')
    .setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build());
  records.getRange(2, 3, n, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['全日', '半日', '時間'], true).setAllowInvalid(false).build());
  records.getRange(2, 4, n, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireNumberBetween(1, 23).setAllowInvalid(false)
    .setHelpText('区分が「時間」のときだけ。1日の所定労働時間未満の整数').build());
  records.getRange(2, 6, n, 2).setBackground('#f3f3f3');

  // 計算結果は文字列で書く（日付の自動変換で表示が揺れないように）
  n = summary.getMaxRows() - 1;
  summary.getRange(2, 1, n, LeaveCalc.SUMMARY_HEADERS.length).setNumberFormat('@').setVerticalAlignment('top');
  summary.getRange(2, 8, n, 2).setNumberFormat('0.##');
  summary.getRange(2, LeaveCalc.SUMMARY_HEADERS.length, n, 1).setWrap(true);
  summary.setColumnWidth(LeaveCalc.SUMMARY_HEADERS.length, 360);
  grants.getRange(2, 1, grants.getMaxRows() - 1, LeaveCalc.GRANT_HEADERS.length).setNumberFormat('@');
  records.getRange(2, 7, records.getMaxRows() - 1, 1).setWrap(true);
  records.setColumnWidth(7, 360);
  log.getRange(2, 1, log.getMaxRows() - 1, LOG_HEADERS.length).setNumberFormat('@');

  // タブの並びを整え、初期の空シート（シート1 等）を片付ける
  SHEET_ORDER.forEach(function (name, i) {
    var sh = ss.getSheetByName(name);
    ss.setActiveSheet(sh);
    ss.moveActiveSheet(i + 1);
  });
  ss.getSheets().forEach(function (sh) {
    if (SHEET_ORDER.indexOf(sh.getName()) < 0 && sh.getLastRow() === 0 && sh.getLastColumn() === 0) ss.deleteSheet(sh);
  });
  ss.setActiveSheet(summary);
}

function writeDefaultSettings_(sh) {
  var rows = SETTING_DEFS.map(function (d) { return [d[0], d[2], d[3]]; });
  sh.getRange(2, 1, rows.length, 3).setValues(rows);
  var tableTop = rows.length + 3;
  sh.getRange(tableTop - 1, 1).setValue('▼ 付与日数テーブル（入社6か月後の付与から1年ごと。就業規則に合わせて変更可）').setFontWeight('bold');
  sh.getRange(tableTop, 1, 1, TABLE_HEADER.length).setValues([TABLE_HEADER]).setFontWeight('bold').setBackground('#e8f0fe');
  var t = LeaveCalc.DEFAULT_CONFIG.table;
  var body = TABLE_ROW_LABELS.map(function (label, i) {
    return [label].concat(TABLE_KEYS.map(function (k) { return t[k][i]; }));
  });
  sh.getRange(tableTop + 1, 1, body.length, TABLE_HEADER.length).setValues(body);
  sh.getRange(2, 2, rows.length, 1).setBackground('#fff8e1');
  sh.getRange(tableTop + 1, 2, body.length, TABLE_KEYS.length).setBackground('#fff8e1');
  sh.getRange(2, 2).setNumberFormat('yyyy-mm-dd');
  sh.setColumnWidth(1, 300);
  sh.setColumnWidth(3, 560);
  sh.getRange(2, 3, rows.length, 1).setWrap(true);
}

function writeHelp_(sh) {
  var lines = [
    ['有給休暇管理シート（デモ）の使い方'],
    [''],
    ['1. 「職員マスタ」に職員を登録（入社日・週所定労働日数・週所定労働時間・1日の所定労働時間）'],
    ['2. 休みを取ったら「取得記録」に1行追加（職員ID・取得日・区分〔全日/半日/時間〕・時間数）'],
    ['3. 「残日数一覧」が自動で更新されます（付与日数・繰越・残・時間単位の使用量・年5日義務・時効の見込み・アラート）'],
    ['4. 付与ごとの内訳（使用・時効消滅・切り捨て）は「付与履歴」で確認できます'],
    ['5. 入力の変更は「更新履歴」に自動で記録されます'],
    [''],
    ['・色の付いた入力欄以外は保護されています（計算結果を誤って消さないため）'],
    ['・付与日数や上限は「設定」タブで変更できます。実際の運用は就業規則・労使協定に合わせて調整してください'],
    ['・コピーして使うときは、メニュー「有給管理 > 初期設定（コピー後に1回）」を実行してください'],
    ['・登録されている職員はすべて架空のダミーデータです']
  ];
  sh.getRange(1, 1, lines.length, 1).setValues(lines);
  sh.getRange(1, 1).setFontWeight('bold').setFontSize(13);
  sh.setColumnWidth(1, 900);
}

function writeSampleData_(ss) {
  var tz = ss.getSpreadsheetTimeZone();
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var data = LeaveCalc.buildSampleData(today);
  // 日付はシートのタイムゾーンの0時として Date にしてから入れる（1日ずれ防止）
  function d(ymd) { return Utilities.parseDate(ymd, tz, 'yyyy-MM-dd'); }
  var staffRows = data.employees.map(function (e) {
    return [e.id, e.name, d(e.hire), e.weekDays, e.weekHours, e.dailyHours, e.note];
  });
  ss.getSheetByName(SHEET.STAFF).getRange(2, 1, staffRows.length, STAFF_HEADERS.length).setValues(staffRows);
  var recRows = data.records.map(function (r) { return [r.empId, d(r.date), r.type, r.hours, r.note]; });
  ss.getSheetByName(SHEET.RECORDS).getRange(2, 1, recRows.length, RECORD_INPUT_COLS).setValues(recRows);
  logSystem_(ss, 'ダミーデータを投入（職員' + staffRows.length + '名・取得記録' + recRows.length + '件）');
}

// ====================================================================== 保護

function inputRanges_(sh) {
  var name = sh.getName();
  var maxRows = sh.getMaxRows();
  if (name === SHEET.STAFF) return [sh.getRange(2, 1, maxRows - 1, STAFF_HEADERS.length)];
  if (name === SHEET.RECORDS) return [sh.getRange(2, 1, maxRows - 1, RECORD_INPUT_COLS)];
  if (name === SHEET.SETTINGS) {
    var ranges = [sh.getRange(2, 2, SETTING_DEFS.length, 1)];
    var top = findTableTop_(sh);
    if (top) ranges.push(sh.getRange(top + 1, 2, TABLE_ROW_LABELS.length, TABLE_KEYS.length));
    return ranges;
  }
  return [];
}

/** 入力欄以外を保護する。編集できるのは実行した人（持ち主）だけ。何度実行しても重複しない。 */
function applyProtections_(ss) {
  var me = Session.getEffectiveUser();
  ss.getSheets().forEach(function (sh) {
    if (SHEET_ORDER.indexOf(sh.getName()) < 0) return;
    sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function (p) {
      if (String(p.getDescription()).indexOf(PROTECT_TAG) === 0 && p.canEdit()) p.remove();
    });
    var p = sh.protect().setDescription(PROTECT_TAG + ' 入力欄以外は自動計算のため保護');
    var inputs = inputRanges_(sh);
    if (inputs.length) p.setUnprotectedRanges(inputs);
    p.addEditor(me);
    p.removeEditors(p.getEditors());
    if (p.canDomainEdit()) p.setDomainEdit(false);
  });
}

// ====================================================================== 編集時・再計算

/** インストール型の編集トリガーから呼ばれる（setup / 初期設定 で設置）。 */
function handleEdit(e) {
  if (!e || !e.range) return;
  var name = e.range.getSheet().getName();
  if (INPUT_SHEETS.indexOf(name) < 0) return;
  logEdit_(e);
  recalc();
}

function getSs_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) return ss;
  var id = PropertiesService.getScriptProperties().getProperty(PROP_SS_ID);
  return id ? SpreadsheetApp.openById(id) : null;
}

/** 入力を読み、LeaveCalc で計算し、残日数一覧・付与履歴・取得記録の判定欄に書く。 */
function recalc() {
  var ss = getSs_();
  if (!ss) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;  // 連続編集で重なったら後の実行に任せる
  try {
    var tz = ss.getSpreadsheetTimeZone();
    var settings = readSettings_(ss, tz);
    var employees = readStaff_(ss, tz);
    var recordsSheet = ss.getSheetByName(SHEET.RECORDS);
    var records = readRecords_(recordsSheet, tz);
    var out = LeaveCalc.computeAll(employees, records.list, settings.today, settings.cfg);

    var summary = ss.getSheetByName(SHEET.SUMMARY);
    writeTable_(summary, out.summaryRows, LeaveCalc.SUMMARY_HEADERS.length);
    paintAlerts_(summary, out.summaryRows.map(function (r) { return r[r.length - 1]; }), LeaveCalc.SUMMARY_HEADERS.length);
    summary.getRange(1, 1).setNote('最終計算: ' + Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm') + '（計算基準日 ' + settings.today + '）');

    writeTable_(ss.getSheetByName(SHEET.GRANTS), out.grantRows, LeaveCalc.GRANT_HEADERS.length);

    // 取得記録の F（氏名）・G（判定）
    var lastRow = Math.max(records.lastRow, 1);
    var maxRows = recordsSheet.getMaxRows();
    recordsSheet.getRange(2, RECORD_INPUT_COLS + 1, maxRows - 1, 2).clearContent().setBackground('#f3f3f3');
    if (lastRow >= 2) {
      var fg = [];
      for (var row = 2; row <= lastRow; row++) {
        var j = out.judgements[row];
        fg.push(j ? [safeCell_(j.name), j.msg] : ['', '']);  // 氏名は職員マスタの入力値＝数式として解釈されないように
      }
      recordsSheet.getRange(2, RECORD_INPUT_COLS + 1, fg.length, 2).setValues(fg);
      paintAlerts_(recordsSheet, fg.map(function (r) { return r[1]; }), RECORD_INPUT_COLS + 2, '#f3f3f3');
    }
  } finally {
    lock.releaseLock();
  }
}

function writeTable_(sh, rows, width) {
  var maxRows = sh.getMaxRows();
  if (maxRows > 1) sh.getRange(2, 1, maxRows - 1, width).clearContent().setBackground(null);
  if (rows.length) sh.getRange(2, 1, rows.length, width).setValues(rows);
}

function paintAlerts_(sh, texts, col, normalColor) {
  if (!texts.length) return;
  var colors = texts.map(function (t) {
    t = String(t || '');
    if (t.indexOf('✖') >= 0) return ['#f4cccc'];
    if (t.indexOf('⚠') >= 0) return ['#fff2cc'];
    return [normalColor || null];
  });
  sh.getRange(2, col, colors.length, 1).setBackgrounds(colors);
}

// ====================================================================== 読み込み

function toYmd_(v, tz) {
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  var s = String(v == null ? '' : v).trim().replace(/\//g, '-');
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return '';
  return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}

function readStaff_(ss, tz) {
  var sh = ss.getSheetByName(SHEET.STAFF);
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, STAFF_HEADERS.length).getValues()
    .filter(function (r) { return String(r[0]).trim() !== ''; })
    .map(function (r) {
      return {
        id: String(r[0]).trim(), name: String(r[1]).trim(), hire: toYmd_(r[2], tz),
        weekDays: Number(r[3]) || 0, weekHours: Number(r[4]) || 0, dailyHours: Number(r[5]) || 0
      };
    });
}

function readRecords_(sh, tz) {
  var last = sh.getLastRow();
  var list = [];
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, RECORD_INPUT_COLS).getValues().forEach(function (r, i) {
      var empty = r.every(function (v) { return String(v).trim() === ''; });
      if (empty) return;
      list.push({ row: i + 2, empId: String(r[0]).trim(), date: toYmd_(r[1], tz), type: String(r[2]).trim(), hours: r[3] });
    });
  }
  return { list: list, lastRow: last };
}

function findTableTop_(sh) {
  var last = sh.getLastRow();
  if (last < 1) return 0;
  var col = sh.getRange(1, 1, last, 1).getValues();
  for (var i = 0; i < col.length; i++) if (String(col[i][0]).trim() === TABLE_HEADER[0]) return i + 1;
  return 0;
}

function readSettings_(ss, tz) {
  var sh = ss.getSheetByName(SHEET.SETTINGS);
  var cfg = {};
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var last = sh.getLastRow();
  if (last >= 2) {
    var byLabel = {};
    sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) { byLabel[String(r[0]).trim()] = r[1]; });
    SETTING_DEFS.forEach(function (d) {
      var v = byLabel[d[0]];
      if (d[1] === 'today') {
        var ymd = toYmd_(v, tz);
        if (ymd) today = ymd;
      } else if (v !== '' && v != null && isFinite(Number(v))) {
        cfg[d[1]] = Number(v);
      }
    });
    var top = findTableTop_(sh);
    if (top) {
      var body = sh.getRange(top + 1, 2, TABLE_ROW_LABELS.length, TABLE_KEYS.length).getValues();
      cfg.table = {};
      TABLE_KEYS.forEach(function (k, ci) {
        cfg.table[k] = body.map(function (r) { return Number(r[ci]); });
      });
    }
  }
  return { cfg: cfg, today: today };
}

// ====================================================================== 更新履歴

function safeCell_(v) {
  var s = String(v == null ? '' : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;  // 数式として解釈されないように
}

/** 編集者のメールを伏せ字で返す（例: n***@gmail.com）。取得できない環境では「（不明）」。 */
function editorOf_(e) {
  var email = '';
  try {
    if (e && e.user && e.user.getEmail) email = e.user.getEmail();
  } catch (ignore) {}
  if (!email) {
    try {
      email = Session.getActiveUser().getEmail();
    } catch (ignore2) {}
  }
  return LeaveCalc.maskEmail(email);
}

function logEdit_(e) {
  var ss = e.source || getSs_();
  var tz = ss.getSpreadsheetTimeZone();
  var r = e.range;
  var single = r.getNumRows() === 1 && r.getNumColumns() === 1;
  var before = single ? (e.oldValue === undefined ? '' : e.oldValue) : '(複数セル)';
  var after = single ? r.getDisplayValue() : '(複数セル)';
  ss.getSheetByName(SHEET.LOG).appendRow([
    Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss'),
    safeCell_(editorOf_(e)),
    r.getSheet().getName(),
    r.getA1Notation(),
    safeCell_(before),
    safeCell_(after)
  ]);
}

function logSystem_(ss, message) {
  var tz = ss.getSpreadsheetTimeZone();
  ss.getSheetByName(SHEET.LOG).appendRow([
    Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss'), 'システム', '', '', '', safeCell_(message)
  ]);
}
