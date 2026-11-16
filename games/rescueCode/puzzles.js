const pairClues = (firstSum, firstProduct, lastSum, lastProduct, firstParity, lastParity) => [
  {
    type: "sum",
    pair: "first",
    value: firstSum,
    text: `مجموع الرقمين في الخانتين الأولى والثانية يساوي ${firstSum}.`,
  },
  {
    type: "product",
    pair: "first",
    value: firstProduct,
    text: `حاصل ضرب الرقمين في الخانتين الأولى والثانية يساوي ${firstProduct}.`,
  },
  {
    type: "sum",
    pair: "last",
    value: lastSum,
    text: `مجموع الرقمين في الخانتين الثالثة والرابعة يساوي ${lastSum}.`,
  },
  {
    type: "product",
    pair: "last",
    value: lastProduct,
    text: `حاصل ضرب الرقمين في الخانتين الثالثة والرابعة يساوي ${lastProduct}.`,
  },
  {
    type: "parity",
    position: 0,
    value: firstParity,
    text: `الرقم في الخانة الأولى ${firstParity === "even" ? "زوجي" : "فردي"}.`,
  },
  {
    type: "parity",
    position: 3,
    value: lastParity,
    text: `الرقم في الخانة الرابعة ${lastParity === "even" ? "زوجي" : "فردي"}.`,
  },
];

module.exports = [
  { code: "8532", clues: pairClues(13, 40, 5, 6, "even", "even") },
  { code: "8354", clues: pairClues(11, 24, 9, 20, "even", "even") },
  { code: "7354", clues: pairClues(10, 21, 9, 20, "odd", "even") },
  { code: "9162", clues: pairClues(10, 9, 8, 12, "odd", "even") },
  { code: "8471", clues: pairClues(12, 32, 8, 7, "even", "odd") },
  { code: "9263", clues: pairClues(11, 18, 9, 18, "odd", "odd") },
];
