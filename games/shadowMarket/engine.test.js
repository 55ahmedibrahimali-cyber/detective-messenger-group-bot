const test = require("node:test");
const assert = require("node:assert/strict");
const { _internal } = require("./engine");

const players = [
  { psid: "smuggler", display_name: "المهرّب" },
  { psid: "inspector", display_name: "المفتش" },
  { psid: "merchant-one", display_name: "تاجر ١" },
  { psid: "merchant-two", display_name: "تاجر ٢" },
];

test("secret role assignment creates one smuggler and one inspector", () => {
  const state = {};
  _internal.assignSecretRoles(state, players);

  assert.equal(Object.values(state.roles).filter((role) => role === "smuggler").length, 1);
  assert.equal(Object.values(state.roles).filter((role) => role === "inspector").length, 1);
  assert.equal(Object.values(state.roles).filter((role) => role === "merchant").length, 2);
  assert.deepEqual(Object.values(state.coins), [10, 10, 10, 10]);
});

test("each round deals one counterfeit card to the smuggler only", () => {
  const state = {
    round: 1,
    roles: {
      smuggler: "smuggler",
      inspector: "inspector",
      "merchant-one": "merchant",
      "merchant-two": "merchant",
    },
    cards: [],
  };
  _internal.dealRound(state, players);

  assert.equal(state.cards.length, players.length);
  assert.deepEqual(
    state.cards.filter((card) => !card.authentic).map((card) => card.initialOwnerId),
    ["smuggler"],
  );
});

test("trade settlement transfers the card and coins once", () => {
  const state = {
    roles: { seller: "smuggler" },
    coins: { seller: 10, buyer: 10 },
    cards: [
      {
        id: "1:seller",
        ownerId: "seller",
        authentic: false,
        traded: false,
      },
    ],
    roundTrades: [],
    tradeCounts: { seller: 0, buyer: 0 },
    fakeSales: 0,
  };
  const offer = {
    targetId: "buyer",
    sellerId: "seller",
    cardId: "1:seller",
    price: 4,
    description: "خاتم نادر",
  };

  assert.equal(_internal.settleTrade(state, offer, "buyer").error, undefined);
  assert.deepEqual(state.coins, { seller: 14, buyer: 6 });
  assert.equal(state.cards[0].ownerId, "buyer");
  assert.equal(state.cards[0].traded, true);
  assert.equal(state.fakeSales, 1);
  assert.equal(_internal.settleTrade(state, offer, "buyer").error, "invalid-offer");
  assert.equal(state.coins.buyer, 6);
});

test("insufficient funds do not mutate a pending trade", () => {
  const state = {
    roles: {},
    coins: { seller: 3, buyer: 2 },
    cards: [{ id: "1:seller", ownerId: "seller", authentic: true, traded: false }],
    roundTrades: [],
    tradeCounts: {},
    fakeSales: 0,
  };
  const offer = {
    targetId: "buyer",
    sellerId: "seller",
    cardId: "1:seller",
    price: 3,
    description: "ساعة",
  };

  assert.equal(
    _internal.settleTrade(state, offer, "buyer").error,
    "insufficient-coins",
  );
  assert.deepEqual(state.coins, { seller: 3, buyer: 2 });
  assert.equal(state.cards[0].ownerId, "seller");
});

test("scores exclude counterfeit value and apply secret objectives", () => {
  const state = {
    roles: { smuggler: "smuggler", inspector: "inspector", collector: "merchant" },
    goals: {
      smuggler: { type: "smuggler" },
      inspector: { type: "inspector" },
      collector: { type: "collector", category: "مجوهرات" },
    },
    coins: { smuggler: 15, inspector: 10, collector: 10 },
    fakeSales: 1,
    inspectedFakes: 1,
    tradeCounts: {},
    cards: [
      { ownerId: "collector", authentic: true, category: "مجوهرات", value: 4 },
      { ownerId: "collector", authentic: true, category: "مجوهرات", value: 5 },
      { ownerId: "collector", authentic: false, category: "مجوهرات", value: 20 },
      { ownerId: "inspector", authentic: true, category: "تحف", value: 5 },
      { ownerId: "inspector", authentic: false, category: "تحف", value: 20 },
    ],
  };

  const scores = _internal.calculateScores(
    [players[0], players[1], { psid: "collector", display_name: "جامع" }],
    state,
  );
  assert.deepEqual(
    scores.map((entry) => [entry.score, entry.bonus]),
    [
      [19, 4],
      [17, 2],
      [23, 4],
    ],
  );
});

test("offers accept Arabic digits and sanitize multiline descriptions", () => {
  assert.deepEqual(_internal.parseOffer("عرض ٣ ٧ | عملة قديمة\n أصلية"), {
    targetNumber: 3,
    price: 7,
    description: "عملة قديمة أصلية",
  });
  assert.equal(_internal.playerByNumber(players, 0), null);
  assert.equal(_internal.playerByNumber(players, 2), players[1]);
});
