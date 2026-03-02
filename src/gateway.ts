import type { Message, ReadyData, MessageDelete, MessageDeleteBulk } from './types';
import {
  GATEWAY_URL,
  GATEWAY_VERSION,
  GatewayOpcode,
  GatewayCloseCode,
  DEFAULT_INTENTS,
  INITIAL_RECONNECT_DELAY,
  MAX_RECONNECT_DELAY,
  MAX_RECONNECT_JITTER,
  HEARTBEAT_TIMEOUT,
  IDENTIFY_RATE_LIMIT,
  MAX_IDENTIFIES_PER_WINDOW,
} from './constants';

interface GatewayPayload {
  op: GatewayOpcode;
  d?: unknown;
  s?: number;
  t?: string;
}

interface IdentifyPayload {
  token: string;
  properties: {
    os: string;
    browser: string;
    device: string;
    system_locale?: string;
    has_client_mods?: boolean;
    browser_user_agent?: string;
    browser_version?: string;
    os_version?: string;
    referrer?: string;
    referring_domain?: string;
    referrer_current?: string;
    referring_domain_current?: string;
    release_channel?: string;
    client_build_number?: number;
    client_launch_id?: string;
    is_fast_connect?: boolean;
  };
  intents: number;
  compress?: boolean;
  large_threshold?: number;
  shard?: [number, number];
  presence?: unknown;
}

interface ResumePayload {
  token: string;
  session_id: string;
  seq: number;
}

export type MessageHandler = (message: Message) => void;
export type MessageUpdateHandler = (message: Message) => void;
export type MessageDeleteHandler = (data: MessageDelete) => void;
export type MessageDeleteBulkHandler = (data: MessageDeleteBulk) => void;
export type ReadyHandler = (data: ReadyData) => void;
export type ErrorHandler = (error: Error) => void;
export type DisconnectHandler = (code: number, reason: string) => void;

export class GatewayManager {
  private ws: WebSocket | null = null;
  private token: string;
  private intents: number;
  
  // Connection state
  private connected = false;
  private sessionId: string | null = null;
  private sequenceNumber: number | null = null;
  private resumeGatewayUrl: string | null = null;
  
  // Heartbeat
  private heartbeatInterval: number | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatAck = true;
  private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  // Reconnection
  private reconnectAttempts = 0;
  private reconnectDelay = INITIAL_RECONNECT_DELAY;
  private shouldResume = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  
  // Rate limiting
  private identifyTimestamps: number[] = [];
  
  // Event handlers
  private handlers = {
    message: [] as MessageHandler[],
    messageUpdate: [] as MessageUpdateHandler[],
    messageDelete: [] as MessageDeleteHandler[],
    messageDeleteBulk: [] as MessageDeleteBulkHandler[],
    ready: [] as ReadyHandler[],
    error: [] as ErrorHandler[],
    disconnect: [] as DisconnectHandler[],
  };

  constructor(token: string, intents = DEFAULT_INTENTS) {
    this.token = token;
    this.intents = intents;
  }

  // Event subscription methods
  onMessage(handler: MessageHandler): void {
    this.handlers.message.push(handler);
  }

  onMessageUpdate(handler: MessageUpdateHandler): void {
    this.handlers.messageUpdate.push(handler);
  }

  onMessageDelete(handler: MessageDeleteHandler): void {
    this.handlers.messageDelete.push(handler);
  }

  onMessageDeleteBulk(handler: MessageDeleteBulkHandler): void {
    this.handlers.messageDeleteBulk.push(handler);
  }

  onReady(handler: ReadyHandler): void {
    this.handlers.ready.push(handler);
  }

  onError(handler: ErrorHandler): void {
    this.handlers.error.push(handler);
  }

  onDisconnect(handler: DisconnectHandler): void {
    this.handlers.disconnect.push(handler);
  }

  private connectResolve: (() => void) | null = null;

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.connectResolve = resolve;

        const gatewayUrl = this.shouldResume && this.resumeGatewayUrl
          ? this.resumeGatewayUrl
          : GATEWAY_URL;

        const url = `${gatewayUrl}/?v=${GATEWAY_VERSION}&encoding=json`;

        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
          this.connected = true;
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data as string);
        };

        this.ws.onclose = (event) => {
          this.handleClose(event.code, event.reason);
        };

        this.ws.onerror = (error) => {
          this.handleError(new Error(`WebSocket error: ${error}`));
          reject(error);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  disconnect(): void {
    this.cleanup();
    
    if (this.ws) {
      this.ws.close(1000, 'Client requested disconnect');
      this.ws = null;
    }
  }

  private handleMessage(data: string): void {
    try {
      const payload: GatewayPayload = JSON.parse(data);
      
      if (payload.s !== undefined && payload.s !== null) {
        this.sequenceNumber = payload.s;
      }
      
      switch (payload.op) {
        case GatewayOpcode.DISPATCH:
          this.handleDispatch(payload);
          break;
          
        case GatewayOpcode.HELLO:
          this.handleHello(payload.d as { heartbeat_interval: number });
          break;
          
        case GatewayOpcode.HEARTBEAT_ACK:
          this.handleHeartbeatAck();
          break;
          
        case GatewayOpcode.RECONNECT:
          this.handleReconnectRequest();
          break;
          
        case GatewayOpcode.INVALID_SESSION:
          this.handleInvalidSession(payload.d as boolean);
          break;
          
        default:
          break;
      }
    } catch (error) {
      this.handleError(error as Error);
    }
  }

  private handleDispatch(payload: GatewayPayload): void {
    const { t: eventType, d: eventData } = payload;
    
    if (!eventType) return;
    
    switch (eventType) {
      case 'READY':
        this.handleReady(eventData as ReadyData);
        break;
        
      case 'RESUMED':
        this.handleResumed();
        break;
        
      case 'MESSAGE_CREATE':
        this.handlers.message.forEach(handler => {
          try {
            handler(eventData as Message);
          } catch (error) {
            this.handleError(error as Error);
          }
        });
        break;
        
      case 'MESSAGE_UPDATE':
        this.handlers.messageUpdate.forEach(handler => {
          try {
            handler(eventData as Message);
          } catch (error) {
            this.handleError(error as Error);
          }
        });
        break;
        
      case 'MESSAGE_DELETE':
        this.handlers.messageDelete.forEach(handler => {
          try {
            handler(eventData as MessageDelete);
          } catch (error) {
            this.handleError(error as Error);
          }
        });
        break;
        
      case 'MESSAGE_DELETE_BULK':
        this.handlers.messageDeleteBulk.forEach(handler => {
          try {
            handler(eventData as MessageDeleteBulk);
          } catch (error) {
            this.handleError(error as Error);
          }
        });
        break;
        
      default:
        break;
    }
  }

  private handleReady(data: ReadyData): void {
    this.sessionId = data.session_id;
    this.resumeGatewayUrl = data.resume_gateway_url;
    this.reconnectAttempts = 0;
    this.reconnectDelay = INITIAL_RECONNECT_DELAY;
    this.shouldResume = false;

    if (this.connectResolve) {
      this.connectResolve();
      this.connectResolve = null;
    }

    this.handlers.ready.forEach(handler => {
      try {
        handler(data);
      } catch (error) {
        this.handleError(error as Error);
      }
    });
  }

  private handleResumed(): void {
    this.reconnectAttempts = 0;
    this.reconnectDelay = INITIAL_RECONNECT_DELAY;
    this.shouldResume = false;
  }

  private handleHello(data: { heartbeat_interval: number }): void {
    this.heartbeatInterval = data.heartbeat_interval;
    
    this.startHeartbeat();
    
    if (this.shouldResume && this.sessionId && this.sequenceNumber !== null) {
      this.sendResume();
    } else {
      this.sendIdentify();
    }
  }

  private handleHeartbeatAck(): void {
    this.lastHeartbeatAck = true;
    
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  private handleReconnectRequest(): void {
    this.shouldResume = true;
    this.cleanup();
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    this.scheduleReconnect();
  }

  private handleInvalidSession(resumable: boolean): void {
    if (resumable) {
      this.shouldResume = true;
      this.scheduleReconnect();
    } else {
      this.sessionId = null;
      this.sequenceNumber = null;
      this.shouldResume = false;
      this.scheduleReconnect();
    }
  }

  private handleClose(code: number, reason: string): void {
    this.cleanup();
    this.connected = false;
    
    this.handlers.disconnect.forEach(handler => {
      try {
        handler(code, reason);
      } catch (error) {
        this.handleError(error as Error);
      }
    });
    
    if (this.isReconnectable(code)) {
      this.shouldResume = this.canResume(code);
      this.scheduleReconnect();
    }
  }

  private handleError(error: Error): void {
    this.handlers.error.forEach(handler => {
      try {
        handler(error);
      } catch {
      }
    });
  }

  private startHeartbeat(): void {
    if (!this.heartbeatInterval) return;
    
    this.sendHeartbeat();
    
    this.heartbeatTimer = setInterval(() => {
      if (!this.lastHeartbeatAck) {
        this.handleError(new Error('Heartbeat timeout'));
        this.cleanup();
        
        if (this.ws) {
          this.ws.close();
          this.ws = null;
        }
        
        this.shouldResume = true;
        this.scheduleReconnect();
        return;
      }
      
      this.sendHeartbeat();
    }, this.heartbeatInterval);
  }

  private sendHeartbeat(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    
    this.lastHeartbeatAck = false;
    
    const payload: GatewayPayload = {
      op: GatewayOpcode.HEARTBEAT,
      d: this.sequenceNumber,
    };
    
    this.ws.send(JSON.stringify(payload));
    
    this.heartbeatTimeoutTimer = setTimeout(() => {
      if (!this.lastHeartbeatAck) {
        this.handleError(new Error('Heartbeat ACK timeout'));
      }
    }, HEARTBEAT_TIMEOUT);
  }

  private sendIdentify(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    
    const now = Date.now();
    this.identifyTimestamps = this.identifyTimestamps.filter(
      timestamp => now - timestamp < IDENTIFY_RATE_LIMIT
    );
    
    if (this.identifyTimestamps.length >= MAX_IDENTIFIES_PER_WINDOW) {
      const oldestTimestamp = this.identifyTimestamps[0]!;
      const delay = IDENTIFY_RATE_LIMIT - (now - oldestTimestamp);
      
      setTimeout(() => this.sendIdentify(), Math.max(delay, 1000));
      return;
    }
    
    this.identifyTimestamps.push(now);
    
    const identify: IdentifyPayload = {
      token: this.token,
      properties: {
        os: "Mac OS X",
        browser: "Chrome",
        device: "",
        has_client_mods: false,
        browser_user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      },
      intents: this.intents,
    };
    
    const payload: GatewayPayload = {
      op: GatewayOpcode.IDENTIFY,
      d: identify,
    };
    
    this.ws.send(JSON.stringify(payload));
  }

  private sendResume(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.sessionId || this.sequenceNumber === null) return;
    
    const resume: ResumePayload = {
      token: this.token,
      session_id: this.sessionId,
      seq: this.sequenceNumber,
    };
    
    const payload: GatewayPayload = {
      op: GatewayOpcode.RESUME,
      d: resume,
    };
    
    this.ws.send(JSON.stringify(payload));
  }

  private isReconnectable(code: number): boolean {
    if (code === GatewayCloseCode.AUTHENTICATION_FAILED) return false;
    if (code === GatewayCloseCode.INVALID_SHARD) return false;
    if (code === GatewayCloseCode.SHARDING_REQUIRED) return false;
    if (code === GatewayCloseCode.INVALID_API_VERSION) return false;
    if (code === GatewayCloseCode.INVALID_INTENTS) return false;
    if (code === GatewayCloseCode.DISALLOWED_INTENTS) return false;
    
    return true;
  }

  private canResume(code: number): boolean {
    // Can resume after these codes
    if (code === GatewayCloseCode.UNKNOWN_ERROR) return true;
    if (code === GatewayCloseCode.UNKNOWN_OPCODE) return true;
    if (code === GatewayCloseCode.DECODE_ERROR) return true;
    if (code === GatewayCloseCode.NOT_AUTHENTICATED) return true;
    if (code === GatewayCloseCode.ALREADY_AUTHENTICATED) return true;
    if (code === GatewayCloseCode.INVALID_SEQ) return true;
    if (code === GatewayCloseCode.RATE_LIMITED) return true;
    if (code === GatewayCloseCode.SESSION_TIMED_OUT) return true;
    
    // Normal close codes
    if (code === 1000) return true;
    if (code === 1001) return true;
    if (code === 1006) return true;
    
    return false;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    
    const jitter = 1 + (Math.random() * 2 - 1) * MAX_RECONNECT_JITTER;
    const delay = this.reconnectDelay * jitter;
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      
      this.reconnectDelay = Math.min(
        this.reconnectDelay * 2,
        MAX_RECONNECT_DELAY
      );
      
      this.connect().catch(error => {
        this.handleError(error as Error);
        this.scheduleReconnect();
      });
    }, delay);
  }

  private cleanup(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
    
    this.lastHeartbeatAck = true;
  }

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getSequenceNumber(): number | null {
    return this.sequenceNumber;
  }
}
