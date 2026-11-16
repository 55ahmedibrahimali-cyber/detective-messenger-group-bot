const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const axios = require("axios");

const statePath = path.join(
  os.tmpdir(),
  `detective-ai-chat-${process.pid}-${Date.now()}.json`,
);
process.env.AI_CHAT_PROVIDER = "groq";
process.env.AI_CHAT_STATE_PATH = statePath;
process.env.GROQ_API_KEY = "gsk_test_key";
process.env.AI_CHAT_TYPING_MS_PER_CHAR = "0";
process.env.AI_CHAT_COOLDOWN_SECONDS = "0";
const aiChat = require("./aiChat");
const { config } = aiChat._internal;

test("AI chat defaults to Cloudflare Workers AI", () => {
  const result = spawnSync(
    process.execPath,
    ["-e", 'process.stdout.write(require("./services/aiChat")._internal.config.provider)'],
    {
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        AI_CHAT_PROVIDER: "",
        GROQ_API_KEY: "",
        CLOUDFLARE_ACCOUNT_ID: "",
        CLOUDFLARE_API_TOKEN: "",
        AI_CHAT_STATE_PATH: path.join(
          os.tmpdir(),
          `detective-ai-provider-${process.pid}.json`,
        ),
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "cloudflare");
});

function setup(generated) {
  const sent = [];
  const calls = [];
  const originalPost = axios.post;
  let fail = false;
  let gameActive = false;
  axios.post = async (...args) => {
    calls.push(args);
    if (fail) {
      throw Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      });
    }
    return {
      data: {
        choices: [{ message: { content: generated.shift() ?? "رد جديد." } }],
      },
    };
  };
  const deps = {
    send: async (...args) => sent.push(args),
    selfId: () => "bot",
    hasActiveGame: async () => gameActive,
    isAdmin: (userId) => userId === "user-1",
  };
  return {
    sent,
    calls,
    deps,
    setFail: (value) => (fail = value),
    setGameActive: (value) => (gameActive = value),
    restore: () => (axios.post = originalPost),
  };
}

test("Joud responds to explicit mentions but yields to active games", async () => {
  const env = setup([
    "<think>تفكير داخلي</think>أهلاً يا كائن 😼||تفضلي اسألي",
    "بشتغل على حاجة سرية، مش شغلك 💅",
  ]);
  const { sent, calls, deps } = env;
  const base = {
    platform: "test",
    userId: "user-1",
    userName: "أحمد",
    threadId: "thread-1",
    isGroup: true,
  };
  try {
    assert.equal(
      await aiChat.tryHandle(
        { ...base, threadId: "unauthorized", text: "/تكلم", userId: "user-2" },
        deps,
      ),
      false,
    );
    assert.equal(await aiChat.tryHandle({ ...base, text: "/تكلم" }, deps), true);
    assert.match(sent[0][1], /ردي على رسالتي/);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")).threads, [
      "test:thread-1",
    ]);

    // الرسائل العادية وأوامر الألعاب لا تُستهلكها جود.
    assert.equal(
      await aiChat.tryHandle(
        { ...base, userId: "user-2", userName: "سارة", text: "الماتش خلص 2-1" },
        deps,
      ),
      false,
    );
    assert.equal(
      await aiChat.tryHandle(
        { ...base, text: "رسالة أخرى", messageId: "unrelated" },
        deps,
      ),
      false,
    );
    env.setGameActive(true);
    assert.equal(
      await aiChat.tryHandle(
        {
          ...base,
          text: "يا جود، سؤال أثناء اللعبة؟",
          messageId: "blocked-game-mention",
        },
        deps,
      ),
      false,
    );
    assert.equal(
      await aiChat.tryHandle(
        {
          ...base,
          text: "رد على جود أثناء اللعبة",
          messageReply: { senderID: "bot", body: sent[0][1] },
        },
        deps,
      ),
      false,
    );
    assert.equal(calls.length, 0);
    env.setGameActive(false);
    assert.equal(
      await aiChat.tryHandle(
        {
          ...base,
          text: "رسالة أخرى",
          messageReply: { senderID: "bot", body: "إعلان اللعبة انتهت." },
        },
        deps,
      ),
      false,
    );
    assert.equal(
      await aiChat.tryHandle(
        {
          ...base,
          text: "/جاسوس",
          messageReply: { senderID: "bot", body: sent[0][1] },
        },
        deps,
      ),
      false,
    );

    assert.equal(
      await aiChat.tryHandle(
        {
          ...base,
          text: "يا جود، كيف حالك؟",
          messageId: "m1",
        },
        deps,
      ),
      true,
    );
    assert.equal(calls.length, 1);
    const body = calls[0][1];
    assert.equal(calls[0][0], "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(body.model, "openai/gpt-oss-20b");
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 400);
    assert.equal(body.temperature, 0.85);
    assert.deepEqual(body.messages.map(({ role }) => role), ["system", "user"]);
    assert.match(body.messages[0].content, /اسمك جود/);
    assert.match(body.messages[0].content, /عمرها 18 سنة/);
    assert.match(body.messages[0].content, /سعودية/);
    assert.match(body.messages[0].content, /لهجة سعودية عامية/);
    assert.match(body.messages[0].content, /مشاكسة/);
    assert.match(body.messages[0].content, /ذكاء اصطناعي/);
    assert.match(body.messages[0].content, /هودي/);
    assert.match(body.messages[1].content, /أحمد يكلمك الآن: كيف حالك؟/);
    assert.equal(calls[0][2].timeout, 60000);
    assert.equal(calls[0][2].proxy, false);
    assert.equal(calls[0][2].headers.Authorization, "Bearer gsk_test_key");
    assert.equal(sent[1][1], "أهلاً يا كائن 😼"); // وسم <think> اتشال

    // نفس messageId لا يُعالج مرتين.
    assert.equal(
      await aiChat.tryHandle(
        {
          ...base,
          text: "يا جود، كيف حالك؟",
          messageId: "m1",
        },
        deps,
      ),
      true,
    );
    assert.equal(calls.length, 1);

    // يمكن الرد على أي جزء من رد متعدد الرسائل، ويُستخدم سياقها السابق.
    await aiChat.tryHandle(
      {
        ...base,
        userId: "user-2",
        userName: "سارة",
        text: "وش تقصدين؟",
        messageId: "m2",
        messageReply: { senderID: "bot", body: sent[2][1] },
      },
      deps,
    );
    const second = calls[1][1].messages[1].content;
    assert.match(second, /جود \(أنتِ\): أهلاً يا كائن 😼 تفضلي اسألي/);
    assert.match(second, /سارة يكلمك الآن.*وش تقصدين؟/);
    assert.equal(sent.at(-1)[1], "بشتغل على حاجة سرية، مش شغلك 💅");

    assert.equal(await aiChat.tryHandle({ ...base, text: "/اسكت" }, deps), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")).threads, []);
    assert.equal(
      await aiChat.tryHandle(
        {
          ...base,
          text: "متابعة",
          messageReply: { senderID: "bot", body: sent.at(-2)[1] },
        },
        deps,
      ),
      false,
    );
  } finally {
    env.restore();
  }
});

test("Groq provider sends an OpenAI-style request with a bearer key and parses the reply", async () => {
  const env = setup([]);
  const { sent, calls, deps } = env;
  axios.post = async (...args) => {
    calls.push(args);
    return {
      data: { choices: [{ message: { content: "أهلاً يا ضحيتي 😼" } }] },
    };
  };
  const base = {
    platform: "groqtest",
    userId: "user-1",
    userName: "منى",
    threadId: "thread-g",
    isGroup: true,
  };
  const previous = { ...config };
  try {
    await aiChat.tryHandle({ ...base, text: "/تكلم" }, deps);
    config.groqKey = "gsk_test_key";
    config.groqModel = "openai/gpt-oss-20b";
    await aiChat.tryHandle(
      {
        ...base,
        text: "جود ازيك",
        messageId: "g1",
        messageReply: { senderID: "bot", body: sent[0][1] },
      },
      deps,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(calls[0][1].model, "openai/gpt-oss-20b");
    assert.equal(calls[0][1].stream, false);
    assert.equal(calls[0][1].max_tokens, 400);
    assert.deepEqual(
      calls[0][1].messages.map(({ role }) => role),
      ["system", "user"],
    );
    assert.equal(calls[0][2].headers.Authorization, "Bearer gsk_test_key");
    assert.equal(sent.at(-1)[1], "أهلاً يا ضحيتي 😼");

    // بدون مفتاح: لا طلب شبكة، وإشعار خطأ واحد.
    config.groqKey = "";
    config.cooldownMs = 0;
    await aiChat.tryHandle(
      {
        ...base,
        userId: "user-9",
        text: "جود تعالي",
        messageId: "g2",
        messageReply: { senderID: "bot", body: sent.at(-1)[1] },
      },
      deps,
    );
    assert.equal(calls.length, 1);
    assert.match(sent.at(-1)[1], /GROQ_API_KEY/);
  } finally {
    Object.assign(config, previous);
    await aiChat.tryHandle({ ...base, text: "/اسكت" }, deps);
    env.restore();
  }
});

test("Cloudflare provider sends an OpenAI-style request to the account endpoint", async () => {
  const env = setup([]);
  const { sent, calls, deps } = env;
  const previous = { ...config };
  const base = {
    platform: "cloudflaretest",
    userId: "user-1",
    userName: "منى",
    threadId: "thread-cf",
    isGroup: true,
  };
  try {
    config.provider = "cloudflare";
    config.cloudflareAccountId = "test-account";
    config.cloudflareApiToken = "cloudflare-test-token";
    config.cloudflareModel = "@cf/openai/gpt-oss-20b";
    await aiChat.tryHandle({ ...base, text: "/تكلم" }, deps);
    await aiChat.tryHandle(
      {
        ...base,
        text: "جود أخبارك؟",
        messageId: "cf1",
        messageReply: { senderID: "bot", body: sent[0][1] },
      },
      deps,
    );

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0][0],
      "https://api.cloudflare.com/client/v4/accounts/test-account/ai/v1/chat/completions",
    );
    assert.equal(calls[0][1].model, "@cf/openai/gpt-oss-20b");
    assert.equal(calls[0][1].stream, false);
    assert.equal(calls[0][1].max_tokens, 400);
    assert.equal(
      calls[0][2].headers.Authorization,
      "Bearer cloudflare-test-token",
    );
    assert.equal(sent.at(-1)[1], "رد جديد.");
  } finally {
    Object.assign(config, previous);
    await aiChat.tryHandle({ ...base, text: "/اسكت" }, deps);
    env.restore();
  }
});

test("Cloudflare chat reports missing account credentials before network access", async () => {
  const env = setup([]);
  const { sent, calls, deps } = env;
  const previous = { ...config };
  const base = {
    platform: "cloudflaremissing",
    userId: "user-1",
    threadId: "thread-cf-missing",
    isGroup: true,
  };
  try {
    config.provider = "cloudflare";
    config.cloudflareAccountId = "";
    config.cloudflareApiToken = "";
    await aiChat.tryHandle({ ...base, text: "/تكلم" }, deps);
    await aiChat.tryHandle(
      {
        ...base,
        text: "يا جود، سؤال؟",
        messageId: "cf-missing",
        messageReply: { senderID: "bot", body: sent[0][1] },
      },
      deps,
    );
    assert.equal(calls.length, 0);
    assert.match(sent.at(-1)[1], /CLOUDFLARE_ACCOUNT_ID/);
    assert.match(sent.at(-1)[1], /CLOUDFLARE_API_TOKEN/);
  } finally {
    Object.assign(config, previous);
    await aiChat.tryHandle({ ...base, text: "/اسكت" }, deps);
    env.restore();
  }
});

test("AI chat triggers require an exact name or an explicit address", () => {
  assert.equal(aiChat._internal.matchTrigger("جود"), "");
  assert.equal(aiChat._internal.matchTrigger("جود؟"), "");
  assert.equal(aiChat._internal.matchTrigger("جود أخبارك؟"), "أخبارك؟");
  assert.equal(aiChat._internal.matchTrigger("ازيك يا جود؟"), "ازيك يا جود؟");
  assert.equal(aiChat._internal.matchTrigger("الجودة ممتازة"), null);
});

test("AI replies are cleaned and split", () => {
  const { cleanReply, splitParts } = aiChat._internal;
  assert.equal(cleanReply("<think>x</think>جود: \"أهلاً\""), "أهلاً");
  assert.deepEqual(splitParts("أ||ب||ج||د"), ["أ", "ب", "ج د"]);
  assert.deepEqual(splitParts("أ"), ["أ"]);
});
