const safety = require("./safety");
const privateChatVerification = require("./privateChatVerification");

const MAX_PRIVATE_RETRIES = 1;
const TRANSIENT_SEND_ERROR =
  /\b(?:ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|EPIPE|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)\b|socket hang up|network (?:error|timeout)|connection (?:reset|timed out|timeout)|(?:http|status|code)\D{0,4}5\d\d|internal server error/i;
const NON_RETRYABLE_ERROR =
  /checkpoint|login_approval|login[_ -]?blocked|locked|disabled|suspended|not logged in|135700[145]|1357031/i;

function shouldRetryPrivateSend(error, retryCount = 0) {
  const message = privateChatVerification.errorText(error);
  if (
    retryCount >= MAX_PRIVATE_RETRIES ||
    (error && error.safetyBlocked) ||
    safety.isSuspiciousSendError(message) ||
    privateChatVerification.isPrivateChatVerificationError(error)
  ) {
    return false;
  }

  return !NON_RETRYABLE_ERROR.test(message) && TRANSIENT_SEND_ERROR.test(message);
}

function retryDelayMs(retryCount = 0) {
  return 1500 * (retryCount + 1);
}

async function sendWithPrivateRetry(
  send,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  let retryCount = 0;
  while (true) {
    try {
      return await send();
    } catch (error) {
      if (!shouldRetryPrivateSend(error, retryCount)) throw error;
      await wait(retryDelayMs(retryCount));
      retryCount++;
    }
  }
}

module.exports = {
  MAX_PRIVATE_RETRIES,
  shouldRetryPrivateSend,
  retryDelayMs,
  sendWithPrivateRetry,
};