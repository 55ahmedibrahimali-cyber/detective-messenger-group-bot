const test = require("node:test");
const assert = require("node:assert");
const { parseCommand } = require("./command");

test("parseCommand", () => {
  assert.strictEqual(parseCommand("مرحبا"), null);
  assert.strictEqual(parseCommand("edit this please"), null); // لاتيني بلا بادئة
  assert.deepStrictEqual(parseCommand("ايديت"), { name: "", seconds: null, landscape: false });
  assert.deepStrictEqual(parseCommand("ايديت غوجو"), { name: "غوجو", seconds: null, landscape: false });
  assert.deepStrictEqual(parseCommand("ايديت Gojo Satoru 20"), { name: "Gojo Satoru", seconds: 20, landscape: false });
  assert.deepStrictEqual(parseCommand("/edit naruto ٢٥ ثانية افقي"), { name: "naruto", seconds: 25, landscape: true });
  assert.deepStrictEqual(parseCommand("ايديت 15s"), { name: "", seconds: 15, landscape: false });
  assert.deepStrictEqual(parseCommand("ايديت Sukuna 4"), { name: "Sukuna 4", seconds: null, landscape: false }); // 4 < الحد الأدنى
  assert.strictEqual(parseCommand("ايديت a;rm -rf /").name, "a rm -rf /"); // رموز الشيل تُزال
});
