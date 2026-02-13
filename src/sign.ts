import * as crypto from 'crypto';

export interface SignResult {
  sign: string;
  timestamp: number;
}

/**
 * 生成钉钉机器人签名
 * @param secretKey 钉钉机器人密钥
 * @returns 签名和时间戳
 */
export function dingtalkSign(secretKey: string): SignResult {
  if (!secretKey) {
    throw new Error('[dingtalk-sign] not found secretKey.');
  }

  const timestamp = Date.now();
  const textToSign = timestamp + '\n' + secretKey;

  const keyInBase64 = crypto
    .createHmac('sha256', secretKey)
    .update(textToSign)
    .digest('base64');

  const keyInURL = encodeURIComponent(keyInBase64);

  return { sign: keyInURL, timestamp };
}
