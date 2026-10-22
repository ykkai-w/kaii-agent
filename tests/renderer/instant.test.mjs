import assert from "node:assert/strict";
import test from "node:test";

const instant = await import("../../src/lib/instant.ts");

test("算式：优先级、括号、负号、全角符号都对", () => {
  assert.equal(instant.instantAnswer("2+3*4").answer, "2+3*4 = 14");
  assert.equal(instant.instantAnswer("(2+3)*4").answer, "(2+3)*4 = 20");
  assert.equal(instant.instantAnswer("2^10").answer, "2^10 = 1024");
  assert.equal(instant.instantAnswer("-3+5").answer, "-3+5 = 2");
  assert.equal(instant.instantAnswer("１２×３".normalize("NFKC").replace("×", "×")).kind, "calc");
  assert.equal(instant.instantAnswer("0.1+0.2").answer, "0.1+0.2 = 0.3", "浮点尾巴要收掉");
});

test("算式：除零不接茬、纯数字不接茬、长文本不接茬", () => {
  assert.equal(instant.instantAnswer("5/0"), null);
  assert.equal(instant.instantAnswer("42"), null);
  assert.equal(instant.instantAnswer("帮我算算这个月的开销加起来是多少"), null);
});

test("单位：公里英里、斤公斤、温度公式", () => {
  assert.match(instant.instantAnswer("5公里转英里").answer, /3\.107/);
  assert.match(instant.instantAnswer("3斤等于多少公斤").answer, /1\.5 公斤/);
  assert.match(instant.instantAnswer("100摄氏度转华氏度").answer, /212/);
  assert.equal(instant.instantAnswer("5光年转英里"), null, "不认识的单位不硬答");
});

test("日期：天后推算、日期差、今天周几", () => {
  const now = new Date(2026, 7, 18); // 2026-08-18 周二
  assert.match(instant.instantAnswer("45天后是几号", now).answer, /2026-10-02/);
  assert.match(instant.instantAnswer("10天前", now).answer, /2026-08-08/);
  assert.match(instant.instantAnswer("2026-08-18 到 2026-12-31", now).answer, /135 天/);
  assert.match(instant.instantAnswer("今天周几", now).answer, /周二/);
});

test("随机串：长度夹紧、字符集不含易混字符、两次不同", () => {
  const first = instant.instantAnswer("密码 20").answer;
  assert.equal(first.length, 20);
  assert.ok(!/[0O1lI]/.test(first), "不该出现易混字符");
  assert.equal(instant.instantAnswer("密码 99").answer.length, 64, "上限 64");
  assert.notEqual(instant.instantAnswer("密码").answer, instant.instantAnswer("密码").answer);
  assert.match(instant.instantAnswer("uuid").answer, /^[0-9a-f-]{36}$/);
});

test("清理：全角空格/字母、行尾空白、连环空行", () => {
  const dirty = "ＡＢＣ　１２３   \n\n\n\n下一段  ";
  assert.equal(instant.cleanText(dirty), "ABC 123\n\n下一段");
});

test("JSON 排版：真 JSON 排两格缩进，坏的返回 null", () => {
  assert.equal(instant.formatJson('{"a":1,"b":[2,3]}'), '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
  assert.equal(instant.formatJson("{a:1}"), null);
  assert.equal(instant.formatJson("普通一句话"), null);
});

test("Markdown 转纯文本：记号拆掉、内容一字不丢", () => {
  const md = "# 标题\n\n**加粗** 和 *斜体* 还有 `代码`。\n\n- 第一条\n- 第二条\n\n> 引用一句\n\n[链接文字](https://example.com)\n\n```js\nconst a = 1;\n```";
  const plain = instant.stripMarkdown(md);
  assert.ok(!/[#*`>\[\]]/.test(plain.replace(/·/g, "")), `还剩记号：${plain}`);
  for (const piece of ["标题", "加粗", "斜体", "代码", "第一条", "引用一句", "链接文字", "const a = 1;"]) {
    assert.ok(plain.includes(piece), `内容丢了：${piece}`);
  }
  assert.ok(!plain.includes("example.com"), "网址应当丢掉只留链接文字");
});

test("进制转换：16→10、10→16、10→2，非法值不接茬", () => {
  assert.match(instant.instantAnswer("0xff 转十进制").answer, /= 255/);
  assert.match(instant.instantAnswer("255 转16进制").answer, /0xFF/);
  assert.match(instant.instantAnswer("10 转二进制").answer, /0b1010/);
  assert.equal(instant.instantAnswer("红色 转十进制"), null);
});

test("时间戳：10 位当秒、13 位当毫秒；离谱年份不认", () => {
  const secs = instant.instantAnswer("1755500000");
  assert.equal(secs.kind, "date");
  assert.match(secs.answer, /2025|2026/);
  assert.equal(instant.instantAnswer("1755500000000").kind, "date");
  // 1234567890123 毫秒是 2009 年，属于合法时间戳，要认（先前这条断言写错了）
  assert.match(instant.instantAnswer("1234567890123").answer, /2009/);
  // 真正越界的才不认：9999999999999 毫秒是 2286 年
  assert.equal(instant.instantAnswer("9999999999999"), null);
  // 位数不对的一串数字也不认
  assert.equal(instant.instantAnswer("12345"), null);
});

test("清理文本：中英文之间补空格，但标点两侧不动", () => {
  assert.equal(instant.cleanText("这是kaii应用"), "这是 kaii 应用");
  assert.equal(instant.cleanText("中文，English"), "中文，English");
});

test("折扣与百分比：折算价、省了多少、百分之几", () => {
  assert.match(instant.instantAnswer("8.5折 1200").answer, /打 8.5 折 = 1020（省 180）/);
  // 口语里「85折」就是 8.5 折；答案里显示归一化后的折数
  assert.match(instant.instantAnswer("85折 1200").answer, /打 8.5 折 = 1020/);
  assert.match(instant.instantAnswer("1200 的 15%").answer, /= 180/);
  // 打错成「12折」也照同一套读法归一化成 1.2 折并显示出来，用户一眼能发现读错了
  assert.match(instant.instantAnswer("12折 100").answer, /打 1.2 折 = 12/);
  // 涨价式折扣（0 折、11 折以上换算后超过原价）不接茬
  assert.equal(instant.instantAnswer("0折 100"), null);
});

test("中文数字：规规矩矩的写法认，口语省略不猜", () => {
  assert.equal(instant.parseChineseNumber("三千五百二十"), 3520);
  assert.equal(instant.parseChineseNumber("十五"), 15);
  assert.equal(instant.parseChineseNumber("一百零五"), 105);
  assert.equal(instant.parseChineseNumber("两万三千"), 23000);
  assert.equal(instant.parseChineseNumber("壹佰贰拾"), 120);
  assert.equal(instant.parseChineseNumber("三亿五千万"), 350000000);
  // 不是纯中文数字的一律不认
  assert.equal(instant.parseChineseNumber("三千块钱"), null);
  assert.equal(instant.parseChineseNumber("abc"), null);
  // 走立答入口
  assert.match(instant.instantAnswer("三千五百二十").answer, /= 3520/);
});

test("数字转中文大写金额：整数、角分、零的位置", () => {
  assert.equal(instant.toChineseAmount(123), "壹佰贰拾叁元整");
  assert.equal(instant.toChineseAmount(1000), "壹仟元整");
  assert.equal(instant.toChineseAmount(105), "壹佰零伍元整");
  // 跨节的零：这几个是大写金额最容易写错的地方
  assert.equal(instant.toChineseAmount(10001), "壹万零壹元整");
  assert.equal(instant.toChineseAmount(10200), "壹万零贰佰元整");
  assert.equal(instant.toChineseAmount(100000001), "壹亿零壹元整");
  assert.equal(instant.toChineseAmount(123.45), "壹佰贰拾叁元肆角伍分");
  assert.equal(instant.toChineseAmount(0.5), "零元伍角");
  assert.equal(instant.toChineseAmount(100.05), "壹佰元零伍分");
  assert.equal(instant.toChineseAmount(-1), null);
  assert.match(instant.instantAnswer("123.45 元 转大写").answer, /壹佰贰拾叁元肆角伍分/);
});

test("某个日期是周几：算得对，不存在的日期不硬答", () => {
  assert.match(instant.instantAnswer("2026-10-01 是周几").answer, /周四/);
  assert.match(instant.instantAnswer("2000-01-01 星期几").answer, /周六/);
  // 2026-02-30 不存在，Date 会顺延成 3 月 2 日，必须拦下而不是给个错答案
  assert.equal(instant.instantAnswer("2026-02-30 是周几"), null);
});

test("面积：平方米↔亩↔公顷", () => {
  assert.match(instant.instantAnswer("1000平方米转亩").answer, /1\.5 亩/);
  assert.match(instant.instantAnswer("3亩转平方米").answer, /2000 平方米/);
  assert.match(instant.instantAnswer("2公顷转亩").answer, /30 亩/);
});

test("随机数区间：闭区间、顺序反了也认、结果落在范围内", () => {
  for (let round = 0; round < 20; round += 1) {
    const answer = instant.instantAnswer("随机数 1-6").answer;
    const value = Number(answer.split("：")[1]);
    assert.ok(value >= 1 && value <= 6, answer);
  }
  assert.match(instant.instantAnswer("随机数 10到5").answer, /^5 到 10：/);
});

test("现在几点：给时间也给日期", () => {
  const hit = instant.instantAnswer("现在几点");
  assert.equal(hit.kind, "date");
  assert.match(hit.answer, /现在是 \d{2}:\d{2}/);
});
