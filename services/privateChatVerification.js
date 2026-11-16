const LOCAL_CONTACT_REQUIRED = /اللاعب لم يبدأ محادثة خاصة مع البوت بعد/i;
const PRIVATE_CHAT_VERIFICATION_REQUIRED =
  /(?:message request.{0,40}(?:not accepted|pending|declined)|(?:recipient|user|person).{0,80}(?:has not|hasn't|never).{0,40}(?:messaged|contacted|started)|(?:start|initiate).{0,40}(?:a )?conversation|not allowed to (?:send|message)|cannot send.{0,40}message|can't message)/i;

const USER_HINT =
  "يحتاج المستخدم إلى فتح محادثة خاصة مع جود وإرسال رسالة أولاً، ثم إعادة المحاولة.";

function errorText(error) {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return String(error || "");

  const nestedError =
    error.error && typeof error.error === "object" ? error.error : null;
  const responseError =
    error.response &&
    error.response.data &&
    error.response.data.error;
  const parts = [
    error.message,
    nestedError ? nestedError.message || nestedError.error : error.error,
    nestedError && nestedError.code,
    error.description,
    error.code,
    error.status,
    error.response && error.response.status,
    responseError && typeof responseError === "object"
      ? responseError.message
      : responseError,
  ];
  return parts
    .filter((part) => typeof part === "string" || typeof part === "number")
    .join(" ");
}

function isPrivateChatVerificationError(error) {
  const message = errorText(error);
  return (
    LOCAL_CONTACT_REQUIRED.test(message) ||
    PRIVATE_CHAT_VERIFICATION_REQUIRED.test(message)
  );
}

function userHint(error) {
  return isPrivateChatVerificationError(error) ? USER_HINT : null;
}

module.exports = {
  errorText,
  isPrivateChatVerificationError,
  userHint,
};