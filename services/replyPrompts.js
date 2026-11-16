function isReplyToBotPrompt(messageReply, marker, botId) {
  const expectedBotId = botId == null ? "" : String(botId).trim();
  if (
    !messageReply ||
    !marker ||
    !expectedBotId ||
    !String(messageReply.body || "").includes(marker)
  )
    return false;
  return (
    messageReply.senderID != null &&
    String(messageReply.senderID) === expectedBotId
  );
}

module.exports = { isReplyToBotPrompt };
