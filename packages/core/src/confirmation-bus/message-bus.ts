/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';

/**
 * Tags for message-bus traffic. Only a subset is consumed today; the full set
 * is retained so ACP code can emit gemini-cli-compatible intents without
 * stubbing field names.
 */
export enum MessageBusType {
  ToolConfirmationRequest = 'tool_confirmation_request',
  ToolConfirmationResponse = 'tool_confirmation_response',
  UpdatePolicy = 'update_policy',
  Broadcast = 'broadcast',
}

/** Base envelope carried on the bus. */
export interface BusMessage<T = unknown> {
  readonly type: MessageBusType;
  readonly payload: T;
}

/**
 * A minimal publish/subscribe bus used by the ACP tool confirmation flow.
 *
 * Wraps Node's {@link EventEmitter} with a tiny typed surface. The rich
 * request/response semantics from gemini-cli's confirmation-bus are not
 * required yet; ACP uses this primarily as a broadcast channel.
 */
export class MessageBus {
  private readonly emitter = new EventEmitter();

  subscribe<T>(
    type: MessageBusType,
    listener: (message: BusMessage<T>) => void,
  ): () => void {
    const wrapped = (msg: BusMessage<T>) => listener(msg);
    this.emitter.on(type, wrapped);
    return () => this.emitter.off(type, wrapped);
  }

  publish<T>(message: BusMessage<T>): void {
    this.emitter.emit(message.type, message);
  }

  /** Remove every registered listener. */
  dispose(): void {
    this.emitter.removeAllListeners();
  }
}
