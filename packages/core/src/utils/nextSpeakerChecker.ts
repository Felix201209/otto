/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { OttoClient } from '../core/client.js';
import { OttoChat } from '../core/ottoChat.js';


export interface NextSpeakerResponse {
  reasoning: string;
  next_speaker: 'user' | 'model';
}

export async function checkNextSpeaker(
  chat: OttoChat,
  geminiClient: OttoClient,
  abortSignal: AbortSignal,
): Promise<NextSpeakerResponse | null> {
  // 不在调用模型判断是否该谁说话，节省token
  return null;
}
