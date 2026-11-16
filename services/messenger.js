module.exports =
  process.env.BOT_PLATFORM === "telegram"
    ? require("./telegram/messenger")
    : require("./messengerFacebook");
