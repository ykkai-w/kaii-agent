const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const spreadsheet = require("../../electron/lib/spreadsheet.cjs");
const schedules = require("../../electron/lib/schedules.cjs");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kaii-test-"));
}

function writeWorkbookFixture(folder) {
  const source = path.join(folder, "xlsx-source");
  fs.mkdirSync(path.join(source, "xl", "_rels"), { recursive: true });
  fs.mkdirSync(path.join(source, "xl", "worksheets"), { recursive: true });

  const sheetTags = [];
  const relationships = [];
  // 工作簿顺序是 rId1..rId10，但 target 故意循环错开。
  // 如果只按 sheet1/sheet10 文件名排序，或用下标猜对应，
  // 这份真 xlsx 解出的表名与内容就会立即对不上。
  for (let index = 1; index <= 10; index += 1) {
    const targetNumber = index === 1 ? 10 : index - 1;
    sheetTags.push(`<sheet name="工作表${index}" sheetId="${index}" r:id="rId${index}"/>`);
    relationships.push(
      `<Relationship Id="rId${index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${targetNumber}.xml"/>`,
    );
  }
  fs.writeFileSync(
    path.join(source, "xl", "workbook.xml"),
    `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetTags.join("")}</sheets></workbook>`,
  );
  fs.writeFileSync(
    path.join(source, "xl", "_rels", "workbook.xml.rels"),
    `<?xml version="1.0"?><Relationships>${relationships.join("")}</Relationships>`,
  );
  for (let index = 1; index <= 10; index += 1) {
    fs.writeFileSync(
      path.join(source, "xl", "worksheets", `sheet${index}.xml`),
      `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>文件${index}</t></is></c></row></sheetData></worksheet>`,
    );
  }
  const output = path.join(folder, "ten-sheets.xlsx");
  execFileSync("/usr/bin/zip", ["-qr", output, "."], { cwd: source });
  return output;
}

// ── 表格 ───────────────────────────────────────────────────

test("CSV 里的空格不会被当成 0 算进平均值", () => {
  const rows = spreadsheet.parseCsv("城市,销量\n北京,120\n上海,\n广州,150\n深圳,120\n");
  const description = spreadsheet.describeTable("表格", rows);
  // 三个有值的格子：120 + 150 + 120 = 390，平均 130。
  // 如果把空格当 0，平均会变成 97.5——这是最容易悄悄错掉的地方。
  assert.match(description, /销量：数字列，3 个值/);
  assert.match(description, /合计 390/);
  assert.match(description, /平均 130/);
});

test("带引号的 CSV 单元格里，逗号和换行不会把一行拆开", () => {
  const rows = spreadsheet.parseCsv('名字,备注\n张三,"住在北京,朝阳区"\n李四,"第一行\n第二行"\n');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], ["张三", "住在北京,朝阳区"]);
  assert.equal(rows[2][1], "第一行\n第二行");
});

test('两个连续引号在引号内还原成一个引号', () => {
  const rows = spreadsheet.parseCsv('句子\n"他说""好"""\n');
  assert.equal(rows[1][0], '他说"好"');
});

test("TSV 以 tab 分列，单元格里的逗号不会被误拆", () => {
  const dir = tempDir();
  const file = path.join(dir, "客户.tsv");
  fs.writeFileSync(file, '姓名\t备注\n张三\t北京,朝阳\n李四\t"第一段\t第二段"\n');
  const table = spreadsheet.readTable(file);
  assert.equal(table.sheets.length, 1);
  assert.deepEqual(table.sheets[0].rows, [
    ["姓名", "备注"],
    ["张三", "北京,朝阳"],
    ["李四", "第一段\t第二段"],
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("10 张以上工作表严格按 workbook relationship 对应，不按文件名字典序", () => {
  const dir = tempDir();
  const file = writeWorkbookFixture(dir);
  const table = spreadsheet.readTable(file);
  assert.deepEqual(table.sheets.map((sheet) => sheet.name), [
    "工作表1", "工作表2", "工作表3", "工作表4", "工作表5",
    "工作表6", "工作表7", "工作表8", "工作表9", "工作表10",
  ]);
  assert.deepEqual(
    table.sheets.map((sheet) => sheet.rows[0][0]),
    ["文件10", "文件1", "文件2", "文件3", "文件4", "文件5", "文件6", "文件7", "文件8", "文件9"],
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("文本列会数出有几种取值，并把空格单独报出来", () => {
  const summary = spreadsheet.summarizeColumn("备注", ["缺", "", "", ""]);
  assert.match(summary, /文本列，1 个值/);
  assert.match(summary, /另有 3 个空/);
});

test("数字里的千分位和货币符号不影响识别成数字列", () => {
  const summary = spreadsheet.summarizeColumn("金额", ["￥1,200", "￥800"]);
  assert.match(summary, /数字列/);
  assert.match(summary, /合计 2000/);
});

test("给模型的表格上下文会说明只给了前几行，别拿它猜整张表", () => {
  const rows = [["月份", "销量"]];
  for (let index = 1; index <= 30; index += 1) rows.push([`${index} 月`, String(index * 10)]);
  const context = spreadsheet.formatTableContext({ sheets: [{ name: "Sheet1", rows }] }, "销量.xlsx");
  assert.match(context, /共 30 行/);
  assert.match(context, new RegExp(`下面只列前 ${spreadsheet.PREVIEW_ROWS} 行`));
  assert.match(context, /不要凭前几行猜整张表/);
  // 统计必须覆盖全部 30 行，而不是只覆盖预览出来的那 12 行。
  assert.match(context, /合计 4650/);
});

test("不认识的扩展名直接说清楚支持哪些，而不是抛一个看不懂的错", () => {
  assert.throws(() => spreadsheet.readTable("/tmp/whatever.numbers"), /只支持 xlsx、xlsm、csv 和 tsv/);
});

test("不是 zip 的文件会被明确判为无效，不会读出半张表", () => {
  const dir = tempDir();
  const file = path.join(dir, "假的.xlsx");
  fs.writeFileSync(file, "这其实是纯文本");
  assert.throws(() => spreadsheet.readTable(file), /有效的 zip/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 定时任务 ───────────────────────────────────────────────

// 基准：2026-08-10 周一 10:30。用固定时刻而不是 Date.now()，
// 否则这组断言会在一天里的不同时候给出不同结果。
const MONDAY_1030 = new Date(2026, 7, 10, 10, 30, 0, 0).getTime();

test("下一次运行时刻永远在未来，而且落在正确的那一天", () => {
  const cases = [
    [{ every: "day", hour: 9, minute: 0 }, new Date(2026, 7, 11, 9, 0)],
    [{ every: "day", hour: 18, minute: 0 }, new Date(2026, 7, 10, 18, 0)],
    [{ every: "hour", hour: 0, minute: 15 }, new Date(2026, 7, 10, 11, 15)],
    [{ every: "hour", hour: 0, minute: 45 }, new Date(2026, 7, 10, 10, 45)],
    [{ every: "week", weekday: 5, hour: 9, minute: 0 }, new Date(2026, 7, 14, 9, 0)],
    // 今天正好是周一，但 09:00 已经过了，必须跳到下周一而不是返回一个过去的时刻。
    [{ every: "week", weekday: 1, hour: 9, minute: 0 }, new Date(2026, 7, 17, 9, 0)],
  ];
  for (const [schedule, expected] of cases) {
    const actual = schedules.nextRunAt(schedule, MONDAY_1030);
    assert.equal(actual, expected.getTime(), `${JSON.stringify(schedule)} 算出来是 ${new Date(actual)}`);
    assert.ok(actual > MONDAY_1030, "算出来的时刻在过去");
  }
});

test("迟到超过宽限期就跳过这一次，不会开机时一次性补跑一堆", () => {
  const dir = tempDir();
  const list = schedules.addSchedule(dir, {
    label: "早报", prompt: "汇总今天要做的事", every: "day", hour: 9, minute: 0,
  });
  const id = list[0].id;

  // 距离该跑的时刻过了 1 分钟：还在宽限期里，应该补跑。
  const justLate = new Date(2026, 7, 10, 9, 1).getTime();
  assert.equal(schedules.dueSchedules(dir, justLate).length, 1);

  // 过了 3 小时：早就错过了，跳过，不补。
  const wayLate = new Date(2026, 7, 10, 12, 0).getTime();
  assert.equal(schedules.dueSchedules(dir, wayLate).length, 0);

  // 关掉之后无论什么时候都不跑。
  schedules.updateSchedule(dir, id, { enabled: false });
  assert.equal(schedules.dueSchedules(dir, justLate).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("失败的那次也留下原因，事后能查", () => {
  const dir = tempDir();
  const added = schedules.addSchedule(dir, { prompt: "看看今天的日程", every: "hour", minute: 0 });
  const list = schedules.recordRun(dir, added[0].id, { ok: false, error: "模型没连上" });
  const entry = list[0].results.at(-1);
  assert.equal(entry.ok, false);
  assert.equal(entry.error, "模型没连上");
  assert.equal(entry.unread, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("未读计数随着已读归零", () => {
  const dir = tempDir();
  let list = schedules.addSchedule(dir, { prompt: "一句话", every: "day", hour: 8, minute: 0 });
  list = schedules.recordRun(dir, list[0].id, { ok: true, text: "结果一" });
  list = schedules.recordRun(dir, list[0].id, { ok: true, text: "结果二" });
  assert.equal(schedules.unreadCount(dir), 2);
  schedules.markRead(dir, list[0].id);
  assert.equal(schedules.unreadCount(dir), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("只留最近若干次结果，不会把文件撑爆", () => {
  const dir = tempDir();
  const added = schedules.addSchedule(dir, { prompt: "一句话", every: "hour", minute: 30 });
  let list = added;
  for (let index = 0; index < 30; index += 1) {
    list = schedules.recordRun(dir, added[0].id, { ok: true, text: `第 ${index} 次` });
  }
  assert.equal(list[0].results.length, 20);
  assert.match(list[0].results.at(-1).text, /第 29 次/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("写坏的输入被挡在存盘之前", () => {
  const dir = tempDir();
  assert.throws(() => schedules.addSchedule(dir, { prompt: "", every: "day", hour: 9, minute: 0 }), /先写一句/);
  assert.throws(() => schedules.addSchedule(dir, { prompt: "x", every: "cron", minute: 0 }), /重复方式无效/);
  assert.throws(() => schedules.addSchedule(dir, { prompt: "x", every: "day", hour: 30, minute: 0 }), /小时无效/);
  assert.throws(() => schedules.addSchedule(dir, { prompt: "x", every: "day", hour: 9, minute: 99 }), /分钟无效/);
  assert.throws(() => schedules.addSchedule(dir, { prompt: "x", every: "week", weekday: 9, hour: 9, minute: 0 }), /星期无效/);
  assert.equal(schedules.listSchedules(dir).length, 0, "校验失败却写进了文件");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("定时任务文件只有本人可读写", () => {
  const dir = tempDir();
  schedules.addSchedule(dir, { prompt: "一句话", every: "day", hour: 9, minute: 0 });
  const mode = fs.statSync(schedules.schedulesPath(dir)).mode & 0o777;
  assert.equal(mode, 0o600, `权限是 ${mode.toString(8)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("最多 20 个定时任务", () => {
  const dir = tempDir();
  for (let index = 0; index < schedules.MAX_SCHEDULES; index += 1) {
    schedules.addSchedule(dir, { label: `任务${index}`, prompt: "一句话", every: "day", hour: 9, minute: 0 });
  }
  assert.throws(
    () => schedules.addSchedule(dir, { prompt: "再来一个", every: "day", hour: 9, minute: 0 }),
    /最多 20 个/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("界面上必须说明 kaii-agent 关闭时不会运行", () => {
  // 这是一条真实的限制。任何时候被改掉都应该让测试红，
  // 而不是悄悄把一个做不到的承诺留在界面上。
  const panel = fs.readFileSync(path.join(__dirname, "../../src/components/SchedulePanel.tsx"), "utf8");
  assert.match(panel, /kaii-agent 关闭时不会运行/);
  assert.match(panel, /忙碌时会等当前回答结束/);
});

test("每月规则：短月不漏跑（只许 1-28 号），过了就到下月", () => {
  const base = new Date(2026, 7, 18, 10, 0).getTime();
  const next = schedules.nextRunAt({ every: "month", dayOfMonth: 1, hour: 9, minute: 0 }, base);
  assert.equal(new Date(next).getMonth(), 8, "8/18 之后的每月 1 号该是 9/1");
  assert.throws(
    () => schedules.validateSchedule({ prompt: "x", every: "month", dayOfMonth: 29, hour: 9, minute: 0 }),
    /1 到 28/,
  );
});

test("暂停到某天：期间不跑，到点自动恢复", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kaii-test-"));
  const list = schedules.addSchedule(dir, { prompt: "早报", every: "day", hour: 9, minute: 0 });
  const tomorrow = Date.now() + 86_400_000;
  schedules.pauseUntil(dir, list[0].id, tomorrow);
  const at9 = new Date(); at9.setHours(9, 1, 0, 0);
  assert.equal(schedules.dueSchedules(dir, at9.getTime()).length, 0, "暂停期内不该跑");
  // 暂停过期之后照常。
  assert.ok(schedules.listSchedules(dir)[0].pausedUntil === tomorrow);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("连续失败三次自动停用，原因写在最后一条结果里", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kaii-test-"));
  let list = schedules.addSchedule(dir, { prompt: "x", every: "day", hour: 9, minute: 0 });
  list = schedules.recordRun(dir, list[0].id, { ok: false, error: "一" });
  list = schedules.recordRun(dir, list[0].id, { ok: false, error: "二" });
  assert.equal(list[0].enabled, true, "两次还不该停");
  list = schedules.recordRun(dir, list[0].id, { ok: false, error: "三" });
  assert.equal(list[0].enabled, false);
  assert.match(list[0].results.at(-1).error, /自动停用/);
  // 中间成功过就重新计数。
  let list2 = schedules.addSchedule(dir, { prompt: "y", every: "day", hour: 9, minute: 0 });
  const id2 = list2.at(-1).id;
  schedules.recordRun(dir, id2, { ok: false, error: "一" });
  schedules.recordRun(dir, id2, { ok: true, text: "成了" });
  schedules.recordRun(dir, id2, { ok: false, error: "二" });
  list2 = schedules.recordRun(dir, id2, { ok: false, error: "三" });
  assert.equal(list2.find((item) => item.id === id2).enabled, true, "中间成功过，连败没到三次");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("任务的联网/资料开关与通知关键词都存得住", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kaii-test-"));
  const list = schedules.addSchedule(dir, {
    prompt: "盯一下", every: "day", hour: 9, minute: 0,
    useWeb: true, notifyKeyword: "  跌破  ",
  });
  assert.equal(list[0].useWeb, true);
  assert.equal(list[0].notifyKeyword, "跌破", "关键词要去掉首尾空白");
  fs.rmSync(dir, { recursive: true, force: true });
});
