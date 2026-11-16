const MESSAGE =
  "هلا والله! نورتوا الشات، أنا جود 🌷 إذا ودكم تلعبون اكتبوا /العاب، وإذا احتجتوا شيء نادوني 🤍";

function messengerMemberAdded(event, botId) {
  if (event?.type !== "event" || event.logMessageType !== "log:subscribe")
    return null;
  const participants = event.logMessageData?.addedParticipants;
  if (!Array.isArray(participants) || !participants.length || !event.threadID)
    return null;

  const ids = participants
    .map((participant) => {
      if (typeof participant === "string" || typeof participant === "number")
        return String(participant);
      return String(
        participant?.userFbId ||
          participant?.userID ||
          participant?.userId ||
          participant?.id ||
          "",
      );
    })
    .filter(Boolean);
  if (ids.length && ids.every((id) => id === String(botId))) return null;

  return { threadId: String(event.threadID), text: MESSAGE };
}

function telegramMemberAdded(message, botId) {
  const chat = message?.chat;
  const members = message?.new_chat_members;
  if (
    !chat ||
    !["group", "supergroup"].includes(chat.type) ||
    !Array.isArray(members) ||
    !members.length
  )
    return null;

  if (
    members.every(
      (member) => member?.id != null && String(member.id) === String(botId),
    )
  )
    return null;

  return { threadId: String(chat.id), text: MESSAGE };
}

module.exports = { MESSAGE, messengerMemberAdded, telegramMemberAdded };
